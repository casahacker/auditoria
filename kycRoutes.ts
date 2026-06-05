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
import { fetchReceita, consultaPT, consultaPEP, collectSuppliers, runDiligence, lookupCep, legalNotesHtml, provenanceTableHtml } from "./diligenciaRoutes";
import { generateKycPdf } from "./kycPdf";
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
// fallback estático (principais instituições) caso a API de bancos falhe
const BANKS_FALLBACK = [
  { code: "001", name: "Banco do Brasil" }, { code: "104", name: "Caixa Econômica Federal" }, { code: "237", name: "Bradesco" },
  { code: "341", name: "Itaú Unibanco" }, { code: "033", name: "Santander" }, { code: "260", name: "Nu Pagamentos (Nubank)" },
  { code: "077", name: "Banco Inter" }, { code: "336", name: "Banco C6" }, { code: "212", name: "Banco Original" },
  { code: "748", name: "Sicredi" }, { code: "756", name: "Sicoob" }, { code: "422", name: "Banco Safra" }, { code: "070", name: "BRB" },
  { code: "041", name: "Banrisul" }, { code: "208", name: "BTG Pactual" }, { code: "623", name: "Banco Pan" }, { code: "290", name: "PagBank (PagSeguro)" },
];
async function fetchBanks(): Promise<any[]> {
  if (banksCache && Date.now() - banksCache.at < 24 * 3600_000) return banksCache.data;
  try {
    const r = await fetch("https://brasilapi.com.br/api/banks/v1", { headers: HTTP_HEADERS, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const arr = (await r.json()) as any[];
      const data = (Array.isArray(arr) ? arr : []).filter((b) => b && b.name && b.code != null)
        .map((b) => ({ code: String(b.code).padStart(3, "0"), name: b.name, fullName: b.fullName })).sort((a, b) => a.code.localeCompare(b.code));
      if (data.length) { banksCache = { at: Date.now(), data }; return data; }
    }
  } catch { /* fallback abaixo */ }
  return BANKS_FALLBACK;
}
// CEP com cadeia de fallback (BrasilAPI v2 → ViaCEP → BrasilAPI v1 → OpenCEP)
async function fetchCep(cep: string): Promise<any> {
  const c = await lookupCep(cep);
  if (!c) throw new Error("CEP não encontrado");
  return { cep: c.cep, logradouro: c.logradouro, bairro: c.bairro, municipio: c.municipio, uf: c.uf, fonte: c.fonte };
}

// ── régua de conformidade (Receita + listas de restrição), reusa diligenciaRoutes ─
async function runKycChecks(documento: string, repLegal?: { nome?: string; cpf?: string }): Promise<{ trail: KycVerification[]; verdict: KycVerdict; receita: any; sancoes: any[] }> {
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
    // PEP — representante legal informado (nome + CPF) + sócios do QSA (#88).
    const qsaNomes: string[] = (receita?.qsa || []).map((s: any) => s?.nome).filter(Boolean);
    const pepNomes = [...qsaNomes, ...(repLegal?.nome ? [repLegal.nome] : [])];
    const pepCpfs = repLegal?.cpf ? [repLegal.cpf] : [];
    if (pepNomes.length || pepCpfs.length) {
      const pep = await consultaPEP(pepNomes, pepCpfs);
      sancoes.push(pep);
      trail.push({
        fonte: pep.fonte, tipo: "PEP — Pessoas Expostas Politicamente (rep. legal + QSA)", apiUrl: pep.apiUrl,
        resultado: pep.status === "ATENCAO" ? `Atenção (${pep.hits?.length || 0})` : pep.status === "NADA_CONSTA" ? "Nada consta" : pep.status,
        status: pep.status === "ATENCAO" ? "alerta" : pep.status === "NADA_CONSTA" ? "ok" : pep.status === "ERRO" ? "erro" : "pendente",
        checkedAt: pep.fetchedAt || nowIso(), detalhe: pep.hits?.length ? pep.hits : undefined,
      });
    }
  }
  // PEP é informativo (ATENCAO) → não reprova; o veredito segue apenas as listas que CONSTAM.
  const anySancao = sancoes.some((s) => s.status === "CONSTA");
  const receitaInativa = receita && !/ATIVA/i.test(receita.situacao_cadastral || "");
  const erro = !receita || sancoes.some((s) => s.status === "ERRO" || s.status === "PENDENTE");
  const verdict: KycVerdict = anySancao || receitaInativa ? "ALERTA" : erro && !razao ? "PENDENTE" : "NADA_CONSTA";
  return { trail, verdict, receita, sancoes };
}

// ── Documenso client (createDocument via S3 — PDF pré-preenchido) ────────────────
const DOCUMENSO_URL = (process.env.DOCUMENSO_URL || "https://documenso.casahacker.org").replace(/\/$/, "");
const DOCUMENSO_TOKEN = process.env.DOCUMENSO_API_TOKEN || "";
// Com S3 ligado no Documenso, criamos o documento por API (PDF pré-preenchido) — sem template.
// Basta o token; vale para KYS e KYG (KYG deixa de depender de um template criado na UI).
const documensoReady = (_t: KycType) => !!DOCUMENSO_TOKEN;

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

/**
 * Gera o termo JÁ PRÉ-PREENCHIDO (kycPdf), sobe ao Documenso via API (S3) e devolve o token do
 * SIGNATÁRIO p/ o modal embutido. O fornecedor apenas ASSINA — não redigita nada.
 *
 * Fluxo (requer S3 ligado no Documenso — ver reference_aistor_s3):
 *   1. generateKycPdf(rec) → PDF preenchido + posição do campo de assinatura;
 *   2. POST /documents (createDocument) → uploadUrl presigned + documentId + recipients
 *      [0]=CC (solicitante Casa Hacker), [1]=SIGNER (fornecedor);
 *   3. PUT do PDF na presigned URL (S3);
 *   4. POST /documents/{id}/fields → campo SIGNATURE no SIGNER, na posição reservada;
 *   5. POST /documents/{id}/send → habilita a assinatura (cópia ao CC).
 */
async function createSignature(rec: KycRecord, signer: { name: string; email: string }): Promise<{ documentId: number; token: string }> {
  // Título do documento = RAZÃO SOCIAL (empresa/organização), não o nome do signatário (rep. legal).
  const title = `${rec.type.toUpperCase()} — ${recNome(rec) || signer.name} (${rec.fiscalYear})`;
  const ccName = rec.requester?.nome || "Associação Casa Hacker";
  const ccEmail = rec.requester?.email && isEmail(rec.requester.email) ? rec.requester.email : "juridico@casahacker.org";

  const { pdf, signature } = await generateKycPdf(rec);

  const gen = await dso("POST", `/documents`, {
    title,
    externalId: rec.id,
    recipients: [
      { name: ccName, email: ccEmail, role: "CC" },          // [0] cópia ao solicitante
      { name: signer.name, email: signer.email, role: "SIGNER" }, // [1] assina
    ],
    meta: { subject: `Conformidade ${rec.type.toUpperCase()} — Casa Hacker`, message: "Documento de conformidade para assinatura eletrônica." },
  });
  const documentId: number = gen.documentId;
  const uploadUrl: string = gen.uploadUrl;
  const recps: any[] = gen.recipients || [];
  const signerRec = recps.find((r) => r.role === "SIGNER") || recps[recps.length - 1];
  const token: string = signerRec?.token;
  const signerRecipientId: number = signerRec?.recipientId;
  if (!documentId || !uploadUrl || !token || !signerRecipientId) throw new Error("Documenso não retornou documentId/uploadUrl/token");

  const up = await fetch(uploadUrl, {
    method: "PUT", headers: { "Content-Type": "application/pdf" }, body: pdf, signal: AbortSignal.timeout(60000),
  });
  if (!up.ok) throw new Error(`Falha no upload do PDF ao S3 (${up.status})`);

  await dso("POST", `/documents/${documentId}/fields`, {
    recipientId: signerRecipientId, type: "SIGNATURE",
    pageNumber: signature.page, pageX: signature.x, pageY: signature.y,
    pageWidth: signature.width, pageHeight: signature.height,
  });
  await dso("POST", `/documents/${documentId}/send`, { sendEmail: true });
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

// ── faixa de elegibilidade do FORNECEDOR (diligência + KYS/KYG) ──────────────────
// Inelegível: consta restrição ou cadastro não-ativo (verdict ALERTA).
// Elegível até 2 SM: nada consta + tudo ativo na Receita (verdict NADA_CONSTA).
// Elegível a partir de 2 SM: nada consta + ativo + KYS/KYG aprovado (assinado, válido e elegível).
// Pendente: diligência não concluída/ausente.
export type Faixa = "inelegivel" | "ate_2sm" | "acima_2sm" | "pendente";
function faixaOf(verdict: string | undefined, kycAprovado: boolean, situacao?: string): Faixa {
  if (verdict === "ALERTA") return "inelegivel";
  if (situacao && !/ATIVA/i.test(situacao)) return "inelegivel"; // baixada/suspensa/inapta na Receita → inelegível
  if (verdict !== "NADA_CONSTA") return "pendente";
  return kycAprovado ? "acima_2sm" : "ate_2sm";
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
    createdAt: rec.createdAt, signedAt: rec.signedAt, origin: rec.origin,
  };
}

// ── route registration ──────────────────────────────────────────────────────────
// ── impresso (HTML→PDF) do perfil consolidado do fornecedor ─────────────────────
const escH = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FAIXA_LABEL: Record<string, string> = {
  inelegivel: "INELEGÍVEL", ate_2sm: "ELEGÍVEL — contratos até 2 salários mínimos",
  acima_2sm: "ELEGÍVEL — contratos a partir de 2 salários mínimos", pendente: "PENDENTE — diligência não concluída",
};
export function buildFornecedorReportHtml(p: any): string {
  const c = p.cadastro || {}; const dil = p.diligencia; const kyc = p.kyc;
  const dt = (s: any) => { try { return new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return s || "—"; } };
  const row = (k: string, v: any) => v ? `<div class="row"><span class="k">${escH(k)}</span><span class="v">${escH(v)}</span></div>` : "";
  const ender = [c.logradouro, c.numero, c.complemento, c.bairro].filter(Boolean).join(", ");
  const cnaesSec = String(c.cnaesSecundarios || "").split("\n").filter(Boolean);
  const sancHtml = (dil?.sancoes || []).map((s: any) => `<div class="row"><span class="k">${escH(s.fonte)}</span><span class="v ${s.status === "CONSTA" ? "bad" : ""}">${s.status === "CONSTA" ? `CONSTA (${s.hits?.length || 0})` : s.status === "NADA_CONSTA" ? "Nada consta" : escH(s.status)}</span></div>` + (s.hits || []).map((h: any) => `<div class="hit"><b>${escH(h.tipo)}</b> — ${escH(h.orgao)} · vigência ${escH(h.dataInicio || "?")}–${escH(h.dataFim || "?")} · processo ${escH(h.processo || "—")}</div>`).join("")).join("");
  const qsa = (p.qsa || []).map((s: any) => `${escH(s.nome)}${s.qual ? ` (${escH(s.qual)})` : ""}`).join("; ");
  const faixaCls = p.faixa === "acima_2sm" ? "f-ok" : p.faixa === "ate_2sm" ? "f-mid" : p.faixa === "inelegivel" ? "f-bad" : "f-pend";
  const kycMot = (kyc?.elegibilidade?.motivos || []) as string[];
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fornecedor ${escH(c.razaoSocial || p.docFmt)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"IBM Plex Sans",system-ui,sans-serif;color:#161616;background:#fff;font-size:12px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:860px;margin:0 auto;padding:40px 48px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #161616;padding-bottom:14px}
.eyebrow{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#6f6f6f}
h1{font-size:21px;font-weight:700;margin:4px 0 2px}
.sub{color:#525252;font-size:12px}
.brandtag{font-weight:700;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#0f62fe}
.faixa{margin:16px 0 4px;padding:10px 14px;border-left:5px solid #6f6f6f;background:#f4f4f4;border-radius:4px;font-weight:700;font-size:13px;letter-spacing:.02em}
.f-ok{border-color:#198038;background:#defbe6}.f-mid{border-color:#b28600;background:#fcf4d6}.f-bad{border-color:#da1e28;background:#fff1f1}.f-pend{border-color:#6f6f6f;background:#f4f4f4}
section{margin-top:22px;break-inside:avoid}
.sectitle{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#0f62fe;font-weight:700;border-bottom:1px solid #e0e0e0;padding-bottom:5px;margin-bottom:8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 28px}
.row{display:flex;gap:10px;padding:2px 0;align-items:baseline;border-bottom:1px solid #f2f2f2}
.k{color:#6f6f6f;min-width:130px;flex-shrink:0;font-size:11px}.v{font-weight:600;word-break:break-word}.v.bad{color:#da1e28}
.list{margin:2px 0 0 0;padding-left:16px}.list li{font-size:11.5px;padding:1px 0}
.hit{border:1px solid #ffd7d9;background:#fff1f1;border-radius:4px;padding:6px 9px;margin:4px 0;font-size:11px}
.muted{color:#6f6f6f;font-size:11px}
.note{border:1px solid #e0e0e0;background:#f9f9f9;border-radius:4px;padding:8px 10px;margin:5px 0;font-size:11px}.nk{font-weight:700;color:#393939}
table.prov{width:100%;border-collapse:collapse;font-size:10px;margin-top:4px}
table.prov th,table.prov td{border:1px solid #e0e0e0;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-word}
table.prov th{font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:9px;color:#6f6f6f;background:#f4f4f4}
footer{margin-top:34px;border-top:1px solid #e0e0e0;padding-top:12px;color:#6f6f6f;font-size:10px;line-height:1.7}
.toolbar{position:fixed;top:12px;right:16px;background:#0f62fe;color:#fff;border:none;padding:8px 14px;border-radius:4px;font:inherit;font-size:11px;cursor:pointer}
@media print{.toolbar{display:none}.page{padding:0}}@page{margin:14mm}
</style></head><body>
<button class="toolbar" onclick="window.print()">Salvar em PDF / Imprimir</button>
<div class="page">
  <div class="top">
    <div><div class="eyebrow">Perfil de Fornecedor</div><h1>${escH(c.razaoSocial || "—")}</h1>
      <div class="sub">${escH(p.docFmt)}${c.nomeFantasia ? ` · ${escH(c.nomeFantasia)}` : ""}${c.tipo ? ` · ${escH(c.tipo)}` : ""}</div></div>
    <div style="text-align:right"><div class="brandtag">Casa Hacker</div><div class="muted">Auditoria</div></div>
  </div>
  <div class="faixa ${faixaCls}">${escH(FAIXA_LABEL[p.faixa] || "—")}</div>

  <section><div class="sectitle">Dados cadastrais (Receita Federal + CEP)</div>
    <div class="grid">
      ${row("Razão social", c.razaoSocial)}${row("Nome fantasia", c.nomeFantasia)}
      ${row("Tipo", c.tipo)}${row("Porte", c.porte)}
      ${row("Situação cadastral", (c.situacaoCadastral || "") + (c.dataSituacao ? ` (desde ${c.dataSituacao})` : ""))}${row("Motivo", c.motivoSituacao)}
      ${row("Natureza jurídica", c.naturezaJuridica)}${row("Abertura", c.abertura)}
      ${row("Capital social", c.capitalSocial)}${row("CNAE principal", c.cnaePrincipal)}
    </div>
    ${cnaesSec.length ? `<div style="margin-top:6px"><div class="k">CNAEs secundários</div><ul class="list">${cnaesSec.map((x) => `<li>${escH(x)}</li>`).join("")}</ul></div>` : ""}
    <div class="grid" style="margin-top:6px">
      ${row("Endereço", ender)}${row("Município / UF", `${c.municipio || "—"} / ${c.uf || "—"}`)}
      ${row("CEP", c.cep)}${row("Telefone", c.telefone)}
      ${row("E-mail", c.email)}
    </div>
    ${qsa ? `<div style="margin-top:6px">${row("Quadro societário", qsa)}</div>` : ""}
    <div class="grid" style="margin-top:6px">
      ${row("Banco", c.banco)}${row("Agência", c.agencia)}${row("Conta", c.conta)}${row("Chave PIX", c.chavePix)}
    </div>
    ${c.observacoes ? `<div style="margin-top:6px"><div class="k">Observações</div><div class="v">${escH(c.observacoes)}</div></div>` : ""}
  </section>

  <section><div class="sectitle">Diligência — dados da consulta (auditável)</div>
    ${dil ? `<div class="grid"><div class="row"><span class="k">Veredito</span><span class="v ${dil.verdict === "ALERTA" ? "bad" : ""}">${escH(dil.verdict)}</span></div>${row("Data/hora da consulta", dt(dil.checkedAt))}${row("Validade", dil.validUntil ? dt(dil.validUntil) : "—")}${row("Solicitante", dil.checkedBy)}${row("IP de origem", dil.ip)}</div>` : `<div class="muted">Diligência ainda não realizada para este fornecedor.</div>`}
  </section>
${dil ? `
  <section><div class="sectitle">Listas de restrição — nacionais e internacionais</div>
    ${sancHtml || '<div class="muted">Sem consulta.</div>'}
  </section>

  <section><div class="sectitle">Notas jurídicas — base legal das listas consultadas</div>
    ${legalNotesHtml(dil) || '<div class="muted">—</div>'}
  </section>

  <section><div class="sectitle">Memória do processo — proveniência técnica (auditável)</div>
    ${provenanceTableHtml(dil)}
    <div class="muted" style="margin-top:8px">Fontes públicas oficiais, consultadas em tempo real ou a partir de cópia em cache. A correspondência por <b>Nome</b> é conservadora (pode apontar homônimos — confirme a identidade); por <b>CNPJ</b> é exata.</div>
  </section>` : ""}

  <section><div class="sectitle">Conformidade KYS / KYG</div>
    ${kyc ? `${row("Tipo", String(kyc.type || "").toUpperCase())}${row("Status", kyc.status === "assinado" ? (kyc.valida ? "Assinado (válido)" : "Assinado (vencido)") : kyc.status)}${row("Ano fiscal", kyc.fiscalYear)}${kyc.signedAt ? row("Assinado em", dt(kyc.signedAt)) : ""}${row("Elegibilidade interna", kyc.elegibilidade?.elegivel ? "Aprovado" : "Reprovado")}${kycMot.length ? `<div style="margin-top:4px"><div class="k">Motivos</div><ul class="list">${kycMot.map((m) => `<li>${escH(m)}</li>`).join("")}</ul></div>` : ""}` : `<div class="muted">Sem KYS/KYG preenchido. Exigido apenas para contratações específicas.</div>`}
  </section>

  <footer>
    <b>ASSOCIAÇÃO CASA HACKER</b> · CNPJ 36.038.079/0001-97 · São Paulo · SP · operacoes@casahacker.org · casahacker.org<br>
    Relatório consolidado gerado pela plataforma Auditoria (Casa Hacker) em ${escH(new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))} (BRT) · documento de diligência para fins de prestação de contas.<br>
    Todos os horários deste documento estão no fuso de Brasília (BRT, UTC−3).
  </footer>
</div>
<script>window.addEventListener("load",function(){setTimeout(function(){try{window.print()}catch(e){}},500)})</script>
</body></html>`;
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
      // #89 — identificação da empresa, dados bancários e representante legal são obrigatórios.
      const phoneOk = (s?: string) => { const d = onlyDigits(s); return d.length === 10 || d.length === 11; };
      const addrOk = (a: any) => !!(a && String(a.cep || "").trim() && String(a.logradouro || "").trim() && String(a.numero || "").trim() && String(a.bairro || "").trim() && String(a.municipio || "").trim() && String(a.uf || "").trim());
      if (!isEmail(k.email)) return res.status(400).json({ error: "E-mail da empresa obrigatório." });
      if (!phoneOk(k.telefone)) return res.status(400).json({ error: "Telefone da empresa obrigatório (com DDD)." });
      if (!addrOk(k.endereco)) return res.status(400).json({ error: "Endereço completo da empresa obrigatório (CEP, logradouro, número, bairro, município e UF)." });
      if (!k.banco?.banco?.trim() || !k.banco?.agencia?.trim() || !k.banco?.conta?.trim()) return res.status(400).json({ error: "Dados bancários obrigatórios (banco, agência e conta)." });
      if (!k.repEstadoCivil?.trim() || !k.repProfissao?.trim()) return res.status(400).json({ error: "Estado civil e profissão do representante legal obrigatórios." });
      if (!phoneOk(k.repTelefone)) return res.status(400).json({ error: "Telefone do representante legal obrigatório (com DDD)." });
      if (!addrOk(k.repEndereco)) return res.status(400).json({ error: "Endereço completo do representante legal obrigatório (CEP, logradouro, número, bairro, município e UF)." });
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

    // régua de conformidade (Receita + listas + PEP do rep. legal/QSA)
    const repLegal = type === "kys"
      ? { nome: (body.kys as KysData).repNome, cpf: (body.kys as KysData).repCpf }
      : ((body.kyg as KygData)?.tipoPessoa === "pf" ? { nome: (body.kyg as KygData).nome, cpf: onlyDigits((body.kyg as KygData).documento) } : undefined);
    let checks;
    try { checks = await runKycChecks(documento, repLegal); }
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
      origin: body.inviteToken ? "convite" : "self",
      fiscalYear: y, validUntil: fiscalValidUntil(y),
      createdAt: nowIso(), ip: reqIp(req), userAgent: String(req.headers["user-agent"] || ""),
    };

    // guarda os dados crus da régua p/ relatório interno
    (rec as any).receitaSnapshot = checks.receita; (rec as any).sancoesSnapshot = checks.sancoes;
    rec.elegibilidade = computeEligibility(rec);

    // assinatura via Documenso (se configurado)
    if (documensoReady(type)) {
      try {
        const { documentId, token } = await createSignature(rec, signer);
        rec.documensoDocumentId = documentId; rec.documensoToken = token;
      } catch (e: any) {
        console.error("[KYC] Documenso falhou:", e.message);
        writeRec(rec);
        return res.status(502).json({ error: "Falha ao preparar a assinatura no Documenso: " + e.message, id: rec.id });
      }
    }
    writeRec(rec);

    // #88/#87 — atualiza a diligência em 2º plano (agora inclui o PEP do representante legal, via
    // latestKysRepLegal) para que a ficha mostre UMA única trilha consolidada. Não bloqueia o envio.
    if (documento.length === 14) void runDiligence(DATA_DIR, documento, { checkedBy: "KYS/KYG (autodeclaração)", ip: reqIp(req), force: true }).catch((e) => console.warn("[KYC] diligência pós-submit:", e?.message));

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
    const dilSummary = (r: any) => r ? { verdict: r.verdict, valida: dilValid(r), checkedAt: r.checkedAt, situacao: r.receita?.situacao_cadastral || "" } : null;
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
      row.kyc = { id: rec.id, type: rec.type, status: rec.status, elegivel: rec.elegibilidade?.elegivel, fiscalYear: rec.fiscalYear, valida: rec.status === "assinado" && isFiscalValid(rec), signedAt: rec.signedAt, origin: rec.origin };
    }
    for (const row of rows.values()) {
      const kycAprovado = !!(row.kyc && row.kyc.status === "assinado" && row.kyc.valida && row.kyc.elegivel === true);
      row.faixa = faixaOf(row.diligencia?.verdict, kycAprovado, row.diligencia?.situacao);
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
    const kycValida = !!(kyc && kyc.status === "assinado" && isFiscalValid(kyc));
    const faixa = faixaOf(dil?.verdict, !!(kycValida && kyc!.elegibilidade?.elegivel === true), cadastro.situacaoCadastral);
    return { doc, docFmt: fmtCnpj(doc), tipo: doc.length === 14 ? "pj" : "pf", cadastro, manual, fontes, qsa, faixa, diligencia: dil ? { ...dil, valida: !!(dil.validUntil && new Date(dil.validUntil).getTime() > Date.now()) } : null, kyc: kyc ? { ...kycSafe, valida: kycValida } : null };
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

  // re-semeia os campos NÃO manuais a partir das APIs (mantém os editados manualmente)
  const reseedCadastro = (doc: string, updatedBy?: string) => {
    const { fields: api, fontes } = apiFields(doc);
    const stored = readCad(doc) || { doc, tipo: doc.length === 14 ? "pj" : "pf", fields: {}, manual: {} };
    const fields: Record<string, string> = { ...stored.fields };
    for (const k of CADASTRO_FIELDS) if (!stored.manual?.[k]) fields[k] = api[k] || fields[k] || "";
    writeCad(doc, { ...stored, doc, tipo: doc.length === 14 ? "pj" : "pf", fields, fontes, updatedAt: new Date().toISOString(), updatedBy });
  };

  // "Atualizar das APIs" — refresh RÁPIDO do cadastro (Receita + CEP), SEM as listas de
  // restrição (lentas por paginação). Atualiza apenas a parte 'receita' do registro de diligência.
  app.post("/api/fornecedores/:doc/refresh", requireAuth, async (req: any, res) => {
    const doc = docParam(req, res); if (!doc) return;
    if (doc.length === 14) {
      try {
        const receita = await fetchReceita(doc);
        if (receita) {
          const dil = readDilRec(doc) || { cnpj: doc, sancoes: [], verdict: "PENDENTE", checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 86400000).toISOString(), checkedBy: req.user?.email || "—" };
          dil.receita = receita; dil.razaoSocial = receita.razao_social || dil.razaoSocial || "—"; dil.nomeFantasia = receita.nome_fantasia || dil.nomeFantasia || "";
          fs.mkdirSync(path.join(DATA_DIR, "diligencia"), { recursive: true });
          fs.writeFileSync(path.join(DATA_DIR, "diligencia", `${doc}.json`), JSON.stringify(dil, null, 2));
        }
      } catch (e: any) { console.warn("[Fornecedor] refresh receita:", e?.message); }
    }
    reseedCadastro(doc, req.user?.email);
    res.json(profileResponse(doc));
  });

  // "Reconsultar diligência" — diligência COMPLETA (Receita + CEP + listas de restrição CGU).
  // Mais lenta (paginação); usar quando precisar revalidar as sanções.
  app.post("/api/fornecedores/:doc/diligencia", requireAuth, async (req: any, res) => {
    const doc = docParam(req, res); if (!doc) return;
    if (doc.length !== 14) return res.status(400).json({ error: "A diligência de restrições aplica-se a CNPJ." });
    try { await runDiligence(DATA_DIR, doc, { checkedBy: req.user?.email || "—", ip: reqIp(req), userAgent: String(req.headers["user-agent"] || ""), force: true }); }
    catch (e: any) { return res.status(502).json({ error: e?.message || "Falha na diligência" }); }
    reseedCadastro(doc, req.user?.email);
    res.json(profileResponse(doc));
  });

  // ── atualização EM MASSA dos dados das APIs (Receita + CEP) ──────────────────────
  // Aplica a TODA a base a mesma lógica do refresh individual: atualiza o bloco 'receita'
  // do registro de diligência (alimenta a LISTA) e re-semeia o perfil consolidado, mantendo
  // os campos marcados como manuais (alimenta as FICHAS). Roda em segundo plano e em série —
  // fetchReceita já passa pelo limitador global de chamadas (DILIGENCIA_RATE_PER_MIN). O
  // progresso fica em GET /api/fornecedores/refresh-all/status.
  const mass = { running: false, total: 0, done: 0, fail: 0, startedAt: "", startedBy: "", finishedAt: "", lastError: "" };
  const writeDilReceita = (doc: string, receita: any) => {
    const dir = path.join(DATA_DIR, "diligencia"); fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${doc}.json`);
    let dil: any; try { dil = JSON.parse(fs.readFileSync(p, "utf-8")); }
    catch { dil = { cnpj: doc, sancoes: [], verdict: "PENDENTE", checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 86400000).toISOString(), checkedBy: "Associação Casa Hacker", ip: process.env.SERVER_IP || "sistema" }; }
    dil.receita = receita;
    dil.razaoSocial = receita.razao_social || dil.razaoSocial || "—";
    dil.nomeFantasia = receita.nome_fantasia || dil.nomeFantasia || "";
    const inativa = !/ATIVA/i.test(receita.situacao_cadastral || "");
    const anySancao = (dil.sancoes || []).some((x: any) => x.status === "CONSTA");
    dil.verdict = (anySancao || inativa) ? "ALERTA" : ((dil.sancoes || []).length ? "NADA_CONSTA" : "PENDENTE");
    fs.writeFileSync(p, JSON.stringify(dil, null, 2));
  };
  async function refreshAllFromApis(startedBy: string): Promise<void> {
    if (mass.running) return;
    const docs = Array.from(new Set(collectSuppliers(DATA_DIR).map((s: any) => onlyDigits(s.cnpj)).filter((d: string) => d.length === 14)));
    Object.assign(mass, { running: true, total: docs.length, done: 0, fail: 0, startedAt: new Date().toISOString(), startedBy, finishedAt: "", lastError: "" });
    console.log(`[Fornecedores] atualização em massa das APIs iniciada por ${startedBy} (${docs.length} CNPJs)`);
    try {
      for (const doc of docs) {
        try {
          const receita = await fetchReceita(doc);
          if (receita) writeDilReceita(doc, receita);
          reseedCadastro(doc, "atualização em massa");
          mass.done++;
        } catch (e: any) { mass.fail++; mass.lastError = e?.message || String(e); }
      }
    } finally {
      mass.running = false; mass.finishedAt = new Date().toISOString();
      console.log(`[Fornecedores] atualização em massa concluída: ${mass.done} ok, ${mass.fail} erro(s)`);
    }
  }

  // Registradas ANTES de qualquer rota futura com ':doc' que pudesse capturar "refresh-all".
  app.post("/api/fornecedores/refresh-all", requireAuth, (req: any, res) => {
    if (mass.running) return res.json({ started: false, alreadyRunning: true, ...mass });
    void refreshAllFromApis(req.user?.email || "—");
    res.json({ started: true, ...mass });
  });
  app.get("/api/fornecedores/refresh-all/status", requireAuth, (_req, res) => res.json({ ...mass }));

  // atualização cadastral em massa (uma vez) no startup quando DILIGENCIA_FORCE_REFRESH=1
  if (process.env.DILIGENCIA_FORCE_REFRESH === "1") {
    setTimeout(() => { void refreshAllFromApis("DILIGENCIA_FORCE_REFRESH (startup)"); }, 20_000);
  }

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

  // impresso HTML→PDF do perfil consolidado
  app.get("/api/fornecedores/:doc/report.html", requireAuth, (req: any, res) => {
    const doc = docParam(req, res); if (!doc) return;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildFornecedorReportHtml(profileResponse(doc)));
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
    // Legados (importados do Documenso pré-S3): o PDF assinado fica guardado localmente — a API do Documenso não os serve.
    if (rec.legacyPdfPath) {
      const lp = path.join(DATA_DIR, rec.legacyPdfPath);
      if (fs.existsSync(lp)) { res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${rec.type}_${recDoc(rec)}_${rec.fiscalYear}.pdf"`); return res.send(fs.readFileSync(lp)); }
      return res.status(404).json({ error: "PDF legado não encontrado" });
    }
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

  // #86 — varredura periódica: reconhece assinaturas concluídas no Documenso SEM ação manual.
  // O caminho interativo (/completed, /signature-status) já cobre o clique do usuário; esta
  // varredura cobre o atraso entre o "concluí" e o selo final do Documenso, e o caso de o
  // cockpit estar aberto noutra sessão — assim a ficha passa a "Assinado" sozinha.
  if (DOCUMENSO_TOKEN) {
    const sweepSignatures = async () => {
      for (const rec of listRecs()) {
        if (rec.status !== "aguardando_assinatura" || !rec.documensoDocumentId) continue;
        try {
          const doc = await getDocumentStatus(rec.documensoDocumentId);
          if (doc?.status === "COMPLETED") {
            const fresh = readRec(rec.id); if (!fresh || fresh.status === "assinado") continue;
            fresh.status = "assinado"; fresh.signedAt = nowIso(); delete fresh.documensoToken; writeRec(fresh);
            console.log(`[KYC] assinatura reconhecida automaticamente: ${rec.id} (${recDoc(rec)})`);
          }
        } catch { /* tenta no próximo ciclo */ }
      }
    };
    const SWEEP_MS = Math.max(15_000, Number(process.env.KYC_SIGN_SWEEP_MS || 60_000));
    setTimeout(() => void sweepSignatures(), 15_000);
    setInterval(() => void sweepSignatures(), SWEEP_MS);
  }

  console.log(`[KYC] routes registered (/api/kyc, /api/public/kyc) — Documenso KYS:${documensoReady("kys") ? "on" : "off"} KYG:${documensoReady("kyg") ? "on" : "off"}`);
}
