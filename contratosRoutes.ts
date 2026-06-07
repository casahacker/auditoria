/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — backend (fundação, #127).
 *
 * Redator de contratos de prestação de serviços (PJ) e termos aditivos. Esta camada
 * cobre a FUNDAÇÃO da Fase 1: modelo de dados, persistência em /app/data/contratos,
 * geração de IDs sequenciais por ano (gravação atômica), trilha auditável append-only
 * e o esqueleto da API. Endpoints que dependem de outras sub-issues respondem 501 com
 * a issue de referência (ver épico #126).
 *
 * Persistência: DATA_DIR/contratos/<id>/contrato.json (+ PDFs/anexos no mesmo diretório).
 * Sequência:    DATA_DIR/contratos/_seq.json  → { "2026": { CT: 3, AD: 1 } }.
 */
import type { Express, RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import path from "path";
import fs from "fs";
import multer from "multer";
import mammoth from "mammoth";
import crypto from "node:crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import type OpenAI from "openai";
import { z } from "zod";
const execFileAsync = promisify(execFile);
import type { Contrato, ContratoStatus, EventoTrilha, JiraVinculo, AnexoRef, Aditivo, Parcela, DadosContratada } from "./src/contratos/contratosTypes";
import { resumoDoContrato } from "./src/contratos/contratosTypes";
import { verificarTc, tcStatus, tcSnapshot, TC_PATH } from "./src/contratos/termosCondicoes";
import { enviarContratoParaAssinatura, documensoReady, statusDocumento, baixarAssinado, documensoHost } from "./src/contratos/documenso";
import { validarIssue, HTTP_POR_MOTIVO, comentarIssue, anexarIssue, jiraSyncLigado } from "./src/contratos/jiraClient";
import { validarContratoParaGeracao, somaParcelasCentavos, fmtMoeda } from "./src/contratos/validacoes";
import { avaliarElegibilidade, aplicarJustificativas } from "./src/contratos/elegibilidade";
import { extrairDados } from "./src/contratos/extracao";
import { renderContratoHtml, renderContratoPdf, renderAditivoHtml, renderAditivoPdf } from "./src/contratos/render";
import { montarDadosContratada } from "./src/contratos/dadosContratada";
import { ehClausulaOpcionalValida, VERSAO_CLAUSULAS_OPCIONAIS } from "./src/contratos/templates/clausulasOpcionais_v2026_05";

export interface ContratosCtx {
  DATA_DIR: string;
  requireAuth: RequestHandler;
  sanitizeSegment: (s: string) => string | null;
  aiClient: OpenAI;
  extractTextFromFile: (filePath: string) => Promise<string>;
  parseJsonSafe: (text: string) => any;
}

// ── helpers de formatação ────────────────────────────────────────────────────────
const onlyDigits = (s: any): string => String(s ?? "").replace(/\D/g, "");
const nowIso = () => new Date().toISOString();
const sessionUser = (req: any): string => String(req.user?.email || "desconhecido");
function fmtCnpj(d?: string): string {
  const x = onlyDigits(d);
  if (x.length === 14) return `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}`;
  return d || "";
}

// Ordem fixa do envelope Documenso (#139): aprovadores → Diretor (Casa Hacker) → Contratada → CC jurídico.
const nomeDeEmail = (e: string): string => e.split("@")[0].split(/[._-]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || e;
const aprovadoresContrato = (): { name: string; email: string }[] =>
  (process.env.CONTRATOS_APROVADORES || "melissa.suda@casahacker.org,everton.justo@casahacker.org")
    .split(",").map((e) => e.trim()).filter(Boolean).map((e) => ({ name: nomeDeEmail(e), email: e }));

// ── validação de payloads (zod) ──────────────────────────────────────────────────
const cnpjField = z.string().transform(onlyDigits).refine((v) => v.length === 14, "CNPJ deve ter 14 dígitos");
// Formato JUR-<número>; a existência/projeto da issue é validada em #133.
const jiraKeyField = z.string().trim().regex(/^JUR-\d+$/i, "Issue Jira deve ter o formato JUR-<número>");

const createSchema = z.object({
  cnpj: cnpjField,
  jiraIssueKey: jiraKeyField.optional(),
  ordemCompra: z.string().trim().max(120).optional(),
  tipoDocumentoEntrada: z.enum(["tr", "proposta"]).optional(),
});

const parcelaSchema = z.object({
  numero: z.number().int().nonnegative(),
  valorCentavos: z.number().int(),
  vencimento: z.string().nullable(),
  descricao: z.string().optional(),
  estimada: z.boolean().optional(),
});

const dadosContratadaSchema = z.object({
  cnpj: z.string(), razaoSocial: z.string(), nomeFantasia: z.string(),
  endereco: z.object({
    cep: z.string(), logradouro: z.string(), numero: z.string(), complemento: z.string(),
    bairro: z.string(), municipio: z.string(), uf: z.string(),
  }).partial(),
  representante: z.object({
    nome: z.string(), cpf: z.string(), cargo: z.string(), email: z.string(),
    nacionalidade: z.string(), estadoCivil: z.string(),
  }).partial(),
  cnaePrincipal: z.string(), cnaesSecundarios: z.array(z.string()),
  porte: z.string(), naturezaJuridica: z.string(),
  banco: z.string(), agencia: z.string(), conta: z.string(), chavePix: z.string(),
  fonte: z.string(),
}).partial();

// PATCH: apenas campos editáveis pelo operador. Chaves desconhecidas (id, trilha, hashTC…)
// são descartadas (zod faz strip por padrão) — não há como sobrescrever campos protegidos.
const patchSchema = z.object({
  status: z.enum(["rascunho", "em_revisao", "cancelado"]),
  jiraIssueKey: jiraKeyField,
  ordemCompra: z.string().max(120),
  tipoDocumentoEntrada: z.enum(["tr", "proposta"]),
  dadosContratada: dadosContratadaSchema,
  objeto: z.string(),
  resumoEscopo: z.string(),
  vigenciaInicio: z.string().nullable(),
  vigenciaFim: z.string().nullable(),
  vigenciaEstimada: z.boolean(),
  vigenciaDuracaoMeses: z.number().int().nonnegative(),
  vigenciaDuracaoDias: z.number().int().nonnegative(),
  prorrogavel: z.boolean(),
  prorrogacaoMaxMeses: z.number().int().nonnegative(),
  valorTotalCentavos: z.number().int().nonnegative(),
  parcelas: z.array(parcelaSchema),
  condicoesPagamento: z.string(),
  sla: z.string(),
  localExecucao: z.string(),
  equipamentosFornecidosPelaContratante: z.string(),
  // cláusulas opcionais (#157): só ids válidos do catálogo são persistidos.
  clausulasOpcionais: z.array(z.string()).transform((a) => a.filter(ehClausulaOpcionalValida)),
}).partial();

// Aditivo (#137) — payload da criação (no multipart vem como campo `payload` JSON).
const aditivoSchema = z.object({
  tipo: z.enum(["prorrogacao", "valor_parcelas", "escopo", "dados_cadastrais"]),
  jiraIssueKey: jiraKeyField.optional(),
  descricao: z.string().max(2000).optional(),
  vigenciaNovaFim: z.string().nullable().optional(),
  valorNovoCentavos: z.number().int().nonnegative().optional(),
  parcelasNovas: z.array(parcelaSchema).optional(),
  escopoNovo: z.string().optional(),
  dadosCadastraisNovos: dadosContratadaSchema.optional(),
  confirmarSemAssinatura: z.boolean().optional(),
});

const zodError = (e: any) => ({
  error: "Dados inválidos",
  detalhes: e?.issues?.map((i: any) => ({ campo: i.path.join(".") || "(raiz)", msg: i.message })) || [String(e?.message || e)],
});

// Resolve o vínculo Jira validando a issue NO SERVIDOR (gate — não confia no front).
// Sem integração configurada (dev/local) aceita o vínculo como "nao_validado": não é
// bypass em produção, onde o Jira está sempre configurado e a issue inválida bloqueia.
// Sucesso → { jira }; falha → { erroStatus, erroBody } (para a rota responder direto).
async function resolverVinculoJira(
  key: string,
): Promise<{ jira?: JiraVinculo; erroStatus?: number; erroBody?: any }> {
  const v = await validarIssue(key);
  if (v.ok && v.issue) {
    return { jira: { issueKey: v.issue.key, resumo: v.issue.summary, status: v.issue.status, categoriaStatus: v.issue.statusCategory, syncStatus: "validado" } };
  }
  if (v.motivo === "nao_configurado") {
    return { jira: { issueKey: key.trim().toUpperCase(), syncStatus: "nao_validado" } };
  }
  return {
    erroStatus: HTTP_POR_MOTIVO[v.motivo || "rede"] || 502,
    erroBody: { error: v.erro, motivo: v.motivo, ...(v.issue ? { jira: v.issue } : {}) },
  };
}

export function registerContratosRoutes(app: Express, ctx: ContratosCtx) {
  const { DATA_DIR, requireAuth, sanitizeSegment, aiClient, extractTextFromFile, parseJsonSafe } = ctx;
  const CONTRATOS_DIR = path.join(DATA_DIR, "contratos");
  const SEQ_FILE = path.join(CONTRATOS_DIR, "_seq.json");
  fs.mkdirSync(CONTRATOS_DIR, { recursive: true });

  // T&C imutáveis (#128): confere o SHA-256 do PDF oficial no boot e registra. Em caso
  // de divergência a app NÃO cai — apenas a geração de pacotes é bloqueada (fail-safe).
  const tc = verificarTc();
  console.log(
    `[Contratos] T&C v${tc.versao} — ${tc.ok ? "OK" : "FALHA"} ` +
    `(sha256 ${tc.encontrado ? tc.encontrado.slice(0, 16) + "…" : "—"})` +
    `${tc.ok ? "" : ` — geração de pacotes BLOQUEADA: ${tc.erro}`}`,
  );

  // ── IDs sequenciais por ano (gravação atômica) ─────────────────────────────────
  // CH-CT-{ANO}-{SEQ 3díg} / CH-AD-{ANO}-{SEQ}. Síncrono de ponta a ponta: entre a
  // leitura e a escrita do contador NÃO há await, logo é atômico no event-loop e não
  // colide sob concorrência. O temp+rename garante escrita sem corromper o arquivo.
  const allocId = (kind: "CT" | "AD"): string => {
    const year = new Date().getFullYear();
    let seq: Record<string, { CT?: number; AD?: number }> = {};
    try { seq = JSON.parse(fs.readFileSync(SEQ_FILE, "utf-8")) || {}; } catch { seq = {}; }
    const y = String(year);
    if (!seq[y]) seq[y] = {};
    const n = (seq[y][kind] || 0) + 1;
    seq[y][kind] = n;
    const tmp = `${SEQ_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seq, null, 2));
    fs.renameSync(tmp, SEQ_FILE);
    return `CH-${kind}-${year}-${String(n).padStart(3, "0")}`;
  };

  // ── persistência (1 diretório por contrato) ────────────────────────────────────
  const contratoDir = (id: string) => path.join(CONTRATOS_DIR, id);
  const contratoPath = (id: string) => path.join(contratoDir(id), "contrato.json");
  const readContrato = (id: string): Contrato | null => {
    try { return JSON.parse(fs.readFileSync(contratoPath(id), "utf-8")); } catch { return null; }
  };
  const writeContrato = (c: Contrato) => {
    fs.mkdirSync(contratoDir(c.id), { recursive: true });
    const final = contratoPath(c.id);
    const tmp = `${final}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, final);
  };
  const listContratos = (): Contrato[] =>
    (fs.existsSync(CONTRATOS_DIR) ? fs.readdirSync(CONTRATOS_DIR) : [])
      .filter((name) => { try { return fs.statSync(path.join(CONTRATOS_DIR, name)).isDirectory(); } catch { return false; } })
      .map((name) => readContrato(name))
      .filter((c): c is Contrato => !!c);

  // ── aditivos: 1 diretório por contrato (#137) ─────────────────────────────────
  const aditivoDir = (cid: string) => path.join(contratoDir(cid), "aditivos");
  const aditivoPath = (cid: string, aid: string) => path.join(aditivoDir(cid), `${aid}.json`);
  const readAditivo = (cid: string, aid: string): Aditivo | null => { try { return JSON.parse(fs.readFileSync(aditivoPath(cid, aid), "utf-8")); } catch { return null; } };
  const writeAditivo = (cid: string, a: Aditivo) => { fs.mkdirSync(aditivoDir(cid), { recursive: true }); const f = aditivoPath(cid, a.id); const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(a, null, 2)); fs.renameSync(tmp, f); };
  const listAditivos = (cid: string): Aditivo[] => (fs.existsSync(aditivoDir(cid)) ? fs.readdirSync(aditivoDir(cid)) : [])
    .filter((f) => f.endsWith(".json")).map((f) => readAditivo(cid, f.replace(/\.json$/, ""))).filter((a): a is Aditivo => !!a)
    .sort((a, b) => a.numeroOrdinal - b.numeroOrdinal);

  // ── trilha append-only (helper reaproveitável pelas demais issues) ─────────────
  const appendTrilha = (
    c: { trilha: EventoTrilha[] }, usuario: string, acao: string,
    resumo?: string, meta?: Record<string, any>,
  ) => {
    if (!Array.isArray(c.trilha)) c.trilha = [];
    c.trilha.push({ ts: nowIso(), usuario, acao, ...(resumo ? { resumo } : {}), ...(meta ? { meta } : {}) });
  };

  // sincronização Jira best-effort (#140): comenta no marco; falha NÃO bloqueia.
  const syncJira = async (c: Contrato, marco: string, texto: string) => {
    if (!jiraSyncLigado() || !c.jira?.issueKey) return;
    const r = await comentarIssue(c.jira.issueKey, texto);
    c.jiraSync = [...(c.jiraSync || []).filter((s) => s.marco !== marco), { marco, ok: r.ok, ts: nowIso(), ...(r.erro ? { erro: r.erro } : {}) }];
    appendTrilha(c, "sistema", r.ok ? "jira_sync" : "jira_sync_falhou", `${marco}: Jira ${r.ok ? "ok" : `falhou (${r.erro})`}`);
    writeContrato(c);
  };

  // Finaliza a assinatura quando o Documenso confirma COMPLETED: baixa o PDF assinado,
  // marca o contrato, registra a trilha e sincroniza/anexa no Jira. IDEMPOTENTE — usado
  // tanto pelo polling (/assinatura/status) quanto pelo webhook (#156). Devolve true se
  // concluiu agora. `statusConhecido` evita uma consulta extra quando o chamador já tem.
  const concluirAssinatura = async (contrato: Contrato, ator: string, statusConhecido?: string): Promise<boolean> => {
    const docId = contrato.documenso?.documentId;
    if (!docId || contrato.status === "assinado") return false;
    const st = statusConhecido || (await statusDocumento(docId));
    if (st !== "COMPLETED") return false;
    const buf = await baixarAssinado(docId);
    if (buf) {
      fs.writeFileSync(path.join(contratoDir(contrato.id), "assinado.pdf"), buf);
      contrato.anexos = { ...(contrato.anexos || {}), assinado: { nome: "assinado.pdf", tipo: "assinado", mime: "application/pdf", tamanho: buf.length, adicionadoEm: nowIso() } };
    }
    contrato.status = "assinado";
    contrato.documenso = { ...contrato.documenso, status: "COMPLETED", assinadoEm: nowIso() };
    appendTrilha(contrato, ator, "assinatura_concluida", "Contrato assinado por todas as partes.");
    contrato.updatedAt = nowIso(); writeContrato(contrato);
    await syncJira(contrato, "assinatura_concluida", `Contrato ${contrato.id} ASSINADO por todas as partes.`);
    const assinadoPath = path.join(contratoDir(contrato.id), "assinado.pdf");
    if (contrato.jira?.issueKey && jiraSyncLigado() && fs.existsSync(assinadoPath)) {
      const ar = await anexarIssue(contrato.jira.issueKey, `${contrato.id}-assinado.pdf`, fs.readFileSync(assinadoPath));
      contrato.jiraSync = [...(contrato.jiraSync || []).filter((s) => s.marco !== "anexo_assinado"), { marco: "anexo_assinado", ok: ar.ok, ts: nowIso(), ...(ar.erro ? { erro: ar.erro } : {}) }];
      appendTrilha(contrato, "sistema", ar.ok ? "jira_anexo" : "jira_anexo_falhou", `Anexo do PDF assinado: Jira ${ar.ok ? "ok" : `falhou (${ar.erro})`}`);
      writeContrato(contrato);
    }
    return true;
  };

  // ── rate limit (padrão da suíte) ───────────────────────────────────────────────
  const writeLimiter = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
    message: { error: "Muitas requisições. Aguarde 1 minuto." },
  });

  // upload do TR/Proposta (PDF/DOCX) para a extração (#131).
  const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  const idParam = (req: any, res: any): string | null => {
    const id = sanitizeSegment(String(req.params.id || ""));
    if (!id) { res.status(400).json({ error: "ID inválido" }); return null; }
    return id;
  };

  // stub p/ endpoints de outras sub-issues — 501 com a issue de referência.
  const naoImplementado = (issue: string, oque: string): RequestHandler => (_req, res) =>
    res.status(501).json({ error: "Ainda não implementado", detalhe: `${oque} — previsto para a issue ${issue}.` });

  // fail-safe dos T&C (#128): recusa montar pacotes se o hash divergir (não derruba a app).
  const exigirTcOk: RequestHandler = (_req, res, next) => {
    const s = tcStatus();
    if (!s.ok) return res.status(503).json({
      error: "Geração de pacotes bloqueada — T&C inválidos",
      detalhe: s.erro, versaoTC: s.versao, esperado: s.esperado, encontrado: s.encontrado,
    });
    next();
  };

  // ─────────────────────────── CRUD da fundação ───────────────────────────────────

  // Criar rascunho (passo 1 do wizard) — Seção 13.
  app.post("/api/contratos", writeLimiter, requireAuth, async (req, res) => {
    let body: z.infer<typeof createSchema>;
    try { body = createSchema.parse(req.body); }
    catch (e) { return res.status(400).json(zodError(e)); }

    // Se já vier vinculado a uma issue JUR, valida no servidor (#133) antes de criar.
    let jira: JiraVinculo | undefined;
    if (body.jiraIssueKey) {
      const r = await resolverVinculoJira(body.jiraIssueKey);
      if (r.erroBody) return res.status(r.erroStatus || 502).json(r.erroBody);
      jira = r.jira;
    }

    const id = allocId("CT");
    const now = nowIso();
    const user = sessionUser(req);
    const contrato: Contrato = {
      id, status: "rascunho", cnpj: body.cnpj,
      ...(jira ? { jira } : {}),
      ...(body.ordemCompra ? { ordemCompra: body.ordemCompra } : {}),
      ...(body.tipoDocumentoEntrada ? { tipoDocumentoEntrada: body.tipoDocumentoEntrada } : {}),
      dadosContratada: montarDadosContratada(DATA_DIR, body.cnpj), // merge Cockpit/KYS (operador confere)
      aditivos: [], trilha: [], createdAt: now, createdBy: user, updatedAt: now,
    };
    appendTrilha(contrato, user, "criou_rascunho", `Rascunho criado para o CNPJ ${fmtCnpj(body.cnpj)}`);
    writeContrato(contrato);
    res.status(201).json(contrato);
  });

  // Listar (filtros: cnpj, status, ano) — Seção 14.1.
  app.get("/api/contratos", requireAuth, (req, res) => {
    const fCnpj = onlyDigits(req.query.cnpj);
    const fStatus = String(req.query.status || "");
    const fAno = String(req.query.ano || "");
    const fVenc = Number(req.query.vencendo_em_dias) || 0; // #141
    let rows = listContratos();
    if (fCnpj) rows = rows.filter((c) => c.cnpj === fCnpj);
    if (fStatus) rows = rows.filter((c) => c.status === fStatus);
    if (fAno) rows = rows.filter((c) => c.id.includes(`-${fAno}-`));
    if (fVenc > 0) {
      const hoje = new Date().toISOString().slice(0, 10);
      const lim = new Date(Date.now() + fVenc * 86_400_000).toISOString().slice(0, 10);
      rows = rows.filter((c) => { const fim = String(c.vigenciaFim || "").slice(0, 10); return fim && fim >= hoje && fim <= lim; });
    }
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(rows.map(resumoDoContrato));
  });

  // Validação da issue Jira (#133) — registrar antes de "/:id" para não colidir.
  // Passo 2 do wizard: confere existência + projeto e devolve summary/status. Categoria
  // "Done" vem com alertaDone para a ciência obrigatória no front.
  app.get("/api/contratos/jira/:issueKey", requireAuth, async (req, res) => {
    const v = await validarIssue(String(req.params.issueKey || ""));
    if (v.ok && v.issue) return res.json({ ok: true, issue: v.issue, alertaDone: v.issue.isDone });
    const status = HTTP_POR_MOTIVO[v.motivo || "rede"] || 502;
    res.status(status).json({ ok: false, error: v.erro, motivo: v.motivo, ...(v.issue ? { issue: v.issue } : {}) });
  });

  // Status dos T&C imutáveis (#128) — antes de "/:id" p/ não casar com :id="tc".
  app.get("/api/contratos/tc", requireAuth, (_req, res) => res.json(tcStatus()));

  // Alertas de vigência (#141) — contratos vencendo em ≤N dias (default 45).
  app.get("/api/contratos/alertas/vigencia", requireAuth, (req, res) => {
    const dias = Math.max(1, Math.min(365, Number(req.query.dias) || 45));
    const hoje = new Date().toISOString().slice(0, 10);
    const limite = new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
    const rows = listContratos().filter((c) => {
      const fim = String(c.vigenciaFim || "").slice(0, 10);
      return fim && fim >= hoje && fim <= limite && ["em_revisao", "aprovado", "enviado_assinatura", "assinado", "vigente"].includes(c.status);
    }).sort((a, b) => String(a.vigenciaFim).localeCompare(String(b.vigenciaFim)));
    res.json({ dias, contratos: rows.map(resumoDoContrato) });
  });

  // Prefill dos dados da CONTRATADA (passo 1 do wizard) — merge Cockpit/KYS (#134).
  app.get("/api/contratos/fornecedor/:cnpj", requireAuth, (req, res) => {
    const cnpj = onlyDigits(req.params.cnpj);
    if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ deve ter 14 dígitos" });
    res.json(montarDadosContratada(DATA_DIR, cnpj));
  });

  // Detalhe — Seção 14.3.
  app.get("/api/contratos/:id", requireAuth, (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    res.json(c);
  });

  // Editar campos do operador (conferência/edição do wizard) — trilha registra o diff.
  app.patch("/api/contratos/:id", writeLimiter, requireAuth, async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });

    let parsed: z.infer<typeof patchSchema>;
    try { parsed = patchSchema.parse(req.body); }
    catch (e) { return res.status(400).json(zodError(e)); }

    const user = sessionUser(req);
    const changed: string[] = [];

    // jiraIssueKey é uma string no payload, mas mora em contrato.jira; valida no servidor (#133).
    if (parsed.jiraIssueKey !== undefined) {
      const key = parsed.jiraIssueKey.toUpperCase();
      if (contrato.jira?.issueKey !== key) {
        const r = await resolverVinculoJira(key);
        if (r.erroBody) return res.status(r.erroStatus || 502).json(r.erroBody);
        if (r.jira) { contrato.jira = r.jira; changed.push("jira"); }
      }
      delete (parsed as any).jiraIssueKey;
    }

    for (const [k, v] of Object.entries(parsed)) {
      if (v === undefined) continue;
      if (JSON.stringify((contrato as any)[k]) !== JSON.stringify(v)) {
        (contrato as any)[k] = v;
        changed.push(k);
      }
    }

    if (!changed.length) return res.json(contrato);
    contrato.updatedAt = nowIso();
    appendTrilha(contrato, user, "editou_campos", `Editou: ${changed.join(", ")}`, { campos: changed });
    writeContrato(contrato);
    res.json(contrato);
  });

  // Download de anexo do contrato (entrada/minuta/pacote/assinado) — Seção 14.3.
  app.get("/api/contratos/:id/anexos/:filename", requireAuth, (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const filename = sanitizeSegment(String(req.params.filename || ""));
    if (!filename) return res.status(400).json({ error: "Arquivo inválido" });
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    const fp = path.join(contratoDir(id), filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: "Anexo não encontrado" });
    res.sendFile(fp);
  });

  // Texto extraído do documento de entrada (#160) — para o visualizador com destaque do
  // trecho-fonte na conferência (serve PDF e DOCX, sem pdf.js no front).
  app.get("/api/contratos/:id/texto-entrada", requireAuth, async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    const entrada = c.anexos?.entrada;
    if (!entrada) return res.json({ texto: "" });
    const fp = path.join(contratoDir(id), entrada.nome);
    if (!fs.existsSync(fp)) return res.json({ texto: "" });
    try {
      const ext = path.extname(entrada.nome).toLowerCase();
      let texto = "";
      if (ext === ".docx") texto = (await mammoth.extractRawText({ path: fp })).value || "";
      else if (ext === ".pdf") texto = await extractTextFromFile(fp);
      else texto = fs.readFileSync(fp, "utf-8");
      res.json({ texto });
    } catch (e: any) { res.status(422).json({ error: `Não foi possível ler o documento: ${e?.message || e}` }); }
  });

  // Validações determinísticas (#132) — usado pelo passo 4 do wizard (preview da minuta).
  app.get("/api/contratos/:id/validar", requireAuth, (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    res.json(validarContratoParaGeracao(c));
  });

  // gate determinístico (#132): trava a geração se Σ parcelas ≠ total, datas incoerentes etc.
  const exigirDeterministicoOk: RequestHandler = (req, res, next) => {
    const id = sanitizeSegment(String((req.params as any).id || ""));
    if (!id) return res.status(400).json({ error: "ID inválido" });
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    const val = validarContratoParaGeracao(c);
    if (!val.ok) return res.status(422).json({
      error: "Contrato não passa nas validações determinísticas",
      bloqueios: val.bloqueios, avisos: val.avisos, ...(val.sugestoes ? { sugestoes: val.sugestoes } : {}),
    });
    next();
  };

  // gate de elegibilidade (#130): reavalia SEMPRE no servidor; sem elegibilidade não avança.
  const exigirElegivel: RequestHandler = async (req, res, next) => {
    const id = sanitizeSegment(String((req.params as any).id || ""));
    if (!id) return res.status(400).json({ error: "ID inválido" });
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    try {
      const snap = await avaliarElegibilidade(DATA_DIR, c.cnpj, c.objeto || c.extracao?.objeto?.valor || undefined, c.valorTotalCentavos);
      aplicarJustificativas(snap, c.elegibilidadeJustificativas);
      c.elegibilidadeSnapshot = snap; c.updatedAt = nowIso(); writeContrato(c);
      if (!snap.elegivel) return res.status(422).json({ error: "Fornecedor inelegível para contratação", elegibilidade: snap });
      next();
    } catch (e: any) {
      res.status(502).json({ error: `Falha ao avaliar elegibilidade: ${e?.message || e}` });
    }
  };

  // Elegibilidade (#130): reavalia no servidor e congela o snapshot no contrato (Seção 7).
  app.get("/api/contratos/:id/elegibilidade", requireAuth, async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    try {
      const snap = await avaliarElegibilidade(DATA_DIR, c.cnpj, c.objeto || c.extracao?.objeto?.valor || undefined, c.valorTotalCentavos);
      aplicarJustificativas(snap, c.elegibilidadeJustificativas);
      c.elegibilidadeSnapshot = snap; c.updatedAt = nowIso();
      appendTrilha(c, sessionUser(req), "avaliou_elegibilidade", `Elegibilidade: ${snap.elegivel ? "ELEGÍVEL" : "INELEGÍVEL"}`, { elegivel: snap.elegivel });
      writeContrato(c);
      res.json(snap);
    } catch (e: any) {
      res.status(502).json({ error: `Falha ao avaliar elegibilidade: ${e?.message || e}` });
    }
  });

  // Prosseguimento justificado do critério Alerta (diligência) — registra na trilha (#130).
  app.post("/api/contratos/:id/elegibilidade/justificar", writeLimiter, requireAuth, (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    const criterioId = String(req.body?.criterioId || "").trim();
    const justificativa = String(req.body?.justificativa || "").trim();
    if (!criterioId || justificativa.length < 10) return res.status(400).json({ error: "Informe o critério e uma justificativa (mínimo 10 caracteres)." });
    const aprovador = sessionUser(req);
    c.elegibilidadeJustificativas = [
      ...(c.elegibilidadeJustificativas || []).filter((j) => j.criterioId !== criterioId),
      { criterioId, justificativa, aprovador, ts: nowIso() },
    ];
    appendTrilha(c, aprovador, "justificou_elegibilidade", `Prosseguimento justificado: ${criterioId}`, { criterioId, justificativa });
    c.updatedAt = nowIso(); writeContrato(c);
    res.json({ ok: true, justificativas: c.elegibilidadeJustificativas });
  });

  // ─────────── stubs das demais sub-issues (501 documentado) ───────────
  // Extração do TR/Proposta com IA (#131) — só o TEXTO do documento vai à IA (LGPD).
  app.post("/api/contratos/:id/extrair", writeLimiter, requireAuth, exigirElegivel, docUpload.single("file"), async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });

    const tipo: "tr" | "proposta" = (req.body?.tipoDocumento === "proposta" || contrato.tipoDocumentoEntrada === "proposta") ? "proposta" : "tr";
    const user = sessionUser(req);

    // 1) texto do documento: PDF → pipeline existente; DOCX → mammoth; ou texto colado.
    let texto = "";
    let anexo: AnexoRef | undefined;
    try {
      if (req.file) {
        const ext = path.extname(req.file.originalname || "").toLowerCase();
        const nome = `entrada${ext || ".bin"}`;
        fs.mkdirSync(contratoDir(id), { recursive: true });
        const dest = path.join(contratoDir(id), nome);
        fs.writeFileSync(dest, req.file.buffer);
        anexo = { nome, tipo: "entrada", mime: req.file.mimetype, tamanho: req.file.size, adicionadoEm: nowIso() };
        if (ext === ".docx") texto = (await mammoth.extractRawText({ buffer: req.file.buffer })).value || "";
        else if (ext === ".pdf") texto = await extractTextFromFile(dest);
        else texto = req.file.buffer.toString("utf-8");
      } else if (typeof req.body?.texto === "string" && req.body.texto.trim()) {
        texto = req.body.texto;
      } else {
        return res.status(400).json({ error: "Envie o arquivo do TR/Proposta (PDF/DOCX) ou o texto." });
      }
    } catch (e: any) {
      return res.status(422).json({ error: `Não foi possível ler o documento: ${e?.message || e}` });
    }
    if (!texto.trim()) return res.status(422).json({ error: "Documento sem texto extraível (verifique o arquivo)." });

    // 2) extração via DeepSeek (NUNCA enviamos dados cadastrais nem o conteúdo dos T&C).
    const r = await extrairDados(texto, tipo, { aiClient, parseJsonSafe });
    if (anexo) { contrato.anexos = { ...(contrato.anexos || {}), entrada: anexo }; contrato.tipoDocumentoEntrada = tipo; }
    if (!r.ok || !r.extracao) {
      contrato.updatedAt = nowIso();
      appendTrilha(contrato, user, "extracao_falhou", `Extração automática falhou (${tipo})`);
      writeContrato(contrato);
      return res.status(502).json({ error: r.erro || "Falha na extração.", anexo });
    }

    contrato.extracao = r.extracao;
    contrato.updatedAt = nowIso();
    appendTrilha(contrato, user, "rodou_extracao",
      `Extração concluída (${r.extracao.lacunas.length} lacuna(s), ${r.extracao.alertas.length} alerta(s) estrutural(is))`,
      { lacunas: r.extracao.lacunas.length, alertas: r.extracao.alertas.length });
    writeContrato(contrato);
    res.json(r.extracao);
  });
  // Minuta (#129): preview HTML (passo 4) ou PDF (?formato=pdf), com rodapé em todas as páginas.
  app.get("/api/contratos/:id/minuta", requireAuth, exigirTcOk, exigirDeterministicoOk, exigirElegivel, async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const c = readContrato(id);
    if (!c) return res.status(404).json({ error: "Contrato não encontrado" });
    try {
      if (String(req.query.formato || "html").toLowerCase() === "pdf") {
        const pdf = await renderContratoPdf(c);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="minuta_${c.id}.pdf"`);
        return res.send(pdf);
      }
      res.json({ html: renderContratoHtml(c) });
    } catch (e: any) {
      res.status(500).json({ error: `Falha ao renderizar a minuta: ${e?.message || e}` });
    }
  });
  // Gera a minuta PDF + mescla o pacote (Contrato + TR + T&C) e devolve os hashes (#139).
  app.post("/api/contratos/:id/gerar-pdf", writeLimiter, requireAuth, exigirTcOk, exigirDeterministicoOk, exigirElegivel, async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });
    try {
      const minutaPdf = await renderContratoPdf(contrato);
      fs.mkdirSync(contratoDir(id), { recursive: true });
      const minutaPath = path.join(contratoDir(id), "minuta.pdf");
      fs.writeFileSync(minutaPath, minutaPdf);
      // pacote: minuta + (TR de entrada, se PDF) + T&C imutável (byte a byte)
      const partes = [minutaPath];
      const entrada = contrato.anexos?.entrada;
      if (entrada && /\.pdf$/i.test(entrada.nome)) { const ep = path.join(contratoDir(id), entrada.nome); if (fs.existsSync(ep)) partes.push(ep); }
      partes.push(TC_PATH);
      const pacotePath = path.join(contratoDir(id), "pacote.pdf");
      try { await execFileAsync("pdfunite", [...partes, pacotePath]); }
      catch { fs.writeFileSync(pacotePath, minutaPdf); }
      const pacoteBuf = fs.readFileSync(pacotePath);
      const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
      const hashMinuta = sha(minutaPdf), hashPacote = sha(pacoteBuf);
      const now = nowIso();
      contrato.anexos = { ...(contrato.anexos || {}),
        minuta: { nome: "minuta.pdf", tipo: "minuta", mime: "application/pdf", tamanho: minutaPdf.length, hash: hashMinuta, adicionadoEm: now },
        pacote: { nome: "pacote.pdf", tipo: "pacote", mime: "application/pdf", tamanho: pacoteBuf.length, hash: hashPacote, adicionadoEm: now },
      };
      Object.assign(contrato, tcSnapshot());
      if (contrato.clausulasOpcionais?.length) contrato.versaoClausulasOpcionais = VERSAO_CLAUSULAS_OPCIONAIS;
      contrato.updatedAt = now;
      appendTrilha(contrato, sessionUser(req), "gerou_pacote", `Pacote gerado (SHA-256 ${hashPacote.slice(0, 12)}…)`, { hashMinuta, hashPacote });
      writeContrato(contrato);
      await syncJira(contrato, "minuta_gerada", `Minuta gerada — ${contrato.id} · ${contrato.dadosContratada?.razaoSocial || contrato.cnpj} · ${fmtMoeda(contrato.valorTotalCentavos || 0)} · pacote SHA-256 ${hashPacote.slice(0, 16)}`);
      res.json({ hashMinuta, hashPacote });
    } catch (e: any) { res.status(500).json({ error: `Falha ao gerar o pacote: ${e?.message || e}` }); }
  });

  // Aprovação humana obrigatória (HITL, guard-rail #4) — registra quem/quando/hash (#139).
  app.post("/api/contratos/:id/aprovar", writeLimiter, requireAuth, async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });
    const hashPdf = contrato.anexos?.pacote?.hash;
    if (!hashPdf) return res.status(422).json({ error: "Gere o pacote (PDF) antes de aprovar." });
    const user = sessionUser(req);
    contrato.aprovacao = { usuario: user, ts: nowIso(), hashPdf };
    contrato.status = "aprovado";
    appendTrilha(contrato, user, "aprovou", `Aprovação humana (HITL) — pacote SHA-256 ${hashPdf.slice(0, 12)}…`);
    contrato.updatedAt = nowIso(); writeContrato(contrato);
    await syncJira(contrato, "aprovacao_interna", `Aprovação interna (HITL) por ${user} em ${contrato.aprovacao.ts} — pacote SHA-256 ${hashPdf.slice(0, 16)}`);
    res.json({ ok: true, aprovacao: contrato.aprovacao });
  });

  // Envio para assinatura (Documenso) — NENHUM caminho envia sem aprovadoPor (16.8).
  app.post("/api/contratos/:id/enviar-assinatura", writeLimiter, requireAuth, exigirTcOk, exigirDeterministicoOk, exigirElegivel, async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });
    if (!contrato.aprovacao?.usuario) return res.status(422).json({ error: "Aprovação humana obrigatória antes do envio (guard-rail HITL)." });
    const pacotePath = path.join(contratoDir(id), "pacote.pdf");
    if (!fs.existsSync(pacotePath)) return res.status(422).json({ error: "Gere o pacote (PDF) antes de enviar." });
    const repEmail = contrato.dadosContratada?.representante?.email;
    if (!repEmail) return res.status(422).json({ error: "Informe o e-mail do representante da CONTRATADA (ficha do fornecedor)." });

    const now = nowIso(); const user = sessionUser(req);
    const pacote = fs.readFileSync(pacotePath);
    if (documensoReady()) {
      try {
        const { stdout } = await execFileAsync("pdfinfo", [path.join(contratoDir(id), "minuta.pdf")]).catch(() => ({ stdout: "" }));
        const totalPaginas = parseInt(stdout.match(/Pages:\s+(\d+)/)?.[1] || "1", 10);
        const env = await enviarContratoParaAssinatura({
          titulo: `Contrato ${contrato.id} — ${contrato.dadosContratada?.razaoSocial || contrato.cnpj}`,
          pdf: pacote, totalPaginas, externalId: contrato.id,
          aprovadores: aprovadoresContrato(),
          signatarios: [
            { name: "Geraldo dos Santos Barros", email: process.env.CONTRATOS_DIRETOR_EMAIL || "geraldo@casahacker.org" },
            { name: contrato.dadosContratada?.representante?.nome || contrato.dadosContratada?.razaoSocial || "CONTRATADA", email: repEmail },
          ],
          cc: { name: "Jurídico — Casa Hacker", email: process.env.CONTRATOS_CC_EMAIL || "juridico@casahacker.org" },
        });
        contrato.documenso = { documentId: env.documentId, status: "PENDING", enviadoEm: now, host: documensoHost() };
        contrato.status = "enviado_assinatura";
        appendTrilha(contrato, user, "enviou_assinatura", `Enviado ao Documenso (doc ${env.documentId})`, { documentId: env.documentId });
        contrato.updatedAt = now; writeContrato(contrato);
        await syncJira(contrato, "envio_assinatura", `Enviado para assinatura via Documenso (doc ${env.documentId}) — ${contrato.id}`);
        return res.json({ ok: true, documenso: contrato.documenso });
      } catch (e: any) {
        contrato.documenso = { fallback: true, enviadoEm: now, host: documensoHost(), status: `falha: ${e?.message || e}` };
        contrato.status = "enviado_assinatura";
        appendTrilha(contrato, user, "enviou_assinatura_manual", `Documenso indisponível — baixar pacote p/ envio manual (${e?.message || e})`);
        contrato.updatedAt = now; writeContrato(contrato);
        return res.json({ ok: true, fallback: true, error: e?.message || String(e) });
      }
    }
    contrato.documenso = { fallback: true, enviadoEm: now, host: documensoHost() };
    contrato.status = "enviado_assinatura";
    appendTrilha(contrato, user, "enviou_assinatura_manual", "Documenso não configurado — baixar pacote para envio manual.");
    contrato.updatedAt = now; writeContrato(contrato);
    await syncJira(contrato, "envio_assinatura", `Pacote pronto para assinatura (envio manual) — ${contrato.id}`);
    res.json({ ok: true, fallback: true });
  });

  // Verifica o status no Documenso; quando concluído, baixa o assinado e marca o contrato (#139/#140).
  app.get("/api/contratos/:id/assinatura/status", requireAuth, async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });
    const docId = contrato.documenso?.documentId;
    if (!docId) return res.json({ status: contrato.documenso?.fallback ? "manual" : "—", contrato: contrato.status });
    const st = await statusDocumento(docId);
    await concluirAssinatura(contrato, sessionUser(req), st);
    res.json({ status: st, contrato: contrato.status });
  });

  // Webhook do Documenso (#156): conclui a assinatura SEM polling. Protegido por segredo
  // (DOCUMENSO_WEBHOOK_SECRET) no header X-Documenso-Secret ou em ?secret=. Server-to-server
  // (sem requireAuth), idempotente. Eventos que não sejam de conclusão são só reconhecidos.
  app.post("/api/contratos/webhooks/documenso", writeLimiter, async (req: any, res) => {
    const segredo = process.env.DOCUMENSO_WEBHOOK_SECRET || "";
    if (!segredo) return res.status(503).json({ error: "Webhook não configurado (DOCUMENSO_WEBHOOK_SECRET ausente)." });
    const recebido = String(req.headers["x-documenso-secret"] || req.query.secret || "");
    if (recebido !== segredo) return res.status(401).json({ error: "Segredo inválido" });

    const body = req.body || {};
    const evento = String(body.event || body.type || "");
    const p = body.payload || body.data || body.document || body;
    const externalId = p?.externalId || body?.externalId;
    const documentId = Number(p?.id ?? p?.documentId ?? body?.documentId) || 0;

    // localiza o contrato pelo externalId (== contrato.id) ou pelo documentId do Documenso.
    let contrato: Contrato | null = externalId ? readContrato(sanitizeSegment(String(externalId)) || "") : null;
    if (!contrato && documentId) contrato = listContratos().find((c) => c.documenso?.documentId === documentId) || null;
    if (!contrato) return res.json({ ok: true, ignored: "contrato não localizado para o evento" });

    if (/COMPLET/i.test(evento) || /COMPLET/i.test(String(p?.status))) {
      try { await concluirAssinatura(contrato, "documenso-webhook"); }
      catch (e: any) { return res.status(500).json({ error: `Falha ao concluir a assinatura: ${e?.message || e}` }); }
    }
    res.json({ ok: true, contrato: contrato.status });
  });

  // Reenvio manual da sincronização Jira (#140) — best-effort, visível no detalhe.
  app.post("/api/contratos/:id/jira/reenviar", writeLimiter, requireAuth, async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });
    if (!contrato.jira?.issueKey) return res.status(422).json({ error: "Contrato sem issue Jira vinculada." });
    if (!jiraSyncLigado()) return res.status(422).json({ error: "Sincronização Jira desligada (JIRA_SYNC=0)." });
    await syncJira(contrato, "reenvio", `Resumo do contrato ${contrato.id} — status ${contrato.status} · ${contrato.dadosContratada?.razaoSocial || contrato.cnpj} · ${fmtMoeda(contrato.valorTotalCentavos || 0)}`);
    const assinadoPath = path.join(contratoDir(id), "assinado.pdf");
    if (fs.existsSync(assinadoPath)) {
      const ar = await anexarIssue(contrato.jira.issueKey, `${contrato.id}-assinado.pdf`, fs.readFileSync(assinadoPath));
      appendTrilha(contrato, "sistema", ar.ok ? "jira_anexo" : "jira_anexo_falhou", `Reenvio do anexo: Jira ${ar.ok ? "ok" : `falhou (${ar.erro})`}`);
      writeContrato(contrato);
    }
    res.json({ ok: true, jiraSync: contrato.jiraSync });
  });
  // ── Aditivos (#137) ───────────────────────────────────────────────────────────
  app.get("/api/contratos/:id/aditivos", requireAuth, (req, res) => {
    const id = idParam(req, res); if (!id) return;
    if (!readContrato(id)) return res.status(404).json({ error: "Contrato não encontrado" });
    res.json(listAditivos(id));
  });

  app.get("/api/contratos/:id/aditivos/:aid/minuta", requireAuth, exigirTcOk, async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const aid = sanitizeSegment(String(req.params.aid || "")); if (!aid) return res.status(400).json({ error: "ID inválido" });
    const contrato = readContrato(id); const aditivo = readAditivo(id, aid);
    if (!contrato || !aditivo) return res.status(404).json({ error: "Aditivo não encontrado" });
    try {
      if (String(req.query.formato || "html").toLowerCase() === "pdf") {
        const pdf = await renderAditivoPdf(contrato, aditivo);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="aditivo_${aditivo.id}.pdf"`);
        return res.send(pdf);
      }
      res.json({ html: renderAditivoHtml(contrato, aditivo) });
    } catch (e: any) { res.status(500).json({ error: `Falha ao renderizar o aditivo: ${e?.message || e}` }); }
  });

  app.post("/api/contratos/:id/aditivos", writeLimiter, requireAuth, docUpload.single("file"), async (req: any, res) => {
    const id = idParam(req, res); if (!id) return;
    const contrato = readContrato(id);
    if (!contrato) return res.status(404).json({ error: "Contrato não encontrado" });

    let raw: any;
    if (req.file) { try { raw = JSON.parse(req.body?.payload || "{}"); } catch { return res.status(400).json({ error: "Campo payload (JSON) inválido." }); } }
    else raw = req.body;
    let body: z.infer<typeof aditivoSchema>;
    try { body = aditivoSchema.parse(raw); } catch (e) { return res.status(400).json(zodError(e)); }

    // só sobre contrato assinado (ou enviado_assinatura com confirmação explícita)
    if (contrato.status !== "assinado" && !(contrato.status === "enviado_assinatura" && body.confirmarSemAssinatura)) {
      return res.status(422).json({ error: `Aditivo só sobre contrato assinado (status atual: ${contrato.status}).` });
    }

    // Jira do aditivo (próprio ou herdado do contrato-mãe)
    const jkey = body.jiraIssueKey || contrato.jira?.issueKey;
    if (!jkey) return res.status(422).json({ error: "Vincule uma issue do projeto JUR ao aditivo." });
    const rj = await resolverVinculoJira(jkey);
    if (rj.erroBody) return res.status(rj.erroStatus || 502).json(rj.erroBody);

    // gate de elegibilidade REAVALIADO na data do aditivo
    const valorRef = body.valorNovoCentavos ?? contrato.valorTotalCentavos;
    const snap = await avaliarElegibilidade(DATA_DIR, contrato.cnpj, contrato.objeto || contrato.extracao?.objeto?.valor || undefined, valorRef);
    aplicarJustificativas(snap, contrato.elegibilidadeJustificativas);
    if (!snap.elegivel) return res.status(422).json({ error: "Fornecedor inelegível na data do aditivo.", elegibilidade: snap });

    // validações determinísticas por tipo
    if (body.tipo === "prorrogacao") {
      if (!body.vigenciaNovaFim) return res.status(400).json({ error: "Informe a nova data de fim da vigência." });
      if (contrato.vigenciaFim && body.vigenciaNovaFim <= String(contrato.vigenciaFim).slice(0, 10)) return res.status(422).json({ error: "A nova vigência deve ser posterior à atual." });
    } else if (body.tipo === "valor_parcelas") {
      if (!body.valorNovoCentavos) return res.status(400).json({ error: "Informe o novo valor total." });
      if (body.parcelasNovas?.length && somaParcelasCentavos(body.parcelasNovas) !== body.valorNovoCentavos) return res.status(422).json({ error: "A soma das novas parcelas difere do novo valor total." });
    } else if (body.tipo === "escopo") {
      if (!body.escopoNovo && !req.file) return res.status(400).json({ error: "Informe o novo escopo ou anexe o novo Termo de Referência." });
    } else if (body.tipo === "dados_cadastrais") {
      if (!body.dadosCadastraisNovos || !Object.keys(body.dadosCadastraisNovos).length) return res.status(400).json({ error: "Informe os dados cadastrais a atualizar." });
    }

    const user = sessionUser(req);
    const aid = allocId("AD");
    const now = nowIso();
    const aditivo: Aditivo = {
      id: aid, contratoId: contrato.id, numeroOrdinal: (contrato.aditivos?.length || 0) + 1,
      tipo: body.tipo, status: "rascunho",
      jira: { issueKey: jkey.toUpperCase(), ...(rj.jira || {}) },
      ...(body.descricao ? { descricao: body.descricao } : {}),
      ...(body.vigenciaNovaFim ? { vigenciaNovaFim: body.vigenciaNovaFim } : {}),
      ...(body.valorNovoCentavos != null ? { valorNovoCentavos: body.valorNovoCentavos } : {}),
      ...(body.parcelasNovas ? { parcelasNovas: body.parcelasNovas as Parcela[] } : {}),
      ...(body.escopoNovo ? { escopoNovo: body.escopoNovo } : {}),
      ...(body.dadosCadastraisNovos ? { dadosCadastraisNovos: body.dadosCadastraisNovos as Partial<DadosContratada> } : {}),
      elegibilidadeSnapshot: snap, ...tcSnapshot(),
      trilha: [], createdAt: now, createdBy: user, updatedAt: now,
    };
    if (body.tipo === "valor_parcelas" && contrato.valorTotalCentavos) {
      aditivo.variacaoPercentual = +(((body.valorNovoCentavos! - contrato.valorTotalCentavos) / contrato.valorTotalCentavos) * 100).toFixed(2);
    }
    // escopo: anexa o novo TR + roda a extração (completude estrutural) — best-effort
    if (body.tipo === "escopo" && req.file) {
      try {
        const ext = path.extname(req.file.originalname || "").toLowerCase();
        const nome = `aditivo-${aid}-tr${ext || ".bin"}`;
        fs.mkdirSync(contratoDir(id), { recursive: true });
        fs.writeFileSync(path.join(contratoDir(id), nome), req.file.buffer);
        let texto = "";
        if (ext === ".docx") texto = (await mammoth.extractRawText({ buffer: req.file.buffer })).value || "";
        else if (ext === ".pdf") texto = await extractTextFromFile(path.join(contratoDir(id), nome));
        else texto = req.file.buffer.toString("utf-8");
        const r = await extrairDados(texto, "tr", { aiClient, parseJsonSafe });
        if (r.ok && r.extracao) aditivo.extracao = r.extracao;
        aditivo.anexos = { entrada: { nome, tipo: "entrada", mime: req.file.mimetype, tamanho: req.file.size, adicionadoEm: now } };
      } catch { /* extração do novo TR é best-effort */ }
    }

    appendTrilha(aditivo, user, "criou_aditivo", `Aditivo de ${body.tipo} (${aditivo.numeroOrdinal}º)`);
    writeAditivo(id, aditivo);
    contrato.aditivos = [...(contrato.aditivos || []), aid];
    contrato.updatedAt = now;
    appendTrilha(contrato, user, "criou_aditivo", `Aditivo ${aid} (${body.tipo})`, { aditivoId: aid, tipo: body.tipo });
    writeContrato(contrato);
    res.status(201).json(aditivo);
  });
}
