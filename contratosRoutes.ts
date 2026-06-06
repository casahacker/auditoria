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
import { z } from "zod";
import type { Contrato, ContratoStatus, EventoTrilha, JiraVinculo } from "./src/contratos/contratosTypes";
import { resumoDoContrato } from "./src/contratos/contratosTypes";
import { verificarTc, tcStatus } from "./src/contratos/termosCondicoes";
import { validarIssue, HTTP_POR_MOTIVO } from "./src/contratos/jiraClient";

export interface ContratosCtx {
  DATA_DIR: string;
  requireAuth: RequestHandler;
  sanitizeSegment: (s: string) => string | null;
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
  prorrogavel: z.boolean(),
  prorrogacaoMaxMeses: z.number().int().nonnegative(),
  valorTotalCentavos: z.number().int().nonnegative(),
  parcelas: z.array(parcelaSchema),
  condicoesPagamento: z.string(),
  sla: z.string(),
  localExecucao: z.string(),
  equipamentosFornecidosPelaContratante: z.string(),
}).partial();

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
  const { DATA_DIR, requireAuth, sanitizeSegment } = ctx;
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

  // ── trilha append-only (helper reaproveitável pelas demais issues) ─────────────
  const appendTrilha = (
    c: { trilha: EventoTrilha[] }, usuario: string, acao: string,
    resumo?: string, meta?: Record<string, any>,
  ) => {
    if (!Array.isArray(c.trilha)) c.trilha = [];
    c.trilha.push({ ts: nowIso(), usuario, acao, ...(resumo ? { resumo } : {}), ...(meta ? { meta } : {}) });
  };

  // ── rate limit (padrão da suíte) ───────────────────────────────────────────────
  const writeLimiter = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
    message: { error: "Muitas requisições. Aguarde 1 minuto." },
  });

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
    let rows = listContratos();
    if (fCnpj) rows = rows.filter((c) => c.cnpj === fCnpj);
    if (fStatus) rows = rows.filter((c) => c.status === fStatus);
    if (fAno) rows = rows.filter((c) => c.id.includes(`-${fAno}-`));
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

  // ─────────── stubs das demais sub-issues (501 documentado) ───────────
  app.get("/api/contratos/:id/elegibilidade", requireAuth, naoImplementado("#130", "Gate de elegibilidade no servidor"));
  app.post("/api/contratos/:id/extrair", writeLimiter, requireAuth, naoImplementado("#131", "Extração de dados do TR/Proposta (IA)"));
  app.get("/api/contratos/:id/minuta", requireAuth, exigirTcOk, naoImplementado("#129", "Render da minuta (HTML/PDF)"));
  app.post("/api/contratos/:id/aprovar", writeLimiter, requireAuth, naoImplementado("#139", "Aprovação humana (HITL)"));
  app.post("/api/contratos/:id/enviar-assinatura", writeLimiter, requireAuth, exigirTcOk, naoImplementado("#139", "Envio para assinatura (Documenso)"));
  app.get("/api/contratos/:id/aditivos", requireAuth, naoImplementado("#137", "Lista de aditivos"));
  app.post("/api/contratos/:id/aditivos", writeLimiter, requireAuth, naoImplementado("#137", "Criação de termo aditivo"));
}
