/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * FEAC / SGPP — Processador de Prestação de Contas (Tool B) — backend routes.
 *
 * Registered onto the existing Express app by server.ts via registerFeacRoutes(app, ctx).
 * Reuses server.ts helpers through `ctx` (no circular import): extractTextFromFile,
 * parseJsonSafe, slugify, aiClient (DeepSeek), sanitizeSegment, execFileAsync.
 *
 * Persistence mirrors the audits store:  DATA_DIR/feac/{id}/
 *   record.json  notas.pdf  comprovantes.pdf  extrato.pdf  fluxo.xlsx
 *   notas.txt comprovantes.txt extrato.txt   (cached extracted text)
 *   treated/{lancamentoId}.pdf  declaracao_rateio.pdf  fluxo_atualizado.xlsx  documentos.zip
 *
 * Data shapes mirror src/feac/feacTypes.ts but are handled as plain objects here,
 * matching server.ts's existing `any`-shaped convention.
 */
import type { Express, RequestHandler, Response } from "express";
import type OpenAI from "openai";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "node:crypto";
import * as XLSX from "xlsx";
import { PDFDocument, rgb, degrees, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import archiver from "archiver";
import { fileURLToPath } from "url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(APP_DIR, "assets");

export interface FeacCtx {
  DATA_DIR: string;
  requireAuth: RequestHandler;
  sanitizeSegment: (s: string) => string | null;
  extractTextFromFile: (filePath: string) => Promise<string>;
  parseJsonSafe: (text: string) => any;
  slugify: (s: string) => string;
  aiClient: OpenAI;
  execFileAsync: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

// ── small parsing helpers ─────────────────────────────────────────────────────

function normalizeStr(s: any): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

function onlyDigits(s: any): string {
  return String(s ?? "").replace(/\D/g, "");
}

/** Merge many uploaded PDFs (in order) into a single PDF buffer. Single file → passthrough. */
async function mergePdfBuffers(buffers: Buffer[]): Promise<Buffer> {
  const usable = buffers.filter(b => b && b.length);
  if (usable.length === 0) return Buffer.alloc(0);
  if (usable.length === 1) return usable[0];
  const out = await PDFDocument.create();
  for (const b of usable) {
    try {
      const src = await PDFDocument.load(b, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    } catch (e: any) {
      console.warn("[feac merge] skipping unreadable PDF:", e.message);
    }
  }
  return Buffer.from(await out.save());
}

/** Coerce numbers and Brazilian-formatted strings ("1.234,56", "R$ 4.725,00") to a number. */
function parseNum(v: any): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/r\$/i, "").trim();
  // Brazilian format: dot = thousands, comma = decimal
  if (/,/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

/** First currency value found in free text, e.g. "R$ 4.725,00" → 4725. */
function firstCurrency(text: string): number | undefined {
  const m = String(text || "").match(/R\$\s*([\d.]+,\d{2})/);
  if (m) return parseNum(m[1]);
  const m2 = String(text || "").match(/\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/);
  return m2 ? parseNum(m2[1]) : undefined;
}

/** Format a cell (Date | excel serial | string) to dd/mm/yyyy. */
function fmtDateBR(v: any): string {
  if (v == null || v === "") return "";
  if (v instanceof Date && !isNaN(v.getTime())) {
    const d = String(v.getUTCDate()).padStart(2, "0");
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    return `${d}/${m}/${v.getUTCFullYear()}`;
  }
  if (typeof v === "number") {
    // Excel serial date → JS date
    const epoch = Date.UTC(1899, 11, 30);
    const dt = new Date(epoch + Math.round(v) * 86400000);
    return fmtDateBR(dt);
  }
  const s = String(v).trim();
  const m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    const yyyy = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${yyyy}`;
  }
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s;
}

/** Pull a CPF (11) or CNPJ (14) out of free text. */
function extractTaxId(text: string): string | undefined {
  const cnpj = String(text || "").match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/);
  if (cnpj) { const d = onlyDigits(cnpj[0]); if (d.length === 14) return d; }
  const cpf = String(text || "").match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
  if (cpf) { const d = onlyDigits(cpf[0]); if (d.length === 11) return d; }
  // bare 14/11 digit runs
  const bare = String(text || "").match(/\b(\d{14}|\d{11})\b/);
  return bare ? bare[1] : undefined;
}

function extractFinRef(text: string): string | undefined {
  const m = String(text || "").match(/FIN[-\s]?(\d{3,5})/i);
  return m ? `FIN-${m[1]}` : undefined;
}

/** CNPJ root (first 8 digits) from a full CNPJ or a bare root token like "62.646.598". */
function taxRootOf(text: string): string | undefined {
  const full = String(text || "").match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
  if (full) return onlyDigits(full[0]).slice(0, 8);
  const root = String(text || "").match(/\b(\d{2}\.\d{3}\.\d{3})(?![\d/])/);
  return root ? onlyDigits(root[1]) : undefined;
}

/** Token-overlap similarity between two names (0..1). */
function nameOverlap(a: string, b: string): number {
  const stop = new Set(["ltda", "me", "epp", "sa", "s", "a", "de", "da", "do", "e", "eireli", "mei"]);
  const toks = (s: string) => new Set(normalizeStr(s).split(/[^a-z0-9]+/).filter(t => t.length > 1 && !stop.has(t)));
  const ta = toks(a), tb = toks(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function parseDateTs(ddmmyyyy: string): number {
  const m = String(ddmmyyyy || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return NaN;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

/** Accepts dd/mm/yyyy or yyyy-mm-dd → UTC ts (NaN if unparseable). */
function toTs(d: string): number {
  const s = String(d || "").trim();
  let m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return NaN;
}

/** Filter lançamentos to a período (inclusive). Undated rows are kept; no período → all. */
export function filterByPeriod(lancs: any[], ini?: string, fim?: string): any[] {
  const a = toTs(ini || ""), b = toTs(fim || "");
  if (isNaN(a) && isNaN(b)) return lancs;
  return lancs.filter(l => {
    const t = parseDateTs(l.dataPagamento);
    if (isNaN(t)) return true;
    if (!isNaN(a) && t < a) return false;
    if (!isNaN(b) && t > b) return false;
    return true;
  });
}

// ── ledger (xlsx "Dados") parsing ─────────────────────────────────────────────

export function parseLedger(xlsxPath: string): { sheetName: string; lancamentos: any[] } {
  const wb = XLSX.read(fs.readFileSync(xlsxPath), { type: "buffer", cellDates: true });
  // Prefer a sheet literally named "Dados"; else the first sheet that has a "Chave" header.
  const sheetName =
    wb.SheetNames.find(n => normalizeStr(n) === "dados") ||
    wb.SheetNames.find(n => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false }) as any[][];
      return rows.some(r => r.some(c => normalizeStr(c) === "chave"));
    }) ||
    wb.SheetNames[0];

  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" }) as any[][];
  let hdrIdx = rows.findIndex(r => r.some(c => normalizeStr(c) === "chave"));
  if (hdrIdx < 0) hdrIdx = 0;
  const headers = rows[hdrIdx].map(h => normalizeStr(h));
  const col = (...names: string[]) => {
    for (const nm of names) { const i = headers.indexOf(nm); if (i >= 0) return i; }
    // fuzzy contains
    for (const nm of names) { const i = headers.findIndex(h => h.includes(nm)); if (i >= 0) return i; }
    return -1;
  };
  const ci = {
    num: col("#", "n", "no"),
    chave: col("chave"),
    data: col("data pagamento", "data"),
    categoria: col("categoria"),
    descricao: col("descricao"),
    grupo: col("grupo da natureza orcamentaria (feac)", "grupo da natureza orcamentaria", "grupo da natureza"),
    natureza: col("natureza orcamentaria (feac)", "natureza orcamentaria", "natureza"),
    fornecedor: col("nome do fornecedor (razao social)", "nome do fornecedor", "fornecedor"),
    entrada: col("entrada"),
    saida: col("saida"),
    saldo: col("saldo"),
    obs: col("observacao", "observacoes", "obs"),
  };
  const get = (row: any[], i: number) => (i >= 0 ? row[i] : "");

  const lancamentos: any[] = [];
  for (let r = hdrIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    const saida = parseNum(get(row, ci.saida));
    if (saida === 0) continue; // expense rows only (Saída ≠ 0)
    const chave = String(get(row, ci.chave) ?? "").trim();
    if (normalizeStr(chave) === "total") continue;
    const fornecedor = String(get(row, ci.fornecedor) ?? "").trim();
    const observacao = String(get(row, ci.obs) ?? "").trim();
    lancamentos.push({
      id: crypto.randomUUID(),
      rowNum: parseNum(get(row, ci.num)) || undefined,
      chave,
      dataPagamento: fmtDateBR(get(row, ci.data)),
      categoria: String(get(row, ci.categoria) ?? "").trim(),
      descricao: String(get(row, ci.descricao) ?? "").trim(),
      grupoNatureza: String(get(row, ci.grupo) ?? "").trim(),
      natureza: String(get(row, ci.natureza) ?? "").trim(),
      fornecedor,
      entrada: parseNum(get(row, ci.entrada)),
      saida,
      saldo: parseNum(get(row, ci.saldo)),
      observacao,
      finRef: extractFinRef(observacao),
      taxId: extractTaxId(`${fornecedor} ${observacao}`),
      taxRoot: taxRootOf(`${fornecedor} ${observacao}`),
      rateio: "NAO",
      nf: null,
      comprovante: null,
      matchStatus: "SEM_AMBOS",
      auditorNote: "",
    });
  }
  return { sheetName, lancamentos };
}

function recomputeTotals(rec: any) {
  const exp = rec.lancamentos || [];
  const totalSaidas = exp.reduce((s: number, l: any) => s + Math.abs(parseNum(l.saida)), 0);
  const totalEntradas = exp.reduce((s: number, l: any) => s + parseNum(l.entrada), 0);
  rec.accountability = rec.accountability || {};
  rec.accountability.totalSaidas = Math.round(totalSaidas * 100) / 100;
  rec.accountability.totalEntradas = Math.round(totalEntradas * 100) / 100;
  rec.accountability.saldoFinal = Math.round((totalEntradas - totalSaidas) * 100) / 100;
  // derive competência / período from payment dates if absent
  const tss = exp.map((l: any) => parseDateTs(l.dataPagamento)).filter((n: number) => !isNaN(n));
  if (tss.length) {
    const min = new Date(Math.min(...tss)), max = new Date(Math.max(...tss));
    rec.accountability.periodoInicio = rec.accountability.periodoInicio || fmtDateBR(min);
    rec.accountability.periodoFim = rec.accountability.periodoFim || fmtDateBR(max);
    if (!rec.accountability.competencia) {
      rec.accountability.competencia = `${String(max.getUTCMonth() + 1).padStart(2, "0")}/${max.getUTCFullYear()}`;
    }
  }
}

// ── document detection + field extraction + matching ─────────────────────────

interface PageBlock { page: number; text: string; }
/** Split extractTextFromFile() output (with "[Página N]" markers) into per-page blocks. */
function splitPages(text: string): PageBlock[] {
  const parts = String(text || "").split(/\[Página (\d+)\]/);
  const out: PageBlock[] = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ page: Number(parts[i]), text: (parts[i + 1] || "").trim() });
  if (!out.length && String(text || "").trim()) out.push({ page: 1, text: String(text).trim() });
  return out;
}

const NF_START = /nfs-?e|danfse|nota fiscal (eletr|de servi)|n[uú]mero da nfs|chave de acesso da nfs/i;
const COMP_START = /comprovante|transfer[êe]ncia|\bpix\b|identificador da transa/i;

interface DocBlock { pages: number[]; text: string; }
/** Group consecutive pages into documents; a new doc starts on a start-marker page. */
function groupDocs(pages: PageBlock[], startRe: RegExp): DocBlock[] {
  const docs: DocBlock[] = [];
  for (const pg of pages) {
    const isStart = startRe.test(pg.text);
    if (!docs.length || isStart) docs.push({ pages: [pg.page], text: pg.text });
    else { const d = docs[docs.length - 1]; d.pages.push(pg.page); d.text += "\n" + pg.text; }
  }
  return docs;
}

const CASA_ID = "36038079000197"; // Associação Casa Hacker (the tomador/pagador) — excluded as supplier id

/** Prefer a FORMATTED CNPJ/CPF; never the 44-digit NFS-e chave de acesso (bare digit run). */
function extractDocIds(text: string): { taxId?: string; taxRoot?: string } {
  const fmt = [...String(text || "").matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/g)]
    .map(m => onlyDigits(m[0])).filter(d => (d.length === 14 || d.length === 11) && d !== CASA_ID);
  let taxId = fmt[0];
  if (!taxId) {
    const bare = [...String(text || "").matchAll(/(?<!\d)(\d{14}|\d{11})(?!\d)/g)].map(m => m[1]).filter(d => d !== CASA_ID);
    taxId = bare[0];
  }
  const taxRoot = taxId && taxId.length === 14 ? taxId.slice(0, 8) : taxRootOf(text);
  return { taxId, taxRoot };
}

// Brazilian currency, with or without "R$": "R$ 4.725,00", "8.400,00".
// Requires the ",dd" decimal so CNPJ/CPF/dates/CEP/phones never match.
function labeledCurrency(text: string, labelRe: RegExp): number | undefined {
  const lines = String(text || "").split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    // value may be on the label line or up to 2 lines below; take the largest (skips 0,00 deductions)
    const vals: number[] = [];
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      for (const m of lines[j].matchAll(/(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})/g)) {
        const v = parseNum(m[1]); if (v > 0) vals.push(v);
      }
    }
    if (vals.length) return Math.max(...vals);
  }
  return undefined;
}
function allCurrencies(text: string): number[] {
  return [...String(text || "").matchAll(/(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})/g)].map(m => parseNum(m[1])).filter(v => v > 0);
}
/** Heuristic supplier name: first non-Casa-Hacker, non-label uppercase-ish line. */
function docName(text: string): string | undefined {
  const lines = String(text || "").split(/\n/);
  const labelRe = /(nome\s*\/\s*nome empresarial|nome empresarial|raz[aã]o social|^\s*nome\b|benefici[aá]rio|favorecid)/i;
  const isCasa = (s: string) => /associa[çc][aã]o casa hacker/i.test(s);
  // first column (before 2+ spaces), with any leading id prefix ("39.433.309 ") stripped
  const clean = (s: string) => (s.split(/\s{2,}/).map(x => x.trim()).filter(Boolean)[0] || "").replace(/^\d[\d.\/-]*\s+/, "").trim();
  const looksName = (c: string) =>
    /^[A-Za-zÀ-ú][A-Za-zÀ-ú0-9 .,&'\/-]{4,59}$/.test(c) &&
    (c.match(/[A-Za-zÀ-ú]/g) || []).length >= 4 && !/@/.test(c) && !isCasa(c);
  // label-anchored: supplier name is on the line just after the "Nome/Razão social" label
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      if (!lines[j].trim()) continue;
      const c = clean(lines[j]);
      if (looksName(c)) return c.toUpperCase();
      break; // only the first non-empty line after the label
    }
  }
  // fallback: first all-caps multi-word line that isn't a known field label
  const bad = /(VALOR|CNPJ|CPF|NIF|DATA|BANCO|AG[EÊ]NCIA|CONTA|CHAVE|\bPIX\b|C[OÓ]DIGO|ENDERE|MUNIC|EMITENTE|TOMADOR|PRESTADOR|INTERMEDI|DESCRI|SERVI|NACIONAL|MUNICIPAL|FEDERAL|TRIBUTA|SIMPLES|REGIME|N[ÚU]MERO|S[ÉE]RIE|COMPET|PREFEITURA|SECRETARIA|DOCUMENTO|AUTENTICA|IDENTIFICADOR|ORIGEM|TOTA(L|IS)|APROXIMAD|FALE COM|ATENDIMENTO|OUVIDORIA)/i;
  for (const raw of lines.map(l => l.trim()).filter(Boolean)) {
    if (isCasa(raw) || bad.test(raw)) continue;
    const c = clean(raw);
    if (/^[A-ZÀ-Ú][A-ZÀ-Ú .'-]{5,49}$/.test(c) && (c.match(/ /g) || []).length >= 1) return c;
  }
  return undefined;
}
function extractDocFields(doc: DocBlock, kind: "nf" | "comprovante") {
  const { taxId, taxRoot } = extractDocIds(doc.text);
  let value = kind === "comprovante"
    ? labeledCurrency(doc.text, /valor\s*(enviado|pago|da transfer|total)/i)
    : labeledCurrency(doc.text, /valor\s*(do\s*servi|total da nfs|l[ií]quido|da nota)/i);
  if (value == null) { const all = allCurrencies(doc.text); if (all.length) value = Math.max(...all); }
  const date = (doc.text.match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1];
  let docNumber = kind === "nf"
    ? ((doc.text.match(/n[º°o]?\s*da\s*nfs-?e[^\d]{0,12}(\d{1,9})/i) || [])[1] || (doc.text.match(/n[uú]mero da nfs-?e[^\d]{0,12}(\d{1,9})/i) || [])[1])
    : ((doc.text.match(/identificador da transa[çc][aã]o[\s:]*([\w-]{6,})/i) || [])[1] || (doc.text.match(/c[oó]digo de autentica[çc][aã]o[\s:]*([\w]{6,})/i) || [])[1]);
  return { pages: doc.pages, text: doc.text, value, date, taxId, taxRoot, name: docName(doc.text), docNumber };
}
function scoreMatch(lanc: any, f: any): number {
  let s = 0;
  if (lanc.taxId && f.taxId && lanc.taxId === f.taxId) s += 0.5;
  else if (lanc.taxRoot && f.taxRoot && lanc.taxRoot === f.taxRoot) s += 0.4;
  s += 0.3 * nameOverlap(lanc.fornecedor, f.name || "");
  const lt = parseDateTs(lanc.dataPagamento), ft = parseDateTs(fmtDateBR(f.date));
  if (!isNaN(lt) && !isNaN(ft)) { const days = Math.abs(lt - ft) / 86400000; if (days <= 6) s += 0.2 * (1 - days / 6); }
  return s;
}

/**
 * Deterministic matcher. Mutates each lançamento (sets nf/comprovante/matchStatus/valorDivergencia)
 * and returns docs that matched no lançamento (orphans). Exported for testing.
 */
/** Derive matchStatus + valorDivergencia for every lançamento from its nf/comprovante refs. */
export function applyStatus(lancamentos: any[]) {
  for (const l of lancamentos) {
    const target = Math.abs(parseNum(l.saida));
    const hasNf = !!l.nf, hasComp = !!l.comprovante;
    let divergence = 0;
    if (hasNf && l.nf.extractedValue != null) divergence = Math.max(divergence, Math.abs(l.nf.extractedValue - target));
    if (hasComp && l.comprovante.extractedValue != null) divergence = Math.max(divergence, Math.abs(l.comprovante.extractedValue - target));
    if (!hasNf && !hasComp) l.matchStatus = "SEM_AMBOS";
    else if (!hasNf) l.matchStatus = "SEM_NF";
    else if (!hasComp) l.matchStatus = "SEM_COMPROVANTE";
    else if (divergence > 0.01) { l.matchStatus = "VALOR_DIVERGENTE"; l.valorDivergencia = Math.round(divergence * 100) / 100; }
    else { l.matchStatus = "OK"; delete l.valorDivergencia; }
  }
}

/**
 * Optional DeepSeek fuzzy fallback: pair residual unmatched lançamentos with orphan docs.
 * Runs only when both exist; failures are swallowed (deterministic result stands). Returns # applied.
 */
export async function fuzzyPass(aiClient: any, parseJsonSafe: any, lancamentos: any[], orphans: any[]): Promise<number> {
  const unmatched = lancamentos.filter((l: any) => !l.nf || !l.comprovante);
  if (!unmatched.length || !orphans.length) return 0;
  const docList = orphans.map((o: any, i: number) => ({ idx: i, tipo: o.kind, valor: o.extractedValue, data: o.extractedDate, nome: o.extractedName, cnpj: o.extractedTaxId }));
  const lancList = unmatched.map((l: any) => ({ id: l.id, valor: Math.abs(parseNum(l.saida)), data: l.dataPagamento, fornecedor: l.fornecedor, precisaNf: !l.nf, precisaComprovante: !l.comprovante }));
  const sys = "Você concilia documentos fiscais brasileiros. Associe cada documento avulso ao lançamento correto por valor, data e nome/CNPJ. Responda apenas JSON.";
  const usr = `Lançamentos sem documento:\n${JSON.stringify(lancList)}\n\nDocumentos avulsos:\n${JSON.stringify(docList)}\n\nRetorne {"matches":[{"lancamentoId":"<id>","docIdx":<idx>,"confianca":<0..1>}]} apenas para pares com confiança >= 0.6.`;
  let parsed: any;
  try {
    const resp = await aiClient.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
      response_format: { type: "json_object" }, temperature: 0.1, max_tokens: 1500,
    });
    parsed = parseJsonSafe(resp.choices?.[0]?.message?.content || "");
  } catch { return 0; }
  if (!parsed?.matches?.length) return 0;
  let applied = 0;
  const consumed = new Set<number>();
  for (const m of parsed.matches) {
    const l = lancamentos.find((x: any) => x.id === m.lancamentoId);
    const o = orphans[m.docIdx];
    if (!l || !o || consumed.has(m.docIdx) || (m.confianca ?? 0) < 0.6) continue;
    const ref = { sourceFile: o.sourceFile, pages: o.pages, confidence: Math.min(1, m.confianca), method: "fuzzy", extractedValue: o.extractedValue, extractedDate: o.extractedDate, extractedName: o.extractedName, extractedTaxId: o.extractedTaxId, docNumber: o.docNumber };
    if (o.kind === "nf" && !l.nf) { l.nf = ref; consumed.add(m.docIdx); applied++; }
    else if (o.kind === "comprovante" && !l.comprovante) { l.comprovante = ref; consumed.add(m.docIdx); applied++; }
  }
  if (consumed.size) { const left = orphans.filter((_: any, i: number) => !consumed.has(i)); orphans.length = 0; orphans.push(...left); }
  return applied;
}

export function runMatching(lancamentos: any[], nfText: string, compText: string): { orphans: any[] } {
  const nfDocs = groupDocs(splitPages(nfText), NF_START).map(d => ({ ...extractDocFields(d, "nf"), used: false, sourceFile: "notas" }));
  const compDocs = groupDocs(splitPages(compText), COMP_START).map(d => ({ ...extractDocFields(d, "comprovante"), used: false, sourceFile: "comprovantes" }));

  const assign = (docs: any[], kind: "nf" | "comprovante") => {
    // assign distinctive (larger) amounts first to reduce ambiguity among equal values
    const order = [...lancamentos].sort((a, b) => Math.abs(parseNum(b.saida)) - Math.abs(parseNum(a.saida)));
    for (const lanc of order) {
      const target = Math.abs(parseNum(lanc.saida));
      let cands = docs.filter(d => !d.used && d.value != null && Math.abs(d.value - target) < 0.01);
      if (!cands.length) cands = docs.filter(d => !d.used && d.value != null && Math.abs(d.value - target) <= target * 0.02 + 0.01);
      if (!cands.length) continue;
      cands.sort((a, b) => scoreMatch(lanc, b) - scoreMatch(lanc, a));
      const best = cands[0];
      best.used = true;
      lanc[kind] = {
        sourceFile: best.sourceFile, pages: best.pages,
        confidence: Math.min(1, Math.round((0.55 + scoreMatch(lanc, best)) * 100) / 100),
        method: "deterministic",
        extractedValue: best.value, extractedDate: best.date,
        extractedName: best.name, extractedTaxId: best.taxId, docNumber: best.docNumber,
      };
    }
  };
  assign(nfDocs, "nf");
  assign(compDocs, "comprovante");

  applyStatus(lancamentos);

  const orphan = (docs: any[], kind: "nf" | "comprovante") =>
    docs.filter(d => !d.used && d.value != null).map(d => ({
      kind, sourceFile: d.sourceFile, pages: d.pages,
      extractedValue: d.value, extractedDate: d.date, extractedName: d.name, extractedTaxId: d.taxId, docNumber: d.docNumber,
    }));
  return { orphans: [...orphan(nfDocs, "nf"), ...orphan(compDocs, "comprovante")] };
}

// ── document treatment: merge → left-margin stamp → PDF/A-2b ──────────────────

function formatBRL(n: number): string {
  const v = (Number(n) || 0).toFixed(2);
  const [int, dec] = v.split(".");
  return "R$ " + int.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + dec;
}

/** The left-margin stamp text declared up front: "Número do Contrato e Notas Complementares". */
function buildStampText(acc: any): string {
  const c = acc?.contractNumber ? `Contrato ${acc.contractNumber}` : "";
  const n = acc?.notasComplementares ? (c ? " — " : "") + acc.notasComplementares : "";
  return (c + n) || "Documentação Comprobatória";
}

async function embedPlex(doc: any, file: string, fallback: any) {
  try { return await doc.embedFont(fs.readFileSync(path.join(ASSETS_DIR, file)), { subset: true }); }
  catch { return await doc.embedFont(fallback); }
}

/** Copy the given 1-based pages from a source PDF into a fresh single PDF buffer. */
async function extractPages(srcPath: string, pages?: number[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  const src = await PDFDocument.load(fs.readFileSync(srcPath), { ignoreEncryption: true });
  const idx = (pages || []).map(n => n - 1).filter(i => i >= 0 && i < src.getPageCount());
  const copied = await out.copyPages(src, idx.length ? idx : [0]);
  copied.forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}

/** Merge comprovante page(s) then NF page(s) into one PDF (the order required by FEAC). */
async function mergeForLanc(recDir: string, lanc: any): Promise<Buffer> {
  const out = await PDFDocument.create();
  const add = async (file: string, pages?: number[]) => {
    if (!pages?.length) return;
    const p = path.join(recDir, file);
    if (!fs.existsSync(p)) return;
    const src = await PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true });
    const idx = pages.map(n => n - 1).filter(i => i >= 0 && i < src.getPageCount());
    if (!idx.length) return;
    (await out.copyPages(src, idx)).forEach(pg => out.addPage(pg));
  };
  await add(lanc.comprovante?.sourceFile === "comprovantes" ? "comprovantes.pdf" : "comprovantes.pdf", lanc.comprovante?.pages);
  await add("notas.pdf", lanc.nf?.pages);
  return Buffer.from(await out.save());
}

/** Add a left-margin band on every page with rotated stamp text (content shifted right, never covered). */
export async function stampLeftMargin(pdfBuffer: Buffer, stampText: string): Promise<Buffer> {
  const src = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await embedPlex(out, "IBMPlexSans-Regular.ttf", StandardFonts.Helvetica);
  const MARGIN = 38;
  const embedded = await out.embedPages(src.getPages());
  embedded.forEach((ep: any) => {
    const w = ep.width, h = ep.height;
    const page = out.addPage([w + MARGIN, h]);
    page.drawPage(ep, { x: MARGIN, y: 0, width: w, height: h });
    page.drawRectangle({ x: 0, y: 0, width: MARGIN, height: h, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: MARGIN - 0.5, y: 0 }, end: { x: MARGIN - 0.5, y: h }, thickness: 0.5, color: rgb(0.82, 0.82, 0.82) });
    page.drawText(stampText, { x: 13, y: 12, size: 7, font, color: rgb(0.13, 0.13, 0.13), rotate: degrees(90), maxWidth: h - 24, lineHeight: 8.5 });
  });
  return Buffer.from(await out.save());
}

/** Ghostscript PDF/A definition (OutputIntent → sRGB), absolute ICC path interpolated. */
function pdfaDefPs(iccPath: string): string {
  const safe = iccPath.replace(/\\/g, "/").replace(/[()]/g, "");
  return `%!
[ /Title (Prestacao de Contas FEAC) /DOCINFO pdfmark
[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark
[{icc_PDFA} <</N 3 /Alternate /DeviceRGB>> /PUT pdfmark
[{icc_PDFA} (${safe}) (r) file /PUT pdfmark
[/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark
[{OutputIntent_PDFA} <<
  /Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile {icc_PDFA}
  /OutputConditionIdentifier (sRGB IEC61966-2.1) /Info (sRGB IEC61966-2.1)
>> /PUT pdfmark
[{Catalog} <</OutputIntents [ {OutputIntent_PDFA} ]>> /PUT pdfmark
`;
}

/** Convert+compress to PDF/A-2b (RGB) via Ghostscript. Returns true on success, false on fallback copy. */
async function toPdfA(execFileAsync: FeacCtx["execFileAsync"], inPath: string, outPath: string, tmpDir: string): Promise<boolean> {
  const icc = path.join(ASSETS_DIR, "sRGB.icc");
  if (fs.existsSync(icc)) {
    const defPath = path.join(tmpDir, `def_${path.basename(outPath)}.ps`);
    fs.writeFileSync(defPath, pdfaDefPs(icc));
    try {
      await execFileAsync("gs", [
        `--permit-file-read=${icc}`,   // gs 10.x -dSAFER blocks the OutputIntent ICC read otherwise
        "-dPDFA=2", "-dPDFACompatibilityPolicy=1",
        "-sColorConversionStrategy=RGB", "-dProcessColorModel=/DeviceRGB",
        "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.7", "-dPDFSETTINGS=/ebook",
        "-dNOPAUSE", "-dQUIET", "-dBATCH",
        `-sOutputFile=${outPath}`, defPath, inPath,
      ]);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return true;
    } catch (e: any) { console.warn("[feac PDF/A] gs fallback:", e.message); }
  }
  try { fs.copyFileSync(inPath, outPath); } catch { /* */ }
  return false;
}

function wrapText(font: any, text: string, size: number, maxWidth: number): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(t, size) <= maxWidth || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Render the Declaração de Rateio (FEAC model) natively with pdf-lib. */
export async function buildRateioPdf(rows: any[], acc: any): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await embedPlex(doc, "IBMPlexSans-Regular.ttf", StandardFonts.Helvetica);
  const bold = await embedPlex(doc, "IBMPlexSans-SemiBold.ttf", StandardFonts.HelveticaBold);
  let header: any, footer: any;
  try { header = await doc.embedPng(fs.readFileSync(path.join(ASSETS_DIR, "rateio_logo_header.png"))); } catch { /* */ }
  try { footer = await doc.embedPng(fs.readFileSync(path.join(ASSETS_DIR, "rateio_logo_footer.png"))); } catch { /* */ }

  const PW = 595.28, PH = 841.89, M = 40, SIZE = 7.5, PAD = 3, LH = 9;
  const cols = [
    { t: "Nome da Despesa", w: 92 },
    { t: "Data Pagamento", w: 56 },
    { t: "Número do documento", w: 70 },
    { t: "Nome do Fornecedor", w: 96 },
    { t: "Valor total do documento", w: 67 },
    { t: "Valor pago com recurso do projeto", w: 67 },
    { t: "Valor pago com recurso próprio da OSC", w: 67 },
  ];
  const colX = (i: number) => M + cols.slice(0, i).reduce((s, c) => s + c.w, 0);
  let page = doc.addPage([PW, PH]);
  let y = PH - M;
  const footerArea = () => { if (footer) { const fw = PW - 2 * M, fh = Math.min(38, fw * footer.height / footer.width); page.drawImage(footer, { x: M, y: M - 8, width: fw, height: fh }); } };
  const row = (vals: string[], head = false) => {
    const f = head ? bold : font;
    const cells = cols.map((c, i) => wrapText(f, vals[i] || "", SIZE, c.w - 2 * PAD));
    const rowH = Math.max(...cells.map(l => l.length)) * LH + 2 * PAD;
    if (y - rowH < M + 44) { footerArea(); page = doc.addPage([PW, PH]); y = PH - M; header2(); }
    if (head) page.drawRectangle({ x: M, y: y - rowH, width: PW - 2 * M, height: rowH, color: rgb(0.92, 0.95, 1) });
    cols.forEach((c, i) => {
      const x = colX(i);
      page.drawRectangle({ x, y: y - rowH, width: c.w, height: rowH, borderColor: rgb(0.78, 0.78, 0.78), borderWidth: 0.5 });
      cells[i].forEach((ln, li) => page.drawText(ln, { x: x + PAD, y: y - PAD - LH + 2 - li * LH, size: SIZE, font: f, color: rgb(0.1, 0.1, 0.1) }));
    });
    y -= rowH;
  };
  const header2 = () => row(cols.map(c => c.t), true);
  // page 1 masthead
  if (header) { const hw = 130, hh = hw * header.height / header.width; page.drawImage(header, { x: M, y: y - hh, width: hw, height: hh }); y -= hh + 10; }
  page.drawText("DECLARAÇÃO DE RATEIO", { x: M, y, size: 14, font: bold, color: rgb(0.06, 0.06, 0.06) }); y -= 18;
  const intro = "Declaro para os devidos fins que as despesas abaixo foram pagas conforme o rateio indicado, sendo parte com recursos do projeto e parte com recursos próprios da OSC.";
  for (const ln of wrapText(font, intro, 9, PW - 2 * M)) { page.drawText(ln, { x: M, y, size: 9, font, color: rgb(0.22, 0.22, 0.22) }); y -= 12; }
  y -= 10;
  header2();
  for (const r of rows) {
    const total = Math.abs(Number(r.saida) || 0);
    row([
      r.descricao || r.chave || "",
      r.dataPagamento || "",
      r.nf?.docNumber || r.finRef || "",
      r.fornecedor || "",
      formatBRL(total),
      formatBRL(r.rateioValorProjeto ?? total),
      formatBRL(r.rateioValorProprio ?? 0),
    ]);
  }
  footerArea();
  return Buffer.from(await doc.save());
}

/** Re-export the cash-flow workbook with reconciliation columns added to the ledger sheet. */
export function updateFluxoXlsx(srcPath: string, sheetName: string, lancs: any[]): Buffer {
  const wb = XLSX.read(fs.readFileSync(srcPath), { type: "buffer", cellDates: true });
  const sn = wb.SheetNames.includes(sheetName) ? sheetName : (wb.SheetNames.find(n => normalizeStr(n) === "dados") || wb.SheetNames[0]);
  const ws = wb.Sheets[sn];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" }) as any[][];
  let hdrIdx = rows.findIndex(r => r.some(c => normalizeStr(c) === "chave"));
  if (hdrIdx < 0) hdrIdx = 0;
  const headers = rows[hdrIdx];
  const numCol = headers.findIndex((h: any) => normalizeStr(h) === "#");
  const extra = ["Status Documentação", "Nº NF", "Nº Comprovante", "Páginas NF", "Páginas Comprovante", "RATEIO"];
  const base = headers.length;
  extra.forEach((c, i) => { headers[base + i] = c; });
  const statusMap: any = { OK: "OK - NF + Comprovante", SEM_NF: "Sem NF", SEM_COMPROVANTE: "Sem comprovante", SEM_AMBOS: "Sem documentos", VALOR_DIVERGENTE: "Valor divergente", DUPLICADO: "Duplicado" };
  const byRow = new Map(lancs.map(l => [String(l.rowNum), l]));
  for (let r = hdrIdx + 1; r < rows.length; r++) {
    const l = numCol >= 0 ? byRow.get(String(rows[r][numCol])) : null;
    if (!l) continue;
    rows[r][base + 0] = statusMap[l.matchStatus] || l.matchStatus;
    rows[r][base + 1] = l.nf?.docNumber || "";
    rows[r][base + 2] = l.comprovante?.docNumber || "";
    rows[r][base + 3] = l.nf?.pages?.join(",") || "";
    rows[r][base + 4] = l.comprovante?.pages?.join(",") || "";
    rows[r][base + 5] = l.rateio || "NAO";
  }
  wb.Sheets[sn] = XLSX.utils.aoa_to_sheet(rows);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function sendPdf(res: Response, buf: Buffer, filename: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
}

// ── route registration ────────────────────────────────────────────────────────

export function registerFeacRoutes(app: Express, ctx: FeacCtx) {
  const { DATA_DIR, requireAuth, sanitizeSegment, slugify, execFileAsync } = ctx;
  const FEAC_DIR = path.join(DATA_DIR, "feac");
  fs.mkdirSync(FEAC_DIR, { recursive: true });

  const feacUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const okExt = ext === ".pdf" || ext === ".xlsx" || ext === ".xls" || ext === ".json";
      if (okExt) return cb(null, true);
      cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype} (${ext})`));
    },
  });

  const dir = (id: string) => path.join(FEAC_DIR, id);
  const recordPath = (id: string) => path.join(dir(id), "record.json");

  function readRecord(id: string): any | null {
    try { return JSON.parse(fs.readFileSync(recordPath(id), "utf-8")); }
    catch { return null; }
  }
  function writeRecord(rec: any) {
    rec.updatedAt = new Date().toISOString();
    fs.writeFileSync(recordPath(rec.id), JSON.stringify(rec, null, 2));
  }
  function ownerOk(rec: any, req: any): boolean {
    return !rec.createdBy || rec.createdBy === req.user?.email;
  }
  /** Resolve + ownership-check a record; sends the right error and returns null on failure. */
  function loadOwned(req: any, res: Response): { id: string; rec: any } | null {
    const id = sanitizeSegment(req.params.id as string);
    if (!id) { res.status(400).json({ error: "ID inválido" }); return null; }
    const rec = readRecord(id);
    if (!rec) { res.status(404).json({ error: "Prestação de contas não encontrada" }); return null; }
    if (!ownerOk(rec, req)) { res.status(403).json({ error: "Proibido" }); return null; }
    return { id, rec };
  }

  // ── POST /api/feac — create record + upload source files ─────────────────────
  app.post(
    "/api/feac",
    requireAuth,
    feacUpload.fields([
      { name: "notas", maxCount: 100 },
      { name: "comprovantes", maxCount: 100 },
      { name: "extrato", maxCount: 10 },
      { name: "fluxoCaixa", maxCount: 1 },
    ]),
    async (req: any, res) => {
      let meta: any = {};
      try { meta = req.body.meta ? JSON.parse(req.body.meta) : {}; } catch { /* tolerate */ }

      const id = crypto.randomUUID();
      const recDir = dir(id);
      fs.mkdirSync(recDir, { recursive: true });

      const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
      const sourceFiles: any = {};
      // PDFs: accept many files per field, merged (in upload order) into one bundle PDF.
      const saveMergedPdf = async (field: string, target: string) => {
        const arr = files[field] || [];
        if (!arr.length) return;
        const merged = await mergePdfBuffers(arr.map(f => f.buffer));
        if (!merged.length) return;
        fs.writeFileSync(path.join(recDir, target), merged);
        sourceFiles[field] = target;
      };
      const saveSingle = (field: string, target: string, key: string) => {
        const f = files[field]?.[0];
        if (!f) return;
        fs.writeFileSync(path.join(recDir, target), f.buffer);
        sourceFiles[key] = target;
      };
      await saveMergedPdf("notas", "notas.pdf");
      await saveMergedPdf("comprovantes", "comprovantes.pdf");
      await saveMergedPdf("extrato", "extrato.pdf");
      saveSingle("fluxoCaixa", "fluxo.xlsx", "fluxoCaixa");

      const rec = {
        id,
        createdBy: req.user?.email,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stage: "criado",
        schemaVersion: 1,
        accountability: {
          contractNumber: String(meta.contractNumber || "").trim(),
          notasComplementares: String(meta.notasComplementares || "").trim(),
          projeto: String(meta.projeto || "").trim(),
          competencia: String(meta.competencia || "").trim(),
          centroCusto: String(meta.centroCusto || "").trim(),
          periodoInicio: String(meta.periodoInicio || "").trim(),
          periodoFim: String(meta.periodoFim || "").trim(),
          totalSaidas: 0, totalEntradas: 0, saldoFinal: 0,
        },
        lancamentos: [],
        orphans: [],
        sourceFiles,
        ledgerSheetName: "",
      };
      writeRecord(rec);
      res.status(201).json({ id });
    }
  );

  // ── POST /api/feac/:id/parse — parse ledger xlsx + extract PDF text ───────────
  app.post("/api/feac/:id/parse", requireAuth, async (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { id, rec } = owned;
    const recDir = dir(id);

    // 1) parse the cash-flow ledger
    const fluxoPath = path.join(recDir, rec.sourceFiles?.fluxoCaixa || "fluxo.xlsx");
    if (!fs.existsSync(fluxoPath)) return res.status(422).json({ error: "Planilha de fluxo de caixa não enviada" });
    try {
      const { sheetName, lancamentos } = parseLedger(fluxoPath);
      rec.ledgerSheetName = sheetName;
      rec.lancamentos = filterByPeriod(lancamentos, rec.accountability?.periodoInicio, rec.accountability?.periodoFim);
    } catch (e: any) {
      return res.status(500).json({ error: "Falha ao ler a planilha: " + e.message });
    }

    // 2) extract + cache text from the source PDFs (best-effort; matching happens in /audit)
    const extractCache = async (file: string | undefined, txtName: string) => {
      if (!file) return;
      const p = path.join(recDir, file);
      if (!fs.existsSync(p)) return;
      try {
        const text = await ctx.extractTextFromFile(p);
        fs.writeFileSync(path.join(recDir, txtName), text);
      } catch (e: any) {
        console.warn("[feac parse] extract failed", txtName, e.message);
      }
    };
    await extractCache(rec.sourceFiles?.notas, "notas.txt");
    await extractCache(rec.sourceFiles?.comprovantes, "comprovantes.txt");
    await extractCache(rec.sourceFiles?.extrato, "extrato.txt");

    recomputeTotals(rec);
    rec.stage = "extraido";
    writeRecord(rec);
    res.json(rec);
  });

  // ── POST /api/feac/:id/audit — match NF + comprovante to each lançamento ──────
  app.post("/api/feac/:id/audit", requireAuth, async (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { id, rec } = owned;
    const recDir = dir(id);
    const readTxt = (n: string) => { const p = path.join(recDir, n); return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""; };
    const { orphans } = runMatching(rec.lancamentos || [], readTxt("notas.txt"), readTxt("comprovantes.txt"));
    rec.orphans = orphans;
    // Optional DeepSeek fuzzy fallback — only fires when deterministic matching left gaps + orphan docs.
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        const n = await fuzzyPass(ctx.aiClient, ctx.parseJsonSafe, rec.lancamentos, rec.orphans);
        if (n) applyStatus(rec.lancamentos);
      } catch (e: any) { console.warn("[feac fuzzy]", e.message); }
    }
    recomputeTotals(rec);
    rec.stage = "auditado";
    writeRecord(rec);
    res.json(rec);
  });

  // ── GET /api/feac — list summaries (own records) ─────────────────────────────
  app.get("/api/feac", requireAuth, (req: any, res) => {
    if (!fs.existsSync(FEAC_DIR)) return res.json([]);
    const out: any[] = [];
    for (const d of fs.readdirSync(FEAC_DIR)) {
      const rp = path.join(FEAC_DIR, d, "record.json");
      if (!fs.existsSync(rp)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(rp, "utf-8"));
        if (rec.createdBy && rec.createdBy !== req.user?.email) continue;
        const lancs = rec.lancamentos || [];
        out.push({
          id: rec.id,
          createdBy: rec.createdBy,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          stage: rec.stage,
          contractNumber: rec.accountability?.contractNumber || "",
          competencia: rec.accountability?.competencia || "",
          projeto: rec.accountability?.projeto || "",
          lancamentosCount: lancs.length,
          okCount: lancs.filter((l: any) => l.matchStatus === "OK").length,
          totalSaidas: rec.accountability?.totalSaidas || 0,
        });
      } catch { /* skip corrupt */ }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json(out);
  });

  // ── GET /api/feac/:id — full record ──────────────────────────────────────────
  app.get("/api/feac/:id", requireAuth, (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    // backfill ids for any legacy lançamento missing one
    let changed = false;
    for (const l of owned.rec.lancamentos || []) {
      if (!l.id) { l.id = crypto.randomUUID(); changed = true; }
    }
    if (changed) writeRecord(owned.rec);
    res.json(owned.rec);
  });

  // ── PATCH /api/feac/:id — edit preliminary report (merge by lançamento id) ────
  app.patch("/api/feac/:id", requireAuth, (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { rec } = owned;
    const patch = req.body || {};

    if (patch.accountability && typeof patch.accountability === "object") {
      rec.accountability = { ...rec.accountability, ...patch.accountability };
    }
    if (Array.isArray(patch.lancamentos)) {
      const byId = new Map(rec.lancamentos.map((l: any) => [l.id, l]));
      for (const upd of patch.lancamentos) {
        if (!upd || !upd.id) continue;
        const cur = byId.get(upd.id);
        if (!cur) continue;
        // only allow safe, auditor-editable fields to be patched
        const allow = [
          "rateio", "rateioValorProjeto", "rateioValorProprio", "auditorNote",
          "fornecedor", "dataPagamento", "descricao", "taxId", "saida",
          "matchStatus", "nf", "comprovante", "valorDivergencia",
        ];
        for (const k of allow) if (k in upd) (cur as any)[k] = upd[k];
      }
    }
    recomputeTotals(rec);
    writeRecord(rec);
    res.json(rec);
  });

  // ── GET /api/feac/:id/export — download editable preliminary artifact ─────────
  app.get("/api/feac/:id/export", requireAuth, (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { rec } = owned;
    const artifact = {
      kind: "feac-preliminar",
      schemaVersion: 1,
      id: rec.id,
      exportedAt: new Date().toISOString(),
      accountability: rec.accountability,
      lancamentos: rec.lancamentos,
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="feac_${rec.id.slice(0, 8)}_preliminar.json"`);
    res.send(JSON.stringify(artifact, null, 2));
  });

  // ── POST /api/feac/:id/import — re-import edited artifact (id preserved) ───────
  app.post("/api/feac/:id/import", requireAuth, feacUpload.single("file"), (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { rec } = owned;
    let art: any;
    try {
      const raw = req.file ? req.file.buffer.toString("utf-8") : JSON.stringify(req.body || {});
      art = JSON.parse(raw);
    } catch { return res.status(400).json({ error: "Arquivo de importação inválido (JSON)" }); }
    if (art.kind !== "feac-preliminar" || art.schemaVersion !== 1)
      return res.status(400).json({ error: "Formato de importação não reconhecido" });
    if (String(art.id) !== String(rec.id))
      return res.status(409).json({ error: "O arquivo pertence a outra prestação de contas (ID diferente)" });

    if (art.accountability && typeof art.accountability === "object")
      rec.accountability = { ...rec.accountability, ...art.accountability };
    let applied = 0;
    if (Array.isArray(art.lancamentos)) {
      const byId = new Map(rec.lancamentos.map((l: any) => [l.id, l]));
      const allow = ["rateio", "rateioValorProjeto", "rateioValorProprio", "auditorNote", "fornecedor", "dataPagamento", "descricao", "taxId", "saida", "matchStatus", "nf", "comprovante", "valorDivergencia"];
      for (const upd of art.lancamentos) {
        if (!upd?.id) continue;
        const cur = byId.get(upd.id);
        if (!cur) continue;
        for (const k of allow) if (k in upd) (cur as any)[k] = upd[k];
        applied++;
      }
    }
    recomputeTotals(rec);
    writeRecord(rec);
    res.json({ ...rec, _imported: applied });
  });

  // ── POST /api/feac/:id/treat — merge + left-margin stamp + PDF/A-2b + rateio + fluxo ──
  app.post("/api/feac/:id/treat", requireAuth, async (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { id, rec } = owned;
    const recDir = dir(id);
    const treatedDir = path.join(recDir, "treated");
    fs.mkdirSync(treatedDir, { recursive: true });
    const stampText = buildStampText(rec.accountability);
    const errors: any[] = [];
    let count = 0;
    const tmpDir = fs.mkdtempSync(path.join(DATA_DIR, "feac_treat_"));
    try {
      for (const l of rec.lancamentos) {
        if (!l.nf && !l.comprovante) { l.treatedPdf = undefined; continue; }
        try {
          const merged = await mergeForLanc(recDir, l);
          const stamped = await stampLeftMargin(merged, stampText);
          const stampedPath = path.join(tmpDir, `${l.id}_s.pdf`);
          fs.writeFileSync(stampedPath, stamped);
          await toPdfA(execFileAsync, stampedPath, path.join(treatedDir, `${l.id}.pdf`), tmpDir);
          l.treatedPdf = `treated/${l.id}.pdf`;
          count++;
        } catch (e: any) { errors.push({ lancamentoId: l.id, message: e.message }); }
      }
      let rateioPdf: string | undefined;
      const rateioRows = rec.lancamentos.filter((l: any) => l.rateio === "SIM");
      if (rateioRows.length) {
        try { fs.writeFileSync(path.join(recDir, "declaracao_rateio.pdf"), await buildRateioPdf(rateioRows, rec.accountability)); rateioPdf = "declaracao_rateio.pdf"; }
        catch (e: any) { errors.push({ lancamentoId: "rateio", message: e.message }); }
      }
      let fluxoUpd: string | undefined;
      const fluxoSrc = path.join(recDir, rec.sourceFiles?.fluxoCaixa || "fluxo.xlsx");
      if (fs.existsSync(fluxoSrc)) {
        try { fs.writeFileSync(path.join(recDir, "fluxo_atualizado.xlsx"), updateFluxoXlsx(fluxoSrc, rec.ledgerSheetName || "Dados", rec.lancamentos)); fluxoUpd = "fluxo_atualizado.xlsx"; }
        catch (e: any) { errors.push({ lancamentoId: "fluxo", message: e.message }); }
      }
      rec.treatment = { perItem: true, treatedCount: count, rateioPdf, fluxoCaixaUpdated: fluxoUpd, errors, treatedAt: new Date().toISOString() };
      rec.stage = "concluido";
      writeRecord(rec);
      res.json(rec);
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  });

  // ── GET /api/feac/:id/items/:lancId/doc — per-lançamento PDF (treated, or NF/comprovante pages) ──
  app.get("/api/feac/:id/items/:lancId/doc", requireAuth, async (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { id, rec } = owned;
    const recDir = dir(id);
    const lancId = sanitizeSegment(req.params.lancId as string);
    if (!lancId) return res.status(400).json({ error: "ID inválido" });
    const l = (rec.lancamentos || []).find((x: any) => x.id === lancId);
    if (!l) return res.status(404).json({ error: "Lançamento não encontrado" });
    const slug = slugify(l.fornecedor || lancId);
    try {
      const type = String(req.query.type || "");
      if (type === "nf" || type === "comprovante") {
        const ref = type === "nf" ? l.nf : l.comprovante;
        if (!ref) return res.status(404).json({ error: "Documento não localizado" });
        const file = type === "nf" ? (rec.sourceFiles?.notas || "notas.pdf") : (rec.sourceFiles?.comprovantes || "comprovantes.pdf");
        const sp = path.join(recDir, file);
        if (!fs.existsSync(sp)) return res.status(404).json({ error: "Arquivo fonte não encontrado" });
        return sendPdf(res, await extractPages(sp, ref.pages), `${type === "nf" ? "NF" : "Comprovante"}_${slug}.pdf`);
      }
      const treated = path.join(recDir, "treated", `${lancId}.pdf`);
      if (fs.existsSync(treated)) return sendPdf(res, fs.readFileSync(treated), `Comprovante_NF_${slug}.pdf`);
      if (l.nf || l.comprovante) {
        const merged = await mergeForLanc(recDir, l);
        return sendPdf(res, await stampLeftMargin(merged, buildStampText(rec.accountability)), `Comprovante_NF_${slug}.pdf`);
      }
      res.status(404).json({ error: "Sem documentos para este lançamento" });
    } catch (e: any) { res.status(500).json({ error: "Erro ao gerar PDF: " + e.message }); }
  });

  // ── GET /api/feac/:id/rateio.pdf · /fluxo · /zip ─────────────────────────────
  app.get("/api/feac/:id/rateio.pdf", requireAuth, async (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { id, rec } = owned;
    const p = path.join(dir(id), "declaracao_rateio.pdf");
    if (fs.existsSync(p)) return sendPdf(res, fs.readFileSync(p), "declaracao_rateio.pdf");
    const rows = (rec.lancamentos || []).filter((l: any) => l.rateio === "SIM");
    if (!rows.length) return res.status(404).json({ error: "Nenhum lançamento marcado como rateio" });
    try { sendPdf(res, await buildRateioPdf(rows, rec.accountability), "declaracao_rateio.pdf"); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/feac/:id/fluxo", requireAuth, (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { id, rec } = owned;
    let p = path.join(dir(id), "fluxo_atualizado.xlsx");
    if (!fs.existsSync(p)) p = path.join(dir(id), rec.sourceFiles?.fluxoCaixa || "fluxo.xlsx");
    if (!fs.existsSync(p)) return res.status(404).json({ error: "Planilha não encontrada" });
    res.download(p, "fluxo_de_caixa_atualizado.xlsx");
  });

  app.get("/api/feac/:id/zip", requireAuth, (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    const { id, rec } = owned;
    const recDir = dir(id);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="prestacao_contas_${id.slice(0, 8)}.zip"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (e: any) => { console.error("[feac zip]", e.message); try { res.status(500).end(); } catch { /* */ } });
    archive.pipe(res);
    const treatedDir = path.join(recDir, "treated");
    for (const l of rec.lancamentos || []) {
      const tp = path.join(treatedDir, `${l.id}.pdf`);
      if (l.treatedPdf && fs.existsSync(tp)) {
        archive.file(tp, { name: `documentos/${slugify(l.dataPagamento)}_${slugify(l.fornecedor)}_${slugify(String(Math.abs(l.saida)))}.pdf` });
      }
    }
    const rateio = path.join(recDir, "declaracao_rateio.pdf");
    if (fs.existsSync(rateio)) archive.file(rateio, { name: "declaracao_rateio.pdf" });
    const fluxo = path.join(recDir, "fluxo_atualizado.xlsx");
    if (fs.existsSync(fluxo)) archive.file(fluxo, { name: "fluxo_de_caixa_atualizado.xlsx" });
    archive.finalize();
  });

  // ── DELETE /api/feac/:id ─────────────────────────────────────────────────────
  app.delete("/api/feac/:id", requireAuth, (req: any, res) => {
    const owned = loadOwned(req, res);
    if (!owned) return;
    fs.rmSync(dir(owned.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  console.log("[FEAC] routes registered (/api/feac)");
}
