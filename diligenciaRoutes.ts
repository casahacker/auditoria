/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Diligência de Fornecedores (Tool C) — backend.
 *
 * Para um CNPJ: consulta a Receita (BrasilAPI) + listas de restrição do Portal da
 * Transparência (CEIS, CNEP, CEPIM, Acordos de Leniência) e gera um relatório de
 * diligência auditável e exportável (PDF). Cada consulta é registrada com data-hora,
 * IP, APIs e metadados verificáveis; a diligência tem validade de 1 mês (cache).
 *
 * Persistência: DATA_DIR/diligencia/{cnpj}.json
 * Base de fornecedores: agregada de DATA_DIR/audits/<id>/result.json + DATA_DIR/feac/<id>/record.json
 *
 * Observação técnica: o filtro por CNPJ da API do Portal da Transparência é inoperante
 * (retorna a lista inteira); o filtro por NOME (nomeSancionado) funciona — então
 * consultamos por razão social e filtramos os resultados pelo CNPJ exato.
 */
import type { Express, RequestHandler } from "express";
import path from "path";
import fs from "fs";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { fileURLToPath } from "url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(APP_DIR, "assets");
const PT_BASE = "https://api.portaldatransparencia.gov.br/api-de-dados/";
const VALIDADE_DIAS = 30;

export interface DiligenciaCtx {
  DATA_DIR: string;
  requireAuth: RequestHandler;
  sanitizeSegment: (s: string) => string | null;
}

function onlyDigits(s: any): string { return String(s ?? "").replace(/\D/g, ""); }
function formatCnpjMask(d?: string): string {
  const x = onlyDigits(d);
  if (x.length === 14) return `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}`;
  if (x.length === 11) return `${x.slice(0, 3)}.${x.slice(3, 6)}.${x.slice(6, 9)}-${x.slice(9)}`;
  return d || "";
}
function reqIp(req: any): string {
  const xff = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || req.ip || "desconhecido";
}
const PT_HEADERS = () => ({
  "Accept": "application/json",
  "User-Agent": "StackAudit/1.0 (+https://stack-audit.casahacker.org)",
  "chave-api-dados": process.env.PORTAL_TRANSPARENCIA_KEY || "",
});
const HTTP_HEADERS = { "Accept": "application/json", "User-Agent": "StackAudit/1.0 (+https://stack-audit.casahacker.org)" };

// ── external lookups ──────────────────────────────────────────────────────────

export async function fetchReceita(cnpj: string): Promise<any> {
  // BrasilAPI primary, ReceitaWS fallback
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      return {
        fonte: "BrasilAPI", fetchedAt: new Date().toISOString(),
        razao_social: d.razao_social, nome_fantasia: d.nome_fantasia,
        situacao_cadastral: d.descricao_situacao_cadastral, data_situacao: d.data_situacao_cadastral,
        natureza_juridica: d.natureza_juridica, porte: d.porte, abertura: d.data_inicio_atividade,
        municipio: d.municipio, uf: d.uf, cep: d.cep, logradouro: d.logradouro, numero: d.numero, bairro: d.bairro,
        cnae_principal: d.cnae_fiscal ? `${d.cnae_fiscal} - ${d.cnae_fiscal_descricao}` : "",
        qsa: Array.isArray(d.qsa) ? d.qsa.map((s: any) => ({ nome: s.nome_socio, qual: s.qualificacao_socio })) : [],
      };
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      return {
        fonte: "ReceitaWS", fetchedAt: new Date().toISOString(),
        razao_social: d.nome, nome_fantasia: d.fantasia, situacao_cadastral: d.situacao, data_situacao: d.data_situacao,
        natureza_juridica: d.natureza_juridica, porte: d.porte, abertura: d.abertura, municipio: d.municipio, uf: d.uf, cep: d.cep,
        cnae_principal: Array.isArray(d.atividade_principal) && d.atividade_principal[0] ? `${d.atividade_principal[0].code} - ${d.atividade_principal[0].text}` : "",
        qsa: Array.isArray(d.qsa) ? d.qsa.map((s: any) => ({ nome: s.nome, qual: s.qual })) : [],
      };
    }
  } catch { /* */ }
  return null;
}

function recordMatchesCnpj(x: any, cnpjDigits: string): boolean {
  const fields = [x?.pessoa?.cnpjFormatado, x?.pessoa?.numeroInscricaoSocial, x?.cnpjFormatado, x?.cnpj].filter(Boolean);
  if (fields.some((f: any) => onlyDigits(f) === cnpjDigits)) return true;
  return onlyDigits(JSON.stringify(x || {})).includes(cnpjDigits);
}

/** Query a Portal da Transparência sanctions list by name, then keep only exact-CNPJ matches. */
export async function consultaPT(recurso: string, label: string, razaoSocial: string, cnpjDigits: string): Promise<any> {
  const url = `${PT_BASE}${recurso}?nomeSancionado=${encodeURIComponent(razaoSocial)}&pagina=1`;
  const consultaPublica: Record<string, string> = {
    ceis: "https://portaldatransparencia.gov.br/sancoes/ceis",
    cnep: "https://portaldatransparencia.gov.br/sancoes/cnep",
    cepim: "https://portaldatransparencia.gov.br/sancoes/cepim",
    "acordos-leniencia": "https://portaldatransparencia.gov.br/acordos-leniencia",
  };
  if (!process.env.PORTAL_TRANSPARENCIA_KEY) {
    return { fonte: label, recurso, status: "PENDENTE", hits: [], url: consultaPublica[recurso], fetchedAt: new Date().toISOString(), erro: "Chave da API não configurada" };
  }
  try {
    const r = await fetch(url, { headers: PT_HEADERS(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { fonte: label, recurso, status: "ERRO", http: r.status, hits: [], url: consultaPublica[recurso], fetchedAt: new Date().toISOString() };
    const arr = await r.json();
    const hits = (Array.isArray(arr) ? arr : []).filter((x: any) => recordMatchesCnpj(x, cnpjDigits)).map((x: any) => ({
      tipo: x.tipoSancao?.descricaoResumida || x.tipoSancao?.descricaoPortal || (typeof x.tipoSancao === "string" ? x.tipoSancao : "") || "Sanção",
      orgao: x.orgaoSancionador?.nome || x.orgaoSancionador?.siglaUf || "",
      dataInicio: x.dataInicioSancao || "", dataFim: x.dataFimSancao || "",
      fundamentacao: Array.isArray(x.fundamentacao) ? x.fundamentacao.map((f: any) => f.descricao || f.descricaoResumida).filter(Boolean).join("; ") : "",
      processo: x.numeroProcesso || "",
      nome: x.pessoa?.razaoSocialReceita || x.pessoa?.nome || "",
    }));
    return { fonte: label, recurso, status: hits.length ? "CONSTA" : "NADA_CONSTA", hits, url: consultaPublica[recurso], fetchedAt: new Date().toISOString(), apiUrl: url };
  } catch (e: any) {
    return { fonte: label, recurso, status: "ERRO", erro: e.message, hits: [], url: consultaPublica[recurso], fetchedAt: new Date().toISOString() };
  }
}

const FONTES_COMPLEMENTARES = [
  { fonte: "Lista Suja do Trabalho Escravo (MTE)", url: "https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/areas-de-atuacao/combate-ao-trabalho-escravo-e-analogo-ao-de-escravo", obs: "Verificação manual (download bloqueado para acesso automatizado)." },
  { fonte: "IBAMA — Autuações e Áreas Embargadas", url: "https://servicos.ibama.gov.br/ctf/publico/areasembargadas/ConsultaPublicaAreasEmbargadas.php", obs: "Verificação manual — relevante para serviços ambientais." },
  { fonte: "TCU — Consulta Consolidada de PJ (inidôneos/CNJ improbidade)", url: "https://contas.tcu.gov.br/ords/f?p=1660:3", obs: "Verificação manual (consulta web, sem API)." },
];

// ── supplier base (from past prestações) ──────────────────────────────────────

function collectSuppliers(DATA_DIR: string): any[] {
  const map = new Map<string, any>();
  const add = (taxId: string, nome: string, origem: string) => {
    const d = onlyDigits(taxId);
    if (d.length !== 14) return; // diligência por CNPJ
    const cur = map.get(d) || { cnpj: d, nome: "", origens: new Set<string>(), ocorrencias: 0 };
    if (nome && (!cur.nome || nome.length > cur.nome.length)) cur.nome = nome;
    cur.origens.add(origem);
    cur.ocorrencias++;
    map.set(d, cur);
  };
  const audits = path.join(DATA_DIR, "audits");
  if (fs.existsSync(audits)) for (const id of fs.readdirSync(audits)) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(audits, id, "result.json"), "utf-8"));
      for (const it of a.items || []) add(it.taxId, it.entity, "Auditoria");
    } catch { /* skip */ }
  }
  const feac = path.join(DATA_DIR, "feac");
  if (fs.existsSync(feac)) for (const id of fs.readdirSync(feac)) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(feac, id, "record.json"), "utf-8"));
      for (const l of r.lancamentos || []) add(l.taxId, l.razaoSocial || l.fornecedor, "FEAC");
    } catch { /* skip */ }
  }
  return [...map.values()].map(s => ({ cnpj: s.cnpj, cnpjFormatado: formatCnpjMask(s.cnpj), nome: s.nome, origens: [...s.origens], ocorrencias: s.ocorrencias }))
    .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
}

// ── PDF report ────────────────────────────────────────────────────────────────

function wrap(font: any, text: string, size: number, maxW: number): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

async function buildDiligenciaPdf(rec: any): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await embed(doc, "IBMPlexSans-Regular.ttf", StandardFonts.Helvetica);
  const bold = await embed(doc, "IBMPlexSans-Bold.ttf", StandardFonts.HelveticaBold);
  const PW = 595.28, PH = 841.89, M = 44;
  let page = doc.addPage([PW, PH]);
  let y = PH - M;
  const ink = rgb(0.1, 0.1, 0.1), gray = rgb(0.4, 0.4, 0.4), red = rgb(0.78, 0.12, 0.16), green = rgb(0.1, 0.5, 0.22);
  const ensure = (h: number) => { if (y - h < M + 30) { foot(); page = doc.addPage([PW, PH]); y = PH - M; } };
  const text = (t: string, opts: any = {}) => {
    const size = opts.size || 9, f = opts.bold ? bold : font, color = opts.color || ink;
    for (const ln of wrap(f, t, size, PW - 2 * M)) { ensure(size + 3); page.drawText(ln, { x: M + (opts.indent || 0), y: y - size, size, font: f, color }); y -= size + 3; }
  };
  const gap = (n = 6) => { y -= n; };
  const foot = () => {
    page.drawLine({ start: { x: M, y: M - 6 }, end: { x: PW - M, y: M - 6 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    page.drawText("Stack Audit™ · Associação Casa Hacker · documento gerado automaticamente para fins de diligência", { x: M, y: M - 16, size: 6.5, font, color: gray });
  };

  text("RELATÓRIO DE DILIGÊNCIA DE FORNECEDOR", { size: 15, bold: true });
  gap(2);
  text(`${rec.razaoSocial || "—"}  ·  CNPJ ${formatCnpjMask(rec.cnpj)}`, { size: 11, bold: true });
  gap(4);
  const vColor = rec.verdict === "ALERTA" ? red : rec.verdict === "NADA_CONSTA" ? green : gray;
  const vLabel = rec.verdict === "ALERTA" ? "ALERTA — RESTRIÇÕES/IRREGULARIDADES ENCONTRADAS" : rec.verdict === "NADA_CONSTA" ? "NADA CONSTA nas fontes automatizadas" : "PENDENTE — verificação incompleta";
  text(`Resultado: ${vLabel}`, { size: 11, bold: true, color: vColor });
  gap(8);

  // audit metadata
  text("DADOS DA CONSULTA (auditável)", { size: 10, bold: true });
  text(`Data/hora: ${new Date(rec.checkedAt).toLocaleString("pt-BR")}`, { indent: 8 });
  text(`Validade: ${new Date(rec.validUntil).toLocaleDateString("pt-BR")} (30 dias)`, { indent: 8 });
  text(`Solicitante: ${rec.checkedBy || "—"}  ·  IP: ${rec.ip || "—"}`, { indent: 8 });
  text(`APIs/fontes: ${(rec.metadata?.apis || []).join("  |  ")}`, { indent: 8, size: 7.5, color: gray });
  gap(8);

  // receita
  const rf = rec.receita;
  text("RECEITA FEDERAL (situação cadastral)", { size: 10, bold: true });
  if (rf) {
    const sitColor = /ATIVA/i.test(rf.situacao_cadastral || "") ? green : red;
    text(`Situação: ${rf.situacao_cadastral || "—"}`, { indent: 8, bold: true, color: sitColor });
    text(`Natureza: ${rf.natureza_juridica || "—"}  ·  Porte: ${rf.porte || "—"}  ·  Abertura: ${rf.abertura || "—"}`, { indent: 8 });
    text(`CNAE principal: ${rf.cnae_principal || "—"}`, { indent: 8 });
    text(`Município: ${rf.municipio || "—"}/${rf.uf || "—"}`, { indent: 8 });
    if (rf.qsa?.length) text(`Quadro societário: ${rf.qsa.map((s: any) => `${s.nome} (${s.qual})`).join("; ")}`, { indent: 8, size: 8 });
    text(`Fonte: ${rf.fonte} · ${new Date(rf.fetchedAt).toLocaleString("pt-BR")}`, { indent: 8, size: 7, color: gray });
  } else { text("Não foi possível obter os dados cadastrais.", { indent: 8, color: red }); }
  gap(8);

  // sanções
  text("LISTAS DE RESTRIÇÃO — PORTAL DA TRANSPARÊNCIA (CGU)", { size: 10, bold: true });
  for (const s of rec.sancoes || []) {
    const c = s.status === "CONSTA" ? red : s.status === "NADA_CONSTA" ? green : gray;
    text(`${s.fonte}: ${s.status === "CONSTA" ? "CONSTA (" + s.hits.length + ")" : s.status === "NADA_CONSTA" ? "Nada consta" : s.status}`, { indent: 8, bold: true, color: c });
    for (const h of s.hits || []) {
      text(`• ${h.tipo} — ${h.orgao}`, { indent: 18, size: 8 });
      if (h.fundamentacao) text(`  ${h.fundamentacao}`, { indent: 24, size: 7.5, color: gray });
      text(`  Vigência: ${h.dataInicio || "?"} a ${h.dataFim || "?"}  ·  Processo: ${h.processo || "—"}`, { indent: 24, size: 7.5, color: gray });
    }
  }
  gap(8);

  // complementares
  text("FONTES COMPLEMENTARES (verificação manual)", { size: 10, bold: true });
  for (const f of rec.fontesComplementares || FONTES_COMPLEMENTARES) {
    text(`• ${f.fonte}`, { indent: 8, size: 8.5 });
    text(`  ${f.url}`, { indent: 14, size: 7, color: gray });
  }
  foot();
  return Buffer.from(await doc.save());
}
async function embed(doc: any, file: string, fb: any) {
  try { return await doc.embedFont(fs.readFileSync(path.join(ASSETS_DIR, file)), { subset: true }); }
  catch { return await doc.embedFont(fb); }
}

// ── route registration ────────────────────────────────────────────────────────

export function registerDiligenciaRoutes(app: Express, ctx: DiligenciaCtx) {
  const { DATA_DIR, requireAuth, sanitizeSegment } = ctx;
  const DIL_DIR = path.join(DATA_DIR, "diligencia");
  fs.mkdirSync(DIL_DIR, { recursive: true });
  const recPath = (cnpj: string) => path.join(DIL_DIR, `${cnpj}.json`);
  const readRec = (cnpj: string): any | null => { try { return JSON.parse(fs.readFileSync(recPath(cnpj), "utf-8")); } catch { return null; } };
  const isValid = (rec: any) => rec && rec.validUntil && new Date(rec.validUntil).getTime() > Date.now();

  // base de fornecedores das prestações já realizadas
  app.get("/api/diligencia/suppliers", requireAuth, (_req, res) => {
    const suppliers = collectSuppliers(DATA_DIR);
    for (const s of suppliers) { const r = readRec(s.cnpj); s.diligencia = r ? { checkedAt: r.checkedAt, validUntil: r.validUntil, verdict: r.verdict, valida: isValid(r) } : null; }
    res.json(suppliers);
  });

  // histórico de diligências salvas
  app.get("/api/diligencia", requireAuth, (_req, res) => {
    const out: any[] = [];
    for (const f of fs.existsSync(DIL_DIR) ? fs.readdirSync(DIL_DIR) : []) {
      if (!f.endsWith(".json")) continue;
      try { const r = JSON.parse(fs.readFileSync(path.join(DIL_DIR, f), "utf-8")); out.push({ cnpj: r.cnpj, razaoSocial: r.razaoSocial, verdict: r.verdict, checkedAt: r.checkedAt, validUntil: r.validUntil, valida: isValid(r) }); } catch { /* */ }
    }
    out.sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)));
    res.json(out);
  });

  // detalhe de uma diligência salva
  app.get("/api/diligencia/:cnpj", requireAuth, (req: any, res) => {
    const cnpj = onlyDigits(sanitizeSegment(req.params.cnpj as string) || "");
    if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ inválido" });
    const r = readRec(cnpj);
    if (!r) return res.status(404).json({ error: "Diligência não encontrada" });
    res.json({ ...r, valida: isValid(r) });
  });

  // executar diligência (usa cache de 30 dias salvo force=1)
  app.post("/api/diligencia/:cnpj/check", requireAuth, async (req: any, res) => {
    const cnpj = onlyDigits(sanitizeSegment(req.params.cnpj as string) || "");
    if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ deve ter 14 dígitos" });
    const force = String(req.query.force || "") === "1";
    const cached = readRec(cnpj);
    if (cached && isValid(cached) && !force) return res.json({ ...cached, valida: true, fromCache: true });

    const receita = await fetchReceita(cnpj);
    const razao = receita?.razao_social || cached?.razaoSocial || "";
    const apis: string[] = [];
    if (receita) apis.push(`${receita.fonte} (CNPJ)`);
    let sancoes: any[] = [];
    if (razao) {
      sancoes = await Promise.all([
        consultaPT("ceis", "CEIS — Inidôneas e Suspensas", razao, cnpj),
        consultaPT("cnep", "CNEP — Empresas Punidas (Lei Anticorrupção)", razao, cnpj),
        consultaPT("cepim", "CEPIM — Entidades sem fins lucrativos impedidas", razao, cnpj),
        consultaPT("acordos-leniencia", "Acordos de Leniência", razao, cnpj),
      ]);
      apis.push("Portal da Transparência/CGU (CEIS, CNEP, CEPIM, Leniência) por nome + filtro de CNPJ");
    }
    const anySancao = sancoes.some(s => s.status === "CONSTA");
    const receitaInativa = receita && !/ATIVA/i.test(receita.situacao_cadastral || "");
    const erro = !receita || sancoes.some(s => s.status === "ERRO" || s.status === "PENDENTE");
    const verdict = anySancao || receitaInativa ? "ALERTA" : (erro && !razao ? "PENDENTE" : "NADA_CONSTA");

    const now = new Date();
    const rec = {
      cnpj, razaoSocial: razao || "—", nomeFantasia: receita?.nome_fantasia || "",
      checkedAt: now.toISOString(), validUntil: new Date(now.getTime() + VALIDADE_DIAS * 86400000).toISOString(),
      checkedBy: req.user?.email || "—", ip: reqIp(req),
      receita, sancoes, fontesComplementares: FONTES_COMPLEMENTARES, verdict,
      metadata: { apis, userAgent: String(req.headers["user-agent"] || ""), geradoEm: now.toISOString() },
    };
    fs.writeFileSync(recPath(cnpj), JSON.stringify(rec, null, 2));
    res.json({ ...rec, valida: true, fromCache: false });
  });

  // PDF auditável
  app.get("/api/diligencia/:cnpj/pdf", requireAuth, async (req: any, res) => {
    const cnpj = onlyDigits(sanitizeSegment(req.params.cnpj as string) || "");
    if (cnpj.length !== 14) return res.status(400).json({ error: "CNPJ inválido" });
    const rec = readRec(cnpj);
    if (!rec) return res.status(404).json({ error: "Execute a diligência primeiro" });
    try {
      const buf = await buildDiligenciaPdf(rec);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="diligencia_${cnpj}.pdf"; filename*=UTF-8''diligencia_${cnpj}.pdf`);
      res.setHeader("Content-Length", buf.length);
      res.send(buf);
    } catch (e: any) { res.status(500).json({ error: "Falha ao gerar PDF: " + e.message }); }
  });

  console.log("[Diligência] routes registered (/api/diligencia)");
}
