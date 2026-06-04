/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * KYS / KYG (Tool D) — backend.
 *
 * - Página PÚBLICA (sem login) preenche o formulário num wizard; endpoints
 *   /api/public/kyc/* auto-preenchem e verificam em tempo real (Receita, CEP, bancos)
 *   e, no submit, rodam a "régua de check" (CEIS/CNEP/CEPIM/Leniência) montando uma
 *   trilha de conformidade auditável.
 * - Assinatura via Documenso (documenso.casahacker.org) por TEMPLATE + formValues
 *   (o Documenso aqui usa armazenamento local; só createDocumentFromTemplate funciona
 *   sem S3). Assinatura embutida no modal via token do signatário.
 * - Painel interno (/api/kyc/*) lista tudo, gera convites rastreáveis e baixa o PDF
 *   assinado. Validade = ano fiscal (renovação anual).
 *
 * Persistência: DATA_DIR/kyc/{id}.json ; convites em DATA_DIR/kyc-invites.json.
 */
import type { Express, RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import path from "path";
import fs from "fs";
import crypto from "node:crypto";
import { fetchReceita, consultaPT, collectSuppliers, runDiligence } from "./diligenciaRoutes";
import type {
  KycRecord, KycInvite, KycSummary, KycType, KysData, KygData, KycVerification, KycVerdict, KycEligibility,
} from "./src/kyc/kycTypes";

export interface KycCtx {
  DATA_DIR: string;
  requireAuth: RequestHandler;
  sanitizeSegment: (s: string) => string | null;
}

// ── helpers ─────────────────────────────────────────────────────────────────────
const onlyDigits = (s: any): string => String(s ?? "").replace(/\D/g, "");
function fmtCnpj(d?: string): string {
  const x = onlyDigits(d);
  if (x.length === 14) return `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}`;
  if (x.length === 11) return `${x.slice(0, 3)}.${x.slice(3, 6)}.${x.slice(6, 9)}-${x.slice(9)}`;
  return d || "";
}
const reqIp = (req: any): string => {
  const xff = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || req.ip || "desconhecido";
};
const HTTP_HEADERS = { Accept: "application/json", "User-Agent": "StackAudit/1.0 (+https://stack-audit.casahacker.org)" };
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const nowIso = () => new Date().toISOString();
const fiscalYear = () => new Date().getFullYear();
const fiscalValidUntil = (y: number) => new Date(y, 11, 31, 23, 59, 59).toISOString();
const isFiscalValid = (r: { validUntil?: string }) => !!r.validUntil && new Date(r.validUntil).getTime() > Date.now();

// dígitos verificadores (espelha src/kyc/kycTypes p/ uso no server, sem import cruzado de browser)
function isValidCpf(value: string): boolean {
  const c = onlyDigits(value);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (len: number) => { let s = 0; for (let i = 0; i < len; i++) s += +c[i] * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return calc(9) === +c[9] && calc(10) === +c[10];
}
function isValidCnpj(value: string): boolean {
  const c = onlyDigits(value);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => { const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < len; i++) s += +c[i] * w[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +c[12] && calc(13) === +c[13];
}

// ── BrasilAPI: CEP + bancos (cache em memória) ──────────────────────────────────
let banksCache: { at: number; data: any[] } | null = null;
async function fetchBanks(): Promise<any[]> {
  if (banksCache && Date.now() - banksCache.at < 24 * 3600_000) return banksCache.data;
  const r = await fetch("https://brasilapi.com.br/api/banks/v1", { headers: HTTP_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Falha ao listar bancos");
  const arr = (await r.json()) as any[];
  const data = (Array.isArray(arr) ? arr : [])
    .filter((b) => b && b.name && b.code != null)
    .map((b) => ({ code: String(b.code).padStart(3, "0"), name: b.name, fullName: b.fullName }))
    .sort((a, b) => a.code.localeCompare(b.code));
  banksCache = { at: Date.now(), data };
  return data;
}
async function fetchCep(cep: string): Promise<any> {
  const d = onlyDigits(cep);
  if (d.length !== 8) throw new Error("CEP inválido");
  const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${d}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("CEP não encontrado");
  const j: any = await r.json();
  return { cep: j.cep, logradouro: j.street || "", bairro: j.neighborhood || "", municipio: j.city || "", uf: j.state || "" };
}

// ── régua de conformidade (Receita + listas de restrição), reusa diligenciaRoutes ─
async function runKycChecks(documento: string): Promise<{ trail: KycVerification[]; verdict: KycVerdict; receita: any; sancoes: any[] }> {
  const cnpj = onlyDigits(documento);
  const trail: KycVerification[] = [];
  // CPF (pessoa física): só checksum — não há base pública gratuita por nome.
  if (cnpj.length === 11) {
    trail.push({ fonte: "Validação local", tipo: "CPF (dígitos verificadores)", resultado: isValidCpf(cnpj) ? "Válido" : "Inválido", status: isValidCpf(cnpj) ? "ok" : "erro", checkedAt: nowIso() });
    return { trail, verdict: isValidCpf(cnpj) ? "NADA_CONSTA" : "ALERTA", receita: null, sancoes: [] };
  }
  if (cnpj.length !== 14) return { trail, verdict: "PENDENTE", receita: null, sancoes: [] };

  const receita = await fetchReceita(cnpj);
  if (receita) {
    const ativa = /ATIVA/i.test(receita.situacao_cadastral || "");
    trail.push({
      fonte: receita.fonte || "Receita Federal", tipo: "Situação cadastral", apiUrl: receita.apiUrl,
      resultado: `${receita.situacao_cadastral || "—"}${receita.data_situacao ? ` (desde ${receita.data_situacao})` : ""}`,
      status: ativa ? "ok" : "alerta", checkedAt: receita.fetchedAt || nowIso(),
    });
  } else {
    trail.push({ fonte: "Receita Federal", tipo: "Situação cadastral", resultado: "Não foi possível consultar", status: "pendente", checkedAt: nowIso() });
  }
  if (receita?.cepFonte) trail.push({ fonte: receita.cepFonte, tipo: "Endereço (CEP)", apiUrl: receita.cepApiUrl, resultado: [receita.logradouro, receita.numero, receita.bairro, receita.municipio, receita.uf].filter(Boolean).join(", ") || "Consultado", status: "ok", checkedAt: receita.cepFetchedAt || nowIso() });

  const razao = receita?.razao_social || "";
  let sancoes: any[] = [];
  if (razao) {
    sancoes = await Promise.all([
      consultaPT("ceis", "CEIS — Inidôneas e Suspensas", razao, cnpj),
      consultaPT("cnep", "CNEP — Empresas Punidas (Lei Anticorrupção)", razao, cnpj),
      consultaPT("cepim", "CEPIM — Entidades sem fins lucrativos impedidas", razao, cnpj),
      consultaPT("acordos-leniencia", "Acordos de Leniência", razao, cnpj),
    ]);
    for (const s of sancoes) {
      trail.push({
        fonte: s.fonte, tipo: "Lista de restrição (Portal da Transparência/CGU)", apiUrl: s.apiUrl,
        resultado: s.status === "CONSTA" ? `CONSTA (${s.hits?.length || 0})` : s.status === "NADA_CONSTA" ? "Nada consta" : s.status,
        status: s.status === "CONSTA" ? "alerta" : s.status === "NADA_CONSTA" ? "ok" : s.status === "ERRO" ? "erro" : "pendente",
        checkedAt: s.fetchedAt || nowIso(), detalhe: s.hits?.length ? s.hits : undefined,
      });
    }
  }
  const anySancao = sancoes.some((s) => s.status === "CONSTA");
  const receitaInativa = receita && !/ATIVA/i.test(receita.situacao_cadastral || "");
  const erro = !receita || sancoes.some((s) => s.status === "ERRO" || s.status === "PENDENTE");
  const verdict: KycVerdict = anySancao || receitaInativa ? "ALERTA" : erro && !razao ? "PENDENTE" : "NADA_CONSTA";
  return { trail, verdict, receita, sancoes };
}

// ── Documenso client (template + formValues; sem S3) ────────────────────────────
const DOCUMENSO_URL = (process.env.DOCUMENSO_URL || "https://documenso.casahacker.org").replace(/\/$/, "");
const DOCUMENSO_TOKEN = process.env.DOCUMENSO_API_TOKEN || "";
const TEMPLATE_ID: Record<KycType, string> = {
  kys: process.env.DOCUMENSO_KYS_TEMPLATE_ID || "",
  kyg: process.env.DOCUMENSO_KYG_TEMPLATE_ID || "",
};
const documensoReady = (t: KycType) => !!(DOCUMENSO_TOKEN && TEMPLATE_ID[t]);

async function dso(method: string, urlPath: string, body?: any): Promise<any> {
  const r = await fetch(`${DOCUMENSO_URL}/api/v1${urlPath}`, {
    method,
    headers: { Authorization: DOCUMENSO_TOKEN, "Content-Type": "application/json", Accept: "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  let json: any = null; try { json = txt ? JSON.parse(txt) : null; } catch { /* */ }
  if (!r.ok) throw new Error(`Documenso ${method} ${urlPath} → ${r.status}: ${json?.message || txt.slice(0, 300)}`);
  return json;
}

/** Cria documento a partir do template com formValues, adiciona CC opcional e envia. */
async function createSignature(rec: KycRecord, signer: { name: string; email: string }, formValues: Record<string, any>): Promise<{ documentId: number; token: string }> {
  const templateId = TEMPLATE_ID[rec.type];
  const title = `${rec.type.toUpperCase()} — ${signer.name} (${rec.fiscalYear})`;
  // create-document: recipients mapeados por ÍNDICE aos placeholders do template
  // (shape {name,email}, sem precisar do id do recipient) + formValues nos campos
  // AcroForm do PDF. (generate-document exigiria o id do recipient do template.)
  const gen = await dso("POST", `/templates/${templateId}/create-document`, {
    title,
    externalId: rec.id,
    recipients: [{ name: signer.name, email: signer.email }],
    meta: { subject: `Conformidade ${rec.type.toUpperCase()} — Casa Hacker`, message: "Documento de conformidade para assinatura eletrônica." },
    formValues,
  });
  const documentId: number = gen.documentId;
  const token: string = gen.recipients?.[0]?.token;
  if (!documentId || !token) throw new Error("Documenso não retornou documentId/token");
  // CC: solicitante Casa Hacker recebe cópia do documento concluído
  if (rec.requester?.email && isEmail(rec.requester.email)) {
    try { await dso("POST", `/documents/${documentId}/recipients`, { name: rec.requester.nome || rec.requester.email, email: rec.requester.email, role: "CC" }); }
    catch (e: any) { console.warn("[KYC] falha ao adicionar CC:", e.message); }
  }
  // envia (sai do estado rascunho → permite assinatura; e-mail ao CC/cópia final)
  try { await dso("POST", `/documents/${documentId}/send`, { sendEmail: true }); }
  catch (e: any) { console.warn("[KYC] falha no send (pode já ter sido enviado):", e.message); }
  return { documentId, token };
}

async function getDocumentStatus(documentId: number): Promise<any> {
  return dso("GET", `/documents/${documentId}`);
}
async function downloadSigned(documentId: number): Promise<Buffer | null> {
  // v1: GET /documents/{id}/download → { downloadUrl } (link assinado do PDF concluído)
  try {
    const dl = await dso("GET", `/documents/${documentId}/download`);
    const url = dl?.downloadUrl;
    if (!url || !/^https?:/.test(url)) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// ── formValues: achata o registro nos campos AcroForm do template ───────────────
function addr(a: any): string {
  if (!a) return "";
  return [[a.logradouro, a.numero].filter(Boolean).join(", "), a.complemento, a.bairro, [a.municipio, a.uf].filter(Boolean).join("/"), a.cep ? `CEP ${a.cep}` : ""].filter(Boolean).join(" · ");
}
function buildFormValues(rec: KycRecord): Record<string, any> {
  if (rec.type === "kys" && rec.kys) {
    const k = rec.kys;
    const fv: Record<string, any> = {
      razao_social: k.razaoSocial, cnpj: fmtCnpj(k.cnpj), nome_fantasia: k.nomeFantasia,
      empresa_endereco: addr(k.endereco), empresa_telefone: k.telefone, empresa_email: k.email,
      banco: k.banco.banco, agencia: k.banco.agencia, conta: k.banco.conta, chave_pix: k.banco.chavePix,
      rep_nome: k.repNome, rep_cpf: k.repCpf, rep_estado_civil: k.repEstadoCivil, rep_profissao: k.repProfissao,
      rep_endereco: addr(k.repEndereco), rep_telefone: k.repTelefone, rep_email: k.repEmail,
      observacoes: k.observacoes,
    };
    for (const [key, ans] of Object.entries(k.respostas || {})) {
      fv[`${key}_resposta`] = ans.resposta === "sim" ? "SIM" : ans.resposta === "nao" ? "NÃO" : "";
      if (ans.obs) fv[`${key}_obs`] = ans.obs;
    }
    return fv;
  }
  if (rec.type === "kyg" && rec.kyg) {
    const g = rec.kyg;
    return {
      proponente_nome: g.nome, proponente_documento: g.documento.length === 14 ? fmtCnpj(g.documento) : fmtCnpj(g.documento),
      projeto: g.projeto, proponente_endereco: addr(g.endereco), proponente_email: g.email, proponente_telefone: g.telefone,
      banco: g.banco.banco, agencia: g.banco.agencia, conta: g.banco.conta, chave_pix: g.banco.chavePix,
      observacoes: g.observacoes,
    };
  }
  return {};
}

// ── elegibilidade: sem restrições + respostas adequadas + previdência cumprida ──
// (manter em sincronia com as chaves de KYS_SECTIONS em src/kyc/kycTypes.ts)
const KYS_ELIGIBLE: Record<string, "sim" | "nao" | "neutral"> = {
  pep: "nao", familiar_governo: "nao", parentesco_casahacker: "nao", acao_judicial: "nao", conflito_interesse: "nao",
  candidato_politico: "nao", partido_politico: "nao",
  condenacao_corrupcao: "nao", investigacao_anticorrupcao: "nao", bloqueio_confisco: "nao",
  escravidao: "nao", injuria_racial: "nao", crimes_genero: "nao", trabalho_infantil: "nao",
  sancoes: "nao", historico_contratual: "neutral", impostos_previdencia: "sim",
};
const KYS_SHORT: Record<string, string> = {
  pep: "Pessoa Exposta Politicamente", familiar_governo: "Familiar em ente de governo", parentesco_casahacker: "Parentesco com a Casa Hacker",
  acao_judicial: "Ação judicial contra a Casa Hacker", conflito_interesse: "Conflito de interesse",
  candidato_politico: "Candidatura a cargo político", partido_politico: "Vínculo com partido político",
  condenacao_corrupcao: "Condenação por corrupção/lavagem", investigacao_anticorrupcao: "Investigação anticorrupção", bloqueio_confisco: "Bloqueio/confisco/perda de direito",
  escravidao: "Trabalho escravo", injuria_racial: "Injúria racial", crimes_genero: "Crimes de gênero", trabalho_infantil: "Trabalho infantil",
  sancoes: "Sanções/blocklists", impostos_previdencia: "Impostos/Previdência",
};
function computeEligibility(rec: KycRecord): KycEligibility {
  const motivos: string[] = [];
  if (rec.verdict === "ALERTA") motivos.push("Restrição encontrada (lista de sanções e/ou cadastro não-ativo na Receita).");
  else if (rec.verdict === "PENDENTE") motivos.push("Verificação de conformidade incompleta — reprocessar.");
  if (rec.type === "kys" && rec.kys) {
    for (const [key, exp] of Object.entries(KYS_ELIGIBLE)) {
      if (exp === "neutral") continue;
      const a = rec.kys.respostas?.[key]?.resposta;
      if (!a) { motivos.push(`Não respondido: ${KYS_SHORT[key] || key}.`); continue; }
      if (a !== exp) motivos.push(key === "impostos_previdencia" ? "Não cumpriu as obrigações de impostos/previdência." : `Resposta de risco: ${KYS_SHORT[key] || key}.`);
    }
  }
  return { elegivel: motivos.length === 0, motivos };
}

// ── extração de identidade do registro (p/ listagem e signatário) ───────────────
function recDoc(rec: KycRecord): string { return onlyDigits(rec.type === "kys" ? rec.kys?.cnpj : rec.kyg?.documento); }
function recNome(rec: KycRecord): string { return (rec.type === "kys" ? rec.kys?.razaoSocial : rec.kyg?.nome) || ""; }
function recSigner(rec: KycRecord): { name: string; email: string } {
  if (rec.type === "kys" && rec.kys) return { name: rec.kys.repNome, email: rec.kys.repEmail };
  if (rec.type === "kyg" && rec.kyg) return { name: rec.kyg.nome, email: rec.kyg.email };
  return { name: "", email: "" };
}
function toSummary(rec: KycRecord): KycSummary {
  const doc = recDoc(rec);
  return {
    id: rec.id, type: rec.type, status: rec.status, nome: recNome(rec) || "—",
    documento: doc, documentoFmt: fmtCnpj(doc), requester: rec.requester, verdict: rec.verdict, elegivel: rec.elegibilidade?.elegivel,
    fiscalYear: rec.fiscalYear, validUntil: rec.validUntil, valida: rec.status === "assinado" && isFiscalValid(rec),
    createdAt: rec.createdAt, signedAt: rec.signedAt,
  };
}

// ── route registration ──────────────────────────────────────────────────────────
export function registerKycRoutes(app: Express, ctx: KycCtx) {
  const { DATA_DIR, requireAuth, sanitizeSegment } = ctx;
  const KYC_DIR = path.join(DATA_DIR, "kyc");
  const INVITES_FILE = path.join(DATA_DIR, "kyc-invites.json");
  fs.mkdirSync(KYC_DIR, { recursive: true });

  const recPath = (id: string) => path.join(KYC_DIR, `${id}.json`);
  const readRec = (id: string): KycRecord | null => { try { return JSON.parse(fs.readFileSync(recPath(id), "utf-8")); } catch { return null; } };
  const writeRec = (rec: KycRecord) => fs.writeFileSync(recPath(rec.id), JSON.stringify(rec, null, 2));
  const listRecs = (): KycRecord[] => (fs.existsSync(KYC_DIR) ? fs.readdirSync(KYC_DIR) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(KYC_DIR, f), "utf-8")) as KycRecord; } catch { return null; } })
    .filter((r): r is KycRecord => !!r);
  const readInvites = (): KycInvite[] => { try { const a = JSON.parse(fs.readFileSync(INVITES_FILE, "utf-8")); return Array.isArray(a) ? a : []; } catch { return []; } };
  const writeInvites = (a: KycInvite[]) => fs.writeFileSync(INVITES_FILE, JSON.stringify(a, null, 2));

  // rate limit dos endpoints públicos (por IP)
  const publicLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: "Muitas requisições. Aguarde 1 minuto." } });
  const submitLimiter = rateLimit({ windowMs: 60 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Muitos envios. Tente novamente mais tarde." } });

  const idParam = (req: any, res: any): string | null => {
    const id = sanitizeSegment(String(req.params.id || ""));
    if (!id) { res.status(400).json({ error: "ID inválido" }); return null; }
    return id;
  };

  // ─────────────── PÚBLICO (sem auth) ───────────────
  app.get("/api/public/kyc/banks", publicLimiter, async (_req, res) => {
    try { res.json(await fetchBanks()); } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  app.get("/api/public/kyc/cep/:cep", publicLimiter, async (req, res) => {
    try { res.json(await fetchCep(String(req.params.cep))); } catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  app.get("/api/public/kyc/cnpj/:cnpj", publicLimiter, async (req, res) => {
    const cnpj = onlyDigits(req.params.cnpj);
    if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ deve ter 14 dígitos" });
    if (!isValidCnpj(cnpj)) return res.status(422).json({ error: "CNPJ inválido (dígitos verificadores)" });
    try {
      const r = await fetchReceita(cnpj);
      if (!r) return res.status(404).json({ error: "CNPJ não encontrado na Receita" });
      res.json(r);
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // validação leve de CPF/CNPJ (checksum) — feedback em tempo real no wizard
  app.get("/api/public/kyc/validate-doc/:doc", publicLimiter, (req, res) => {
    const d = onlyDigits(req.params.doc);
    if (d.length === 11) return res.json({ tipo: "cpf", valido: isValidCpf(d) });
    if (d.length === 14) return res.json({ tipo: "cnpj", valido: isValidCnpj(d) });
    res.json({ tipo: "desconhecido", valido: false });
  });

  // prefill de um convite rastreável
  app.get("/api/public/kyc/invite/:token", publicLimiter, (req, res) => {
    const token = sanitizeSegment(String(req.params.token || ""));
    if (!token) return res.status(400).json({ error: "Token inválido" });
    const inv = readInvites().find((i) => i.token === token);
    if (!inv) return res.status(404).json({ error: "Convite não encontrado" });
    if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) return res.status(410).json({ error: "Convite expirado" });
    res.json({ type: inv.type, cnpj: inv.cnpj || "", requester: inv.requester || null });
  });

  // submit do formulário → régua de check + persistência + criação no Documenso
  app.post("/api/public/kyc/submit", submitLimiter, async (req: any, res) => {
    const body = req.body || {};
    const type: KycType = body.type === "kyg" ? "kyg" : "kys";
    if (!body.atestacao) return res.status(400).json({ error: "É obrigatório confirmar que você é o representante legal/autorizado." });

    // validação por tipo
    let documento = "", signer = { name: "", email: "" };
    if (type === "kys") {
      const k = body.kys as KysData;
      if (!k || !isValidCnpj(k.cnpj)) return res.status(400).json({ error: "CNPJ da empresa inválido." });
      if (!k.razaoSocial?.trim()) return res.status(400).json({ error: "Razão social obrigatória." });
      if (!k.repNome?.trim() || !isValidCpf(k.repCpf)) return res.status(400).json({ error: "Representante legal: nome e CPF válido obrigatórios." });
      if (!isEmail(k.repEmail)) return res.status(400).json({ error: "E-mail do representante legal inválido." });
      documento = onlyDigits(k.cnpj); signer = { name: k.repNome, email: k.repEmail };
    } else {
      const g = body.kyg as KygData;
      const docDigits = onlyDigits(g?.documento);
      const docOk = g?.tipoPessoa === "pf" ? isValidCpf(docDigits) : isValidCnpj(docDigits);
      if (!g || !docOk) return res.status(400).json({ error: "Documento (CPF/CNPJ) do proponente inválido." });
      if (!g.nome?.trim() || !g.projeto?.trim()) return res.status(400).json({ error: "Nome do proponente e do projeto são obrigatórios." });
      if (!isEmail(g.email)) return res.status(400).json({ error: "E-mail do proponente inválido." });
      if (!Array.isArray(g.declaracoes) || g.declaracoes.length < 8 || g.declaracoes.some((d) => !d)) return res.status(400).json({ error: "É necessário aceitar todas as declarações." });
      documento = docDigits; signer = { name: g.nome, email: g.email };
    }
    if (!body.aceiteAssinatura) return res.status(400).json({ error: "É necessário aceitar o processo de assinatura eletrônica." });

    const requester = body.requester && (body.requester.nome || body.requester.email)
      ? { nome: String(body.requester.nome || "").trim(), email: String(body.requester.email || "").trim() } : undefined;
    if (requester?.email && !isEmail(requester.email)) return res.status(400).json({ error: "E-mail do solicitante Casa Hacker inválido." });

    // régua de conformidade (Receita + listas)
    let checks;
    try { checks = await runKycChecks(documento); }
    catch (e: any) { checks = { trail: [{ fonte: "Sistema", tipo: "Régua de check", resultado: e.message, status: "erro" as const, checkedAt: nowIso() }], verdict: "PENDENTE" as KycVerdict, receita: null, sancoes: [] }; }

    const y = fiscalYear();
    const rec: KycRecord = {
      id: crypto.randomUUID(),
      type, status: "aguardando_assinatura",
      kys: type === "kys" ? body.kys : undefined,
      kyg: type === "kyg" ? body.kyg : undefined,
      requester,
      verificationTrail: checks.trail, verdict: checks.verdict,
      inviteToken: body.inviteToken ? String(body.inviteToken) : undefined,
      fiscalYear: y, validUntil: fiscalValidUntil(y),
      createdAt: nowIso(), ip: reqIp(req), userAgent: String(req.headers["user-agent"] || ""),
    };

    // guarda os dados crus da régua p/ relatório interno
    (rec as any).receitaSnapshot = checks.receita; (rec as any).sancoesSnapshot = checks.sancoes;
    rec.elegibilidade = computeEligibility(rec);

    // assinatura via Documenso (se configurado)
    if (documensoReady(type)) {
      try {
        const { documentId, token } = await createSignature(rec, signer, buildFormValues(rec));
        rec.documensoDocumentId = documentId; rec.documensoToken = token;
      } catch (e: any) {
        console.error("[KYC] Documenso falhou:", e.message);
        writeRec(rec);
        return res.status(502).json({ error: "Falha ao preparar a assinatura no Documenso: " + e.message, id: rec.id });
      }
    }
    writeRec(rec);

    // marca convite como usado
    if (rec.inviteToken) { const inv = readInvites(); const i = inv.find((x) => x.token === rec.inviteToken); if (i) { i.usedByRecordId = rec.id; writeInvites(inv); } }

    res.json({
      id: rec.id, verdict: rec.verdict,
      documenso: rec.documensoToken ? { token: rec.documensoToken, host: DOCUMENSO_URL } : null,
      needsDocumensoSetup: !documensoReady(type),
    });
  });

  // o embed sinaliza conclusão → marca assinado
  app.post("/api/public/kyc/:id/completed", publicLimiter, async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const rec = readRec(id); if (!rec) return res.status(404).json({ error: "Registro não encontrado" });
    const token = String(req.body?.token || "");
    if (rec.documensoToken && token && token !== rec.documensoToken) return res.status(403).json({ error: "Token inválido" });
    if (rec.status === "assinado") return res.json({ ok: true, status: rec.status });
    // Confirma com o Documenso quando configurado; sem ele (dev), aceita o sinal do embed.
    let completed = !rec.documensoDocumentId;
    if (rec.documensoDocumentId) {
      try { const doc = await getDocumentStatus(rec.documensoDocumentId); completed = doc?.status === "COMPLETED"; } catch { completed = false; }
    }
    if (completed) { rec.status = "assinado"; rec.signedAt = nowIso(); delete rec.documensoToken; writeRec(rec); }
    res.json({ ok: true, status: rec.status });
  });

  // ─────────────── AUTENTICADO (painel) ───────────────
  app.get("/api/kyc", requireAuth, (_req, res) => {
    const out = listRecs().map(toSummary).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(out);
  });

  // cockpit unificado: 1 linha por fornecedor (doc) com Diligência + KYS/KYG juntos
  app.get("/api/fornecedores", requireAuth, (_req, res) => {
    const DIL_DIR = path.join(DATA_DIR, "diligencia");
    const readDil = (cnpj: string): any => { try { return JSON.parse(fs.readFileSync(path.join(DIL_DIR, `${cnpj}.json`), "utf-8")); } catch { return null; } };
    const dilValid = (r: any) => !!(r && r.validUntil && new Date(r.validUntil).getTime() > Date.now());
    const dilSummary = (r: any) => r ? { verdict: r.verdict, valida: dilValid(r), checkedAt: r.checkedAt } : null;
    // importados entram sem nome; a razão social vem do registro de diligência (Receita)
    const dilNome = (r: any) => (r?.razaoSocial && r.razaoSocial !== "—" ? r.razaoSocial : "");
    // KYS/KYG mais recente por documento
    const kycByDoc = new Map<string, KycRecord>();
    for (const rec of listRecs()) {
      const d = recDoc(rec); if (!d) continue;
      const cur = kycByDoc.get(d);
      if (!cur || String(rec.createdAt) > String(cur.createdAt)) kycByDoc.set(d, rec);
    }
    const rows = new Map<string, any>();
    for (const s of collectSuppliers(DATA_DIR)) {
      const dr = readDil(s.cnpj);
      rows.set(s.cnpj, { doc: s.cnpj, docFmt: fmtCnpj(s.cnpj), nome: s.nome || dilNome(dr), origens: s.origens || [], diligencia: dilSummary(dr), kyc: null });
    }
    for (const [d, rec] of kycByDoc) {
      let row = rows.get(d);
      if (!row) { const dr = readDil(d); row = { doc: d, docFmt: fmtCnpj(d), nome: recNome(rec) || dilNome(dr), origens: ["KYS/KYG"], diligencia: dilSummary(dr), kyc: null }; rows.set(d, row); }
      else if (!row.origens.includes("KYS/KYG")) row.origens = [...row.origens, "KYS/KYG"];
      if (!row.nome) row.nome = recNome(rec);
      row.kyc = { id: rec.id, type: rec.type, status: rec.status, elegivel: rec.elegibilidade?.elegivel, fiscalYear: rec.fiscalYear, valida: rec.status === "assinado" && isFiscalValid(rec), signedAt: rec.signedAt };
    }
    res.json([...rows.values()].sort((a, b) => (a.nome || "").localeCompare(b.nome || "")));
  });

  // ── perfil consolidado, persistente e editável (cadastrais + diligência + KYS/KYG) ──
  const FORN_DIR = path.join(DATA_DIR, "fornecedores");
  fs.mkdirSync(FORN_DIR, { recursive: true });
  const CADASTRO_FIELDS = ["razaoSocial", "nomeFantasia", "tipo", "situacaoCadastral", "dataSituacao", "motivoSituacao", "naturezaJuridica", "porte", "abertura", "capitalSocial", "cnaePrincipal", "cnaesSecundarios", "cep", "logradouro", "numero", "complemento", "bairro", "municipio", "uf", "telefone", "email", "banco", "agencia", "conta", "chavePix", "observacoes"];
  const cadPath = (doc: string) => path.join(FORN_DIR, `${doc}.json`);
  const readCad = (doc: string): any => { try { return JSON.parse(fs.readFileSync(cadPath(doc), "utf-8")); } catch { return null; } };
  const writeCad = (doc: string, rec: any) => fs.writeFileSync(cadPath(doc), JSON.stringify(rec, null, 2));
  const readDilRec = (doc: string): any => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "diligencia", `${doc}.json`), "utf-8")); } catch { return null; } };
  const latestKyc = (doc: string): KycRecord | null => { let best: KycRecord | null = null; for (const rec of listRecs()) { if (recDoc(rec) !== doc) continue; if (!best || String(rec.createdAt) > String(best.createdAt)) best = rec; } return best; };
  // campos derivados das APIs (Receita+CEP) e do KYS/KYG mais recente
  const apiFields = (doc: string): { fields: Record<string, string>; fontes: any; qsa: any[]; dil: any; kyc: KycRecord | null } => {
    const dil = readDilRec(doc); const r = dil?.receita || {};
    const kyc = latestKyc(doc); const kd: any = kyc?.kys || kyc?.kyg || {}; const kEnd = kd.endereco || {}; const kB = kd.banco || {};
    const fields: Record<string, string> = {
      razaoSocial: r.razao_social || kyc?.kys?.razaoSocial || kyc?.kyg?.nome || "",
      nomeFantasia: r.nome_fantasia || kd.nomeFantasia || "", tipo: r.tipo || "",
      situacaoCadastral: r.situacao_cadastral || "", dataSituacao: r.data_situacao || "", motivoSituacao: r.motivo_situacao || "",
      naturezaJuridica: r.natureza_juridica || "", porte: r.porte || "", abertura: r.abertura || "", capitalSocial: r.capital_social || "", cnaePrincipal: r.cnae_principal || "",
      cnaesSecundarios: Array.isArray(r.cnaes_secundarios) ? r.cnaes_secundarios.join("\n") : "",
      cep: r.cep || kEnd.cep || "", logradouro: r.logradouro || kEnd.logradouro || "", numero: r.numero || kEnd.numero || "", complemento: r.complemento || kEnd.complemento || "",
      bairro: r.bairro || kEnd.bairro || "", municipio: r.municipio || kEnd.municipio || "", uf: r.uf || kEnd.uf || "",
      telefone: r.telefone || kd.telefone || "", email: r.email || kd.email || "",
      banco: kB.banco || "", agencia: kB.agencia || "", conta: kB.conta || "", chavePix: kB.chavePix || "", observacoes: kd.observacoes || "",
    };
    const fontes = { receita: r.fonte ? { fonte: r.fonte, apiUrl: r.apiUrl, fetchedAt: r.fetchedAt } : null, cep: r.cepFonte ? { fonte: r.cepFonte, apiUrl: r.cepApiUrl, fetchedAt: r.cepFetchedAt } : null };
    return { fields, fontes, qsa: r.qsa || [], dil, kyc };
  };
  const consolidate = (doc: string) => {
    const { fields: api, fontes, qsa, dil, kyc } = apiFields(doc);
    const had = readCad(doc);
    const stored = had || { doc, tipo: doc.length === 14 ? "pj" : "pf", fields: {}, manual: {}, updatedAt: null, updatedBy: null };
    const merged: Record<string, string> = {};
    for (const k of CADASTRO_FIELDS) merged[k] = stored.manual?.[k] ? (stored.fields?.[k] ?? "") : (api[k] || stored.fields?.[k] || "");
    if (!had) writeCad(doc, { ...stored, fields: merged, fontes, updatedAt: new Date().toISOString() }); // semeia na 1ª abertura
    return { cadastro: merged, manual: stored.manual || {}, fontes, qsa, dil, kyc };
  };
  const profileResponse = (doc: string) => {
    const { cadastro, manual, fontes, qsa, dil, kyc } = consolidate(doc);
    const { documensoToken: _t, ...kycSafe } = (kyc || {}) as any;
    return { doc, docFmt: fmtCnpj(doc), tipo: doc.length === 14 ? "pj" : "pf", cadastro, manual, fontes, qsa, diligencia: dil, kyc: kyc ? { ...kycSafe, valida: kyc.status === "assinado" && isFiscalValid(kyc) } : null };
  };
  const docParam = (req: any, res: any): string | null => {
    const d = onlyDigits(sanitizeSegment(String(req.params.doc || "")) || "");
    if (d.length !== 14 && d.length !== 11) { res.status(400).json({ error: "Documento inválido (CNPJ ou CPF)" }); return null; }
    return d;
  };

  app.get("/api/fornecedores/:doc", requireAuth, (req: any, res) => {
    const doc = docParam(req, res); if (!doc) return;
    res.json(profileResponse(doc));
  });

  // puxa de TODAS as APIs (Receita+CEP + listas de restrição) e atualiza os campos não-manuais
  app.post("/api/fornecedores/:doc/refresh", requireAuth, async (req: any, res) => {
    const doc = docParam(req, res); if (!doc) return;
    if (doc.length === 14) { try { await runDiligence(DATA_DIR, doc, { checkedBy: req.user?.email || "—", ip: reqIp(req), force: true }); } catch (e: any) { console.warn("[Fornecedor] refresh diligência:", e?.message); } }
    const { fields: api, fontes } = apiFields(doc);
    const stored = readCad(doc) || { doc, tipo: doc.length === 14 ? "pj" : "pf", fields: {}, manual: {} };
    const fields: Record<string, string> = { ...stored.fields };
    for (const k of CADASTRO_FIELDS) if (!stored.manual?.[k]) fields[k] = api[k] || fields[k] || "";
    writeCad(doc, { ...stored, doc, tipo: doc.length === 14 ? "pj" : "pf", fields, fontes, updatedAt: new Date().toISOString(), updatedBy: req.user?.email });
    res.json(profileResponse(doc));
  });

  // edição manual dos dados cadastrais (marca os campos como manuais → não são sobrescritos no refresh)
  app.patch("/api/fornecedores/:doc", requireAuth, (req: any, res) => {
    const doc = docParam(req, res); if (!doc) return;
    const patch = (req.body && req.body.fields) || {};
    consolidate(doc); // garante semeadura
    const stored = readCad(doc) || { doc, tipo: doc.length === 14 ? "pj" : "pf", fields: {}, manual: {} };
    stored.fields = { ...stored.fields }; stored.manual = { ...stored.manual };
    for (const k of CADASTRO_FIELDS) if (k in patch) { stored.fields[k] = String(patch[k] ?? ""); stored.manual[k] = true; }
    stored.updatedAt = new Date().toISOString(); stored.updatedBy = req.user?.email;
    writeCad(doc, stored);
    res.json(profileResponse(doc));
  });

  app.get("/api/kyc/invites", requireAuth, (_req, res) => {
    res.json(readInvites().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  });

  app.post("/api/kyc/invite", requireAuth, (req: any, res) => {
    const type: KycType = req.body?.type === "kyg" ? "kyg" : "kys";
    const cnpj = onlyDigits(req.body?.cnpj);
    const inv: KycInvite = {
      token: crypto.randomBytes(12).toString("base64url"),
      type, cnpj: cnpj.length === 14 ? cnpj : undefined,
      requester: { nome: req.user?.name || "", email: req.user?.email || "" },
      createdBy: req.user?.email || "—", createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
    };
    const all = readInvites(); all.push(inv); writeInvites(all);
    const base = (process.env.APP_URL || "https://stack-audit.casahacker.org").replace(/\/$/, "");
    res.json({ ...inv, url: `${base}/${type}/${inv.token}` });
  });

  app.get("/api/kyc/:id", requireAuth, (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const rec = readRec(id); if (!rec) return res.status(404).json({ error: "Registro não encontrado" });
    const { documensoToken: _t, ...safe } = rec;
    res.json({ ...safe, valida: rec.status === "assinado" && isFiscalValid(rec) });
  });

  // baixa o PDF assinado do Documenso
  app.get("/api/kyc/:id/signed.pdf", requireAuth, async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const rec = readRec(id); if (!rec) return res.status(404).json({ error: "Registro não encontrado" });
    if (!rec.documensoDocumentId) return res.status(404).json({ error: "Documento ainda não criado no Documenso" });
    const buf = await downloadSigned(rec.documensoDocumentId);
    if (!buf) return res.status(502).json({ error: "Não foi possível obter o PDF assinado do Documenso" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${rec.type}_${recDoc(rec)}_${rec.fiscalYear}.pdf"`);
    res.send(buf);
  });

  // status da assinatura (poll do painel)
  app.get("/api/kyc/:id/signature-status", requireAuth, async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const rec = readRec(id); if (!rec) return res.status(404).json({ error: "Registro não encontrado" });
    if (rec.status === "assinado" || !rec.documensoDocumentId) return res.json({ status: rec.status });
    try {
      const doc = await getDocumentStatus(rec.documensoDocumentId);
      if (doc?.status === "COMPLETED") { rec.status = "assinado"; rec.signedAt = nowIso(); delete rec.documensoToken; writeRec(rec); }
      res.json({ status: rec.status, documensoStatus: doc?.status });
    } catch (e: any) { res.json({ status: rec.status, error: e.message }); }
  });

  console.log(`[KYC] routes registered (/api/kyc, /api/public/kyc) — Documenso KYS:${documensoReady("kys") ? "on" : "off"} KYG:${documensoReady("kyg") ? "on" : "off"}`);
}
