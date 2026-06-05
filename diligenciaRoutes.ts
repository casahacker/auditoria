/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Diligência de Fornecedores (Tool C) — backend.
 *
 * Para um CNPJ: consulta a Receita (BrasilAPI) + listas de restrição do Portal da
 * Transparência (CEIS, CNEP, CEPIM, Acordos de Leniência) e gera um relatório de
 * diligência auditável e exportável (HTML para impressão/PDF + TXT). Cada consulta
 * é registrada com data-hora, IP, APIs e metadados verificáveis; validade de 30 dias.
 *
 * Persistência: DATA_DIR/diligencia/{cnpj}.json
 * Base de fornecedores: agregada de DATA_DIR/audits + DATA_DIR/feac
 *
 * Nota: o filtro por CNPJ da API do Portal da Transparência é inoperante (retorna a
 * lista inteira); o filtro por NOME (nomeSancionado) funciona — consultamos por razão
 * social e filtramos os resultados pelo CNPJ exato.
 */
import type { Express, RequestHandler } from "express";
import path from "path";
import fs from "fs";
import crypto from "node:crypto";

const PT_BASE = "https://api.portaldatransparencia.gov.br/api-de-dados/";
const VALIDADE_DIAS = 30;
// #104: conjunto canônico das fontes de restrição consultadas por runDiligence. SOURCES_VERSION é
// um hash curto desse conjunto — muda sozinho quando uma fonte entra/sai (ordem não importa).
// Um registro gravado sob versão ANTERIOR é tratado como DESATUALIZADO (re-rodado pelo sweep mesmo
// dentro dos 30 dias), então toda fonte nova faz backfill automático da base, sem ação manual.
export const DILIGENCE_SOURCES = ["ceis", "cnep", "cepim", "acordos-leniencia", "lista-suja", "ofac-sdn", "ofac-cons", "un-sc", "eu-fsf", "idb", "uk-sanctions", "tcu-inidoneos", "tce-sp-apenados", "pep"];
export const SOURCES_VERSION = crypto.createHash("sha1").update([...DILIGENCE_SOURCES].sort().join(",")).digest("hex").slice(0, 8);
// #103: commit da plataforma que gerou o relatório (injetado no build via ARG/ENV APP_COMMIT; vazio se ausente).
const APP_COMMIT = process.env.APP_COMMIT || "";
// fornecedores importados manualmente (lista/CSV), em DATA_DIR (fora de diligencia/)
const EXTRA_SUPPLIERS_FILE = "diligencia-extra-suppliers.json";
// A API do Portal devolve 15 registros por página e ignora `tamanhoPagina`. Como o
// filtro por CNPJ é inoperante (ver consultaPT), paginamos por NOME e filtramos pelo
// CNPJ exato — varrendo todas as páginas para não perder uma sanção além da 1ª página.
const PT_PAGE_SIZE = 15;
const PT_MAX_PAGES = 25; // teto de segurança: até 375 registros por razão social

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
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PT_HEADERS = () => ({ "Accept": "application/json", "User-Agent": "StackAudit/1.0 (+https://stack-audit.casahacker.org)", "chave-api-dados": process.env.PORTAL_TRANSPARENCIA_KEY || "" });
const HTTP_HEADERS = { "Accept": "application/json", "User-Agent": "StackAudit/1.0 (+https://stack-audit.casahacker.org)" };

// ── rate limit global das APIs externas ─────────────────────────────────────────
// No máximo RATE_PER_MIN chamadas HTTP por minuto (janela deslizante) para TODAS as
// fontes externas da diligência (Receita + cada página do Portal da Transparência),
// protegendo a cota da API. A aquisição de vaga é serializada (sem corrida no array);
// as requisições correm em paralelo depois de obter a vaga.
const RATE_PER_MIN = Math.max(1, Number(process.env.DILIGENCIA_RATE_PER_MIN || 100));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

function createRateLimiter(max: number, windowMs: number) {
  const hits: number[] = [];
  let gate: Promise<void> = Promise.resolve();
  return function acquire(): Promise<void> {
    const p = gate.then(async () => {
      for (;;) {
        const now = Date.now();
        while (hits.length && now - hits[0] >= windowMs) hits.shift();
        if (hits.length < max) { hits.push(now); return; }
        await sleep(windowMs - (now - hits[0]) + 10);
      }
    });
    gate = p.catch(() => {});
    return p;
  };
}
const acquireSlot = createRateLimiter(RATE_PER_MIN, 60_000);

/** fetch com rate limit global + recuo em 429 (respeita Retry-After, até `retries` vezes). */
async function limitedFetch(url: string, init: RequestInit, retries = 2): Promise<Response> {
  await acquireSlot();
  const r = await fetch(url, init);
  if (r.status === 429 && retries > 0) {
    const ra = Number(r.headers.get("retry-after"));
    await sleep((Number.isFinite(ra) && ra > 0 ? Math.min(ra, 90) : 20) * 1000);
    return limitedFetch(url, init, retries - 1);
  }
  return r;
}

// ── external lookups ──────────────────────────────────────────────────────────

async function fetchReceitaRaw(cnpj: string): Promise<any> {
  let best: any = null; // melhor candidato SEM logradouro (usado se nenhuma fonte trouxer endereço)
  try {
    const r = await limitedFetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      const out: any = {
        fonte: "BrasilAPI (Receita Federal)", apiUrl: `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, fetchedAt: new Date().toISOString(),
        razao_social: d.razao_social, nome_fantasia: d.nome_fantasia, tipo: d.descricao_identificador_matriz_filial,
        situacao_cadastral: d.descricao_situacao_cadastral, data_situacao: d.data_situacao_cadastral, motivo_situacao: d.descricao_motivo_situacao_cadastral,
        natureza_juridica: d.natureza_juridica, porte: d.porte, abertura: d.data_inicio_atividade,
        capital_social: d.capital_social != null ? Number(d.capital_social).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "",
        logradouro: d.logradouro, numero: d.numero, complemento: d.complemento, bairro: d.bairro, municipio: d.municipio, uf: d.uf, cep: d.cep,
        email: d.email, telefone: [d.ddd_telefone_1, d.ddd_telefone_2].filter(Boolean).join(" / "),
        cnae_principal: d.cnae_fiscal ? `${d.cnae_fiscal} - ${d.cnae_fiscal_descricao}` : "",
        cnaes_secundarios: Array.isArray(d.cnaes_secundarios) ? d.cnaes_secundarios.filter((c: any) => c.codigo).map((c: any) => `${c.codigo} - ${c.descricao}`) : [],
        qsa: Array.isArray(d.qsa) ? d.qsa.map((s: any) => ({ nome: s.nome_socio, qual: s.qualificacao_socio, entrada: s.data_entrada_sociedade, faixa: s.faixa_etaria })) : [],
      };
      if (out.logradouro) return out; best = best || out; // BrasilAPI às vezes vem sem endereço → tenta próxima fonte
    }
  } catch { /* fall through */ }
  try {
    const r = await limitedFetch(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      const out: any = {
        fonte: "ReceitaWS (Receita Federal)", apiUrl: `https://www.receitaws.com.br/v1/cnpj/${cnpj}`, fetchedAt: new Date().toISOString(),
        razao_social: d.nome, nome_fantasia: d.fantasia, tipo: d.tipo, situacao_cadastral: d.situacao, data_situacao: d.data_situacao, motivo_situacao: d.motivo_situacao,
        natureza_juridica: typeof d.natureza_juridica === "object" ? d.natureza_juridica?.descricao : d.natureza_juridica,
        porte: d.porte, abertura: d.abertura, capital_social: d.capital_social,
        logradouro: d.logradouro, numero: d.numero, complemento: d.complemento, bairro: d.bairro, municipio: d.municipio, uf: d.uf, cep: d.cep,
        email: d.email, telefone: d.telefone,
        cnae_principal: Array.isArray(d.atividade_principal) && d.atividade_principal[0] ? `${d.atividade_principal[0].code} - ${d.atividade_principal[0].text}` : "",
        cnaes_secundarios: Array.isArray(d.atividades_secundarias) ? d.atividades_secundarias.filter((c: any) => c.code && c.code !== "00.00-0-00").map((c: any) => `${c.code} - ${c.text}`) : [],
        qsa: Array.isArray(d.qsa) ? d.qsa.map((s: any) => ({ nome: s.nome, qual: s.qual })) : [],
      };
      if (out.logradouro) return out; best = best || out;
    }
  } catch { /* */ }
  // 3º fallback: CNPJá (open) — quando as anteriores falham ou vêm sem endereço
  try {
    const r = await limitedFetch(`https://open.cnpja.com/office/${cnpj}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json(); const a = d.address || {};
      const out: any = {
        fonte: "CNPJá (Receita Federal)", apiUrl: `https://open.cnpja.com/office/${cnpj}`, fetchedAt: new Date().toISOString(),
        razao_social: d.company?.name, nome_fantasia: d.alias || "", tipo: d.head ? "MATRIZ" : "FILIAL",
        situacao_cadastral: d.status?.text, data_situacao: d.statusDate, motivo_situacao: d.reason?.text || "",
        natureza_juridica: d.company?.nature?.text, porte: d.company?.size?.text, abertura: d.founded,
        capital_social: d.company?.equity != null ? Number(d.company.equity).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "",
        logradouro: a.street, numero: a.number, complemento: a.details, bairro: a.district, municipio: a.city, uf: a.state, cep: a.zip,
        email: Array.isArray(d.emails) && d.emails[0] ? d.emails[0].address : "", telefone: Array.isArray(d.phones) && d.phones[0] ? `(${d.phones[0].area}) ${d.phones[0].number}` : "",
        cnae_principal: d.mainActivity ? `${d.mainActivity.id} - ${d.mainActivity.text}` : "",
        cnaes_secundarios: Array.isArray(d.sideActivities) ? d.sideActivities.map((x: any) => `${x.id} - ${x.text}`) : [],
        qsa: Array.isArray(d.members) ? d.members.map((m: any) => ({ nome: m.person?.name, qual: m.role?.text })) : [],
      };
      if (out.logradouro) return out; best = best || out;
    }
  } catch { /* */ }
  return best; // nenhuma fonte com logradouro → melhor disponível (o CEP completa o endereço)
}

export interface CepData { cep: string; logradouro: string; bairro: string; municipio: string; uf: string; fonte: string; apiUrl: string; }

/**
 * Consulta de CEP com CADEIA DE FALLBACK entre provedores: BrasilAPI v2 → ViaCEP →
 * BrasilAPI v1 → OpenCEP. Retorna o 1º que responder com endereço, normalizado. `doFetch`
 * permite usar o rate limiter (diligência) ou fetch direto (endpoint público).
 */
export async function lookupCep(cepRaw: string, doFetch: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): Promise<CepData | null> {
  const cep = onlyDigits(cepRaw);
  if (cep.length !== 8) return null;
  const init = { headers: HTTP_HEADERS, signal: AbortSignal.timeout(8000) } as RequestInit;
  const sources: { url: string; fonte: string; map: (c: any) => Partial<CepData> | null }[] = [
    { url: `https://brasilapi.com.br/api/cep/v2/${cep}`, fonte: "BrasilAPI (CEP)", map: (c) => (c.street || c.city) ? { logradouro: c.street, bairro: c.neighborhood, municipio: c.city, uf: c.state, cep: c.cep } : null },
    { url: `https://viacep.com.br/ws/${cep}/json/`, fonte: "ViaCEP", map: (c) => (!c.erro && (c.logradouro || c.localidade)) ? { logradouro: c.logradouro, bairro: c.bairro, municipio: c.localidade, uf: c.uf, cep: c.cep } : null },
    { url: `https://brasilapi.com.br/api/cep/v1/${cep}`, fonte: "BrasilAPI (CEP v1)", map: (c) => (c.street || c.city) ? { logradouro: c.street, bairro: c.neighborhood, municipio: c.city, uf: c.state, cep: c.cep } : null },
    { url: `https://opencep.com/v1/${cep}`, fonte: "OpenCEP", map: (c) => (c.logradouro || c.localidade) ? { logradouro: c.logradouro, bairro: c.bairro, municipio: c.localidade, uf: c.uf, cep: c.cep } : null },
  ];
  for (const s of sources) {
    try {
      const r = await doFetch(s.url, init);
      if (!r.ok) continue;
      const m = s.map(await r.json());
      if (m) return { cep: m.cep || cep, logradouro: m.logradouro || "", bairro: m.bairro || "", municipio: m.municipio || "", uf: m.uf || "", fonte: s.fonte, apiUrl: s.url };
    } catch { /* tenta o próximo provedor */ }
  }
  return null;
}

/**
 * Padroniza o endereço pela API de CEP (cadeia de fallback): logradouro/bairro/município/UF
 * passam a vir do CEP (mais consistente/completo que a Receita, sobretudo em MEIs). Número e
 * complemento permanecem da Receita. Tolerante a falha (não derruba a consulta).
 */
async function enrichCep(o: any): Promise<void> {
  try {
    const c = await lookupCep(o?.cep, limitedFetch);
    if (!c) return;
    if (c.logradouro) o.logradouro = c.logradouro;
    if (c.bairro) o.bairro = c.bairro;
    if (c.municipio) o.municipio = c.municipio;
    if (c.uf) o.uf = c.uf;
    o.cepFonte = c.fonte; o.cepApiUrl = c.apiUrl; o.cepFetchedAt = new Date().toISOString();
  } catch { /* CEP é complementar */ }
}

/** Receita Federal (BrasilAPI → ReceitaWS) + enriquecimento de endereço por CEP. */
export async function fetchReceita(cnpj: string): Promise<any> {
  const out = await fetchReceitaRaw(cnpj);
  if (out) await enrichCep(out);
  return out;
}

function recordMatchesCnpj(x: any, cnpjDigits: string): boolean {
  const fields = [x?.pessoa?.cnpjFormatado, x?.pessoa?.numeroInscricaoSocial, x?.cnpjFormatado, x?.cnpj].filter(Boolean);
  if (fields.some((f: any) => onlyDigits(f) === cnpjDigits)) return true;
  return onlyDigits(JSON.stringify(x || {})).includes(cnpjDigits);
}

function mapSancao(x: any): any {
  return {
    tipo: x.tipoSancao?.descricaoResumida || x.tipoSancao?.descricaoPortal || (typeof x.tipoSancao === "string" ? x.tipoSancao : "") || "Sanção",
    orgao: x.orgaoSancionador?.nome || x.orgaoSancionador?.siglaUf || "",
    dataInicio: x.dataInicioSancao || "", dataFim: x.dataFimSancao || "",
    fundamentacao: Array.isArray(x.fundamentacao) ? x.fundamentacao.map((f: any) => f.descricao || f.descricaoResumida).filter(Boolean).join("; ") : "",
    processo: x.numeroProcesso || "", nome: x.pessoa?.razaoSocialReceita || x.pessoa?.nome || "",
  };
}

/**
 * Consulta uma lista de restrição do Portal da Transparência por razão social e
 * filtra os resultados pelo CNPJ EXATO. O parâmetro de CNPJ da API é inoperante
 * (devolve a lista inteira), então o filtro confiável é por nome — mas o nome pode
 * retornar dezenas de homônimos espalhados por várias páginas (15/página). Por isso
 * percorremos as páginas até a última (ou até PT_MAX_PAGES), acumulando apenas os
 * registros cujo CNPJ bate exatamente com o do fornecedor.
 */
export async function consultaPT(recurso: string, label: string, razaoSocial: string, cnpjDigits: string): Promise<any> {
  const urlForPage = (p: number) => `${PT_BASE}${recurso}?nomeSancionado=${encodeURIComponent(razaoSocial)}&pagina=${p}`;
  const apiUrl = urlForPage(1);
  const consultaPublica: Record<string, string> = {
    ceis: "https://portaldatransparencia.gov.br/sancoes/ceis", cnep: "https://portaldatransparencia.gov.br/sancoes/cnep",
    cepim: "https://portaldatransparencia.gov.br/sancoes/cepim", "acordos-leniencia": "https://portaldatransparencia.gov.br/acordos-leniencia",
  };
  const base: any = { fonte: label, recurso, url: consultaPublica[recurso], apiUrl, fetchedAt: new Date().toISOString(), metodo: "GET", param: "Nome", cache: false };
  if (!process.env.PORTAL_TRANSPARENCIA_KEY) return { ...base, status: "PENDENTE", hits: [], erro: "Chave da API não configurada" };

  const hits: any[] = [];
  let paginasLidas = 0, registros = 0, truncado = false;
  const t0 = Date.now();
  try {
    for (let pagina = 1; pagina <= PT_MAX_PAGES; pagina++) {
      const r = await limitedFetch(urlForPage(pagina), { headers: PT_HEADERS(), signal: AbortSignal.timeout(15000) });
      base.http = r.status; base.ms = Date.now() - t0;
      if (!r.ok) {
        if (paginasLidas === 0) return { ...base, status: "ERRO", http: r.status, hits: [] };
        break; // já lemos páginas; interrompe na falha e usa o que temos
      }
      const arr = await r.json();
      const lista = Array.isArray(arr) ? arr : [];
      paginasLidas++; registros += lista.length;
      for (const x of lista) if (recordMatchesCnpj(x, cnpjDigits)) hits.push(mapSancao(x));
      if (lista.length < PT_PAGE_SIZE) break;          // última página
      if (pagina === PT_MAX_PAGES) truncado = true;    // atingiu o teto sem esgotar
    }
    return { ...base, status: hits.length ? "CONSTA" : "NADA_CONSTA", hits, paginasLidas, registros, ...(truncado ? { truncado: true } : {}) };
  } catch (e: any) {
    base.ms = Date.now() - t0;
    if (hits.length) return { ...base, status: "CONSTA", hits, paginasLidas, registros, parcial: true, erro: e.message };
    return { ...base, status: "ERRO", erro: e.message, hits: [] };
  }
}

// ── listas extras: Lista Suja (trabalho escravo), OFAC SDN, PEP ──────────────────
const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Baixa e cacheia um arquivo de fonte (SDN, Lista Suja) em DATA_DIR/sources, com TTL; usa cache vencido em caso de falha.
 *  #103: `meta` (opcional) recebe a proveniência técnica — cache vs ao vivo, idade do cache, data da
 *  cópia local (frescor da lista), HTTP e latência do download. */
async function cachedSourceFile(DATA_DIR: string, name: string, url: string, ttlMs: number, decode: "utf8" | "latin1", meta?: any): Promise<string | null> {
  const dir = path.join(DATA_DIR, "sources"); fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  const enc = decode === "latin1" ? "latin1" : "utf-8";
  const stampCache = (stale: boolean) => { try { const st = fs.statSync(fp); if (meta) { meta.cache = true; meta.stale = stale; meta.cacheAge = Date.now() - st.mtimeMs; meta.sourceUpdatedAt = new Date(st.mtimeMs).toISOString(); } } catch { /* */ } };
  try { if (Date.now() - fs.statSync(fp).mtimeMs < ttlMs) { stampCache(false); return fs.readFileSync(fp, enc as BufferEncoding); } } catch { /* sem cache */ }
  const t0 = Date.now();
  try {
    const r = await limitedFetch(url, { headers: { "User-Agent": "casahacker-auditoria/1.0", Accept: "*/*" }, signal: AbortSignal.timeout(60000) }, 1);
    if (meta) { meta.http = r.status; meta.ms = Date.now() - t0; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(fp, buf);
    if (meta) { meta.cache = false; meta.stale = false; meta.cacheAge = 0; try { meta.sourceUpdatedAt = new Date(fs.statSync(fp).mtimeMs).toISOString(); } catch { /* */ } }
    return buf.toString(enc as BufferEncoding);
  } catch { try { const txt = fs.readFileSync(fp, enc as BufferEncoding); stampCache(true); return txt; } catch { return null; } }
}

const LISTA_SUJA_URL = process.env.LISTA_SUJA_URL || "https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/areas-de-atuacao/cadastro_de_empregadores.csv";
/** Cadastro de Empregadores (trabalho análogo ao de escravo) — match por CNPJ/CPF EXATO (definitivo → CONSTA). */
async function consultaListaSuja(DATA_DIR: string, cnpj: string, cpfsExtras: string[] = []): Promise<any> {
  const base: any = { fonte: "Cadastro de Empregadores — trabalho análogo ao de escravo (MTE)", recurso: "lista-suja", url: "https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho", apiUrl: LISTA_SUJA_URL, fetchedAt: new Date().toISOString(), metodo: "GET" };
  const meta: any = {}; const csv = await cachedSourceFile(DATA_DIR, "lista-suja.csv", LISTA_SUJA_URL, 7 * 86400000, "latin1", meta); Object.assign(base, meta);
  if (!csv) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar o cadastro do MTE" };
  const alvo = new Set([onlyDigits(cnpj), ...cpfsExtras.map(onlyDigits)].filter(Boolean));
  const lines = csv.split(/\r?\n/); const hits: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(";"); if (c.length < 5) continue;
    const doc = onlyDigits(c[4]);
    if (doc && alvo.has(doc)) hits.push({ tipo: `Trabalho análogo ao de escravo — ${String(c[3] || "").trim()}`, orgao: `MTE · ${c[2] || "?"} · ${c[6] || "?"} trabalhador(es) · ação fiscal ${c[1] || "?"}`, dataInicio: c[1] || "", processo: String(c[9] || c[0] || "").trim() });
  }
  return { ...base, status: hits.length ? "CONSTA" : "NADA_CONSTA", hits, registros: lines.length - 1 };
}

const OFAC_SDN_URL = process.env.OFAC_SDN_URL || "https://www.treasury.gov/ofac/downloads/sdn.csv";
function parseCsvLine(line: string): string[] { const out: string[] = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else { if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } } out.push(cur); return out; }
/** OFAC SDN (sanções dos EUA) — match por NOME (razão social + sócios). Conservador → ATENÇÃO (revisar, não auto-inelegível). */
async function consultaOFAC(DATA_DIR: string, nomes: string[]): Promise<any> {
  const base: any = { fonte: "OFAC SDN — Sanções dos EUA (Tesouro)", recurso: "ofac-sdn", url: "https://sanctionssearch.ofac.treas.gov/", apiUrl: OFAC_SDN_URL, fetchedAt: new Date().toISOString(), metodo: "GET" };
  const alvos = Array.from(new Set(nomes.map(norm))).filter((n) => n.length >= 8 && n.split(" ").length >= 2);
  if (!alvos.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const meta: any = {}; const csv = await cachedSourceFile(DATA_DIR, "sdn.csv", OFAC_SDN_URL, 3 * 86400000, "utf8", meta); Object.assign(base, meta);
  if (!csv) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar a SDN List" };
  const hits: any[] = []; const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line[0] === '"' && line.indexOf('","') === -1) { /* */ }
    const c = parseCsvLine(line); const sdn = norm(c[1]); if (sdn.length < 4) continue;
    for (const alvo of alvos) if (sdn.includes(alvo)) { hits.push({ tipo: `Possível correspondência OFAC SDN: "${String(c[1] || "").trim()}"`, orgao: `OFAC · ${String(c[2] || "").trim()} · ${String(c[3] || "").trim()} · CONFIRMAR identidade`, processo: String(c[0] || "").trim() }); break; }
  }
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits, ...(hits.length ? { nota: "Correspondência por nome — confirme a identidade antes de qualquer ação." } : {}) };
}

const OFAC_CONS_URL = process.env.OFAC_CONS_URL || "https://www.treasury.gov/ofac/downloads/consolidated/cons_prim.csv";
/** OFAC Consolidated (não-SDN) — mesmo formato do SDN; match por NOME. Conservador → ATENÇÃO. */
async function consultaOFACCons(DATA_DIR: string, nomes: string[]): Promise<any> {
  const base: any = { fonte: "OFAC Consolidated (não-SDN) — EUA (Tesouro)", recurso: "ofac-cons", url: "https://sanctionssearch.ofac.treas.gov/", apiUrl: OFAC_CONS_URL, fetchedAt: new Date().toISOString(), metodo: "GET" };
  const alvos = Array.from(new Set(nomes.map(norm))).filter((n) => n.length >= 8 && n.split(" ").length >= 2);
  if (!alvos.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const meta: any = {}; const csv = await cachedSourceFile(DATA_DIR, "ofac-cons.csv", OFAC_CONS_URL, 3 * 86400000, "utf8", meta); Object.assign(base, meta);
  if (!csv) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar a Consolidated List" };
  const hits: any[] = []; const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    const c = parseCsvLine(line); const nm = norm(c[1]); if (nm.length < 4) continue;
    for (const alvo of alvos) if (nm.includes(alvo)) { hits.push({ tipo: `Possível correspondência OFAC Consolidated: "${String(c[1] || "").trim()}"`, orgao: `OFAC · ${String(c[2] || "").trim()} · ${String(c[3] || "").trim()} · CONFIRMAR identidade`, processo: String(c[0] || "").trim() }); break; }
  }
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits, ...(hits.length ? { nota: "Correspondência por nome — confirme a identidade." } : {}) };
}

const UN_SC_URL = process.env.UN_SC_URL || "https://scsanctions.un.org/resources/xml/en/consolidated.xml";
/** UN Security Council Consolidated List (XML) — match por NOME (razão + sócios). Conservador → ATENÇÃO. */
async function consultaUN(DATA_DIR: string, nomes: string[]): Promise<any> {
  const base: any = { fonte: "UN Security Council Consolidated List", recurso: "un-sc", url: "https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list", apiUrl: UN_SC_URL, fetchedAt: new Date().toISOString(), metodo: "GET" };
  const alvos = Array.from(new Set(nomes.map(norm))).filter((n) => n.length >= 8 && n.split(" ").length >= 2);
  if (!alvos.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const meta: any = {}; const xml = await cachedSourceFile(DATA_DIR, "un-consolidated.xml", UN_SC_URL, 3 * 86400000, "utf8", meta); Object.assign(base, meta);
  if (!xml) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar a UN Consolidated List" };
  const hits: any[] = [];
  const blocks = xml.match(/<(INDIVIDUAL|ENTITY)>[\s\S]*?<\/\1>/g) || [];
  for (const b of blocks) {
    const parts = [...b.matchAll(/<(?:FIRST|SECOND|THIRD|FOURTH)_NAME>([^<]+)<\/(?:FIRST|SECOND|THIRD|FOURTH)_NAME>/g)].map((m) => m[1].trim()).filter(Boolean);
    const nome = parts.join(" "); const n = norm(nome); if (n.length < 4) continue;
    for (const alvo of alvos) if (n.includes(alvo)) { const ref = (b.match(/<REFERENCE_NUMBER>([^<]+)</) || [])[1] || ""; hits.push({ tipo: `Possível correspondência ONU: "${nome}"`, orgao: `UN Security Council · ${ref} · CONFIRMAR identidade`, processo: ref }); break; }
  }
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits, ...(hits.length ? { nota: "Correspondência por nome — confirme a identidade." } : {}) };
}

// token público (mesmo que o OpenSanctions usa) — base64 de "token-2017"; sem registro
const EU_FSF_URL = process.env.EU_FSF_URL || "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";
/** EU — Lista Consolidada de Sanções Financeiras (CFSP/FSF, XML) — match por NOME. Conservador → ATENÇÃO. */
async function consultaEU(DATA_DIR: string, nomes: string[]): Promise<any> {
  const base: any = { fonte: "EU — Lista Consolidada de Sanções Financeiras (CFSP)", recurso: "eu-fsf", url: "https://www.sanctionsmap.eu/", apiUrl: EU_FSF_URL, fetchedAt: new Date().toISOString(), metodo: "GET" };
  const alvos = Array.from(new Set(nomes.map(norm))).filter((n) => n.length >= 8 && n.split(" ").length >= 2);
  if (!alvos.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const meta: any = {}; const xml = await cachedSourceFile(DATA_DIR, "eu-fsf.xml", EU_FSF_URL, 3 * 86400000, "utf8", meta); Object.assign(base, meta);
  if (!xml) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar a lista da UE" };
  const matched = new Set<string>();
  for (const m of xml.matchAll(/wholeName="([^"]{3,120})"/g)) { const nm = m[1]; const n = norm(nm); if (n.length < 4) continue; for (const a of alvos) if (n.includes(a)) { matched.add(nm); break; } }
  const hits = [...matched].slice(0, 20).map((nm) => ({ tipo: `Possível correspondência UE: "${nm}"`, orgao: "EU CFSP · CONFIRMAR identidade" }));
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits, ...(hits.length ? { nota: "Correspondência por nome — confirme a identidade." } : {}) };
}

const IDB_URL = process.env.IDB_URL || "https://data.iadb.org/file/download/f5022f04-a3f1-4604-a099-5d562e3a0aa5";
/** Inter-American Development Bank (BID) — firmas/indivíduos sancionados (CSV) — match por NOME. Conservador → ATENÇÃO. */
async function consultaIDB(DATA_DIR: string, nomes: string[]): Promise<any> {
  const base: any = { fonte: "Inter-American Development Bank (BID) — Sancionados", recurso: "idb", url: "https://data.iadb.org/dataset/dataset-of-sanctioned-firms-and-individuals", apiUrl: IDB_URL, fetchedAt: new Date().toISOString(), metodo: "GET" };
  const alvos = Array.from(new Set(nomes.map(norm))).filter((n) => n.length >= 8 && n.split(" ").length >= 2);
  if (!alvos.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const meta: any = {}; const csv = await cachedSourceFile(DATA_DIR, "idb.csv", IDB_URL, 7 * 86400000, "utf8", meta); Object.assign(base, meta);
  if (!csv) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar a lista do BID" };
  const hits: any[] = []; const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i].replace(/^﻿/, "")); const nm = norm(c[0]); const other = norm(c[10] || ""); if (nm.length < 4) continue;
    for (const a of alvos) if (nm.includes(a) || (other.length >= 8 && other.includes(a))) { hits.push({ tipo: `Possível correspondência BID: "${String(c[0] || "").trim()}"`, orgao: `IDB · ${String(c[6] || "").trim()} · ${String(c[4] || "").trim()} · CONFIRMAR identidade`, processo: String(c[7] || "").trim() }); break; }
  }
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits, ...(hits.length ? { nota: "Correspondência por nome — confirme a identidade." } : {}) };
}

const UK_SANCTIONS_URL = process.env.UK_SANCTIONS_URL || "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv";
/** UK Sanctions List (FCDO/OFSI, CSV) — match por NOME. Conservador → ATENÇÃO. */
async function consultaUK(DATA_DIR: string, nomes: string[]): Promise<any> {
  const base: any = { fonte: "UK Sanctions List (FCDO)", recurso: "uk-sanctions", url: "https://www.gov.uk/government/publications/the-uk-sanctions-list", apiUrl: UK_SANCTIONS_URL, fetchedAt: new Date().toISOString(), metodo: "GET" };
  const alvos = Array.from(new Set(nomes.map(norm))).filter((n) => n.length >= 8 && n.split(" ").length >= 2);
  if (!alvos.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const meta: any = {}; const csv = await cachedSourceFile(DATA_DIR, "uk-sanctions.csv", UK_SANCTIONS_URL, 3 * 86400000, "utf8", meta); Object.assign(base, meta);
  if (!csv) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar a UK Sanctions List" };
  const lines = csv.split(/\r?\n/);
  let h = lines.findIndex((l) => l.startsWith("Last Updated")); if (h < 0) h = 0;
  const matched = new Set<string>();
  for (let i = h + 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]); if (c.length < 10) continue;
    const nome = [c[5], c[6], c[7], c[8], c[9], c[4]].map((s) => String(s || "").trim()).filter(Boolean).join(" "); // Name 1..6
    const n = norm(nome); if (n.length < 4) continue;
    for (const a of alvos) if (n.includes(a)) { matched.add(nome); break; }
  }
  const hits = [...matched].slice(0, 20).map((nm) => ({ tipo: `Possível correspondência Reino Unido: "${nm}"`, orgao: "UK Sanctions List · CONFIRMAR identidade" }));
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits, ...(hits.length ? { nota: "Correspondência por nome — confirme a identidade." } : {}) };
}

/** PEP (Pessoas Expostas Politicamente) — checa os sócios (QSA) por nome no Portal da Transparência → ATENÇÃO (informativo). */
const TCU_INIDONEOS_URL = process.env.TCU_INIDONEOS_URL || "https://certidoes.apps.tcu.gov.br/api/publico/responsaveis-inidoneos";
// Licitantes declarados inidôneos pelo TCU (art. 46 da Lei 8.443/1992). Consulta pontual por
// CNPJ no webservice público (filtro server-side, reconferido localmente); match por CNPJ é
// exato → CONSTA (não ATENCAO). O container resolve certidoes.apps.tcu.gov.br normalmente.
export async function consultaTCU(cnpjDigits: string): Promise<any> {
  const base: any = { fonte: "TCU — Licitantes Inidôneos", recurso: "tcu-inidoneos", url: "https://portal.tcu.gov.br/carta-de-servicos/certidoes/lista-de-licitantes-inidoneos", apiUrl: TCU_INIDONEOS_URL, fetchedAt: new Date().toISOString(), metodo: "POST", param: "CNPJ", cache: false };
  if (cnpjDigits.length !== 14) return { ...base, status: "NADA_CONSTA", hits: [] };
  const t0 = Date.now();
  try {
    const r = await limitedFetch(TCU_INIDONEOS_URL, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ cnpj: cnpjDigits }), signal: AbortSignal.timeout(20000) });
    base.http = r.status; base.ms = Date.now() - t0;
    if (!r.ok) return { ...base, status: "ERRO", hits: [] };
    const arr = await r.json();
    const lista = Array.isArray(arr) ? arr : [];
    const hits = lista.filter((x: any) => onlyDigits(x.numeroRegistro) === cnpjDigits).map((x: any) => ({
      tipo: `Licitante inidôneo — ${x.nome || "?"}`,
      orgao: `TCU · Acórdão ${x.numeroAcordaoFormatado || "?"}${x.municipio ? ` · ${x.municipio}/${x.uf || ""}` : ""}`,
      dataInicio: x.dataTransitoEmJulgado || x.dataAcordao || "",
      dataFim: x.dataFinalSancao || "",
      processo: x.numeroProcessoFormatado || "",
    }));
    return { ...base, status: hits.length ? "CONSTA" : "NADA_CONSTA", hits, registros: lista.length };
  } catch (e: any) {
    base.ms = Date.now() - t0;
    return { ...base, status: "ERRO", erro: e.message, hits: [] };
  }
}

const TCE_SP_URL = process.env.TCE_SP_URL || "https://www4.tce.sp.gov.br/apenados/webapi/P/impedimento";
/**
 * Relação de Apenados do TCE-SP — impedidos de licitar/contratar com a Administração (estadual +
 * municipal de SP). Consulta JSON AO VIVO por CNPJ: a webapi de leitura não exige o Turnstile do SPA
 * e o container resolve o host (igual ao TCU). Match exato por CNPJ. Vigência (decisão do Geraldo):
 * término ≥ hoje ou null → CONSTA (vigente, eleva ALERTA); término < hoje → ATENÇÃO (histórico/
 * reabilitado, informativo) — evita falso-positivo de empresa já reabilitada.
 */
export async function consultaTCESP(cnpjDigits: string): Promise<any> {
  const apiUrl = `${TCE_SP_URL}?apenadoCnpj=${cnpjDigits}`;
  const base: any = { fonte: "TCE-SP — Relação de Apenados", recurso: "tce-sp-apenados", url: "https://www.tce.sp.gov.br/apenados", apiUrl, fetchedAt: new Date().toISOString(), metodo: "GET", param: "CNPJ", cache: false };
  if (cnpjDigits.length !== 14) return { ...base, status: "NADA_CONSTA", hits: [] };
  const fmtData = (a: any) => Array.isArray(a) && a.length === 3 ? `${String(a[2]).padStart(2, "0")}/${String(a[1]).padStart(2, "0")}/${a[0]}` : "";
  const t0 = Date.now();
  try {
    const r = await limitedFetch(apiUrl, { headers: { Accept: "application/json", "User-Agent": "casahacker-auditoria/1.0" }, signal: AbortSignal.timeout(20000) });
    base.http = r.status; base.ms = Date.now() - t0;
    if (!r.ok) return { ...base, status: "ERRO", hits: [] };
    const arr = await r.json();
    const lista = Array.isArray(arr) ? arr : [];
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    let algumVigente = false;
    const hits = lista.filter((h: any) => onlyDigits(h?.apenado?.cnpj) === cnpjDigits).map((h: any) => {
      const term = Array.isArray(h.termino) && h.termino.length === 3 ? new Date(h.termino[0], h.termino[1] - 1, h.termino[2]) : null; // mês 1-indexado; null = vigente
      const vigente = !term || term >= hoje;
      if (vigente) algumVigente = true;
      return {
        tipo: `Impedido de licitar/contratar${vigente ? " (vigente)" : " (histórico)"} — ${String(h.tipoApenacao?.descricao || "").trim()}`,
        orgao: `TCE-SP · ${String(h.apenador?.nome || "").trim()}`,
        dataInicio: fmtData(h.inicio), dataFim: term ? fmtData(h.termino) : "",
        processo: String(h.processo || "").trim(),
        fundamentacao: String(h.razao || "").trim().slice(0, 300),
      };
    });
    if (!hits.length) return { ...base, status: "NADA_CONSTA", hits: [], registros: lista.length };
    return { ...base, status: algumVigente ? "CONSTA" : "ATENCAO", hits, registros: lista.length, ...(algumVigente ? {} : { nota: "Apenação(ões) com término já decorrido (histórico/reabilitado) — informativo." }) };
  } catch (e: any) {
    base.ms = Date.now() - t0;
    return { ...base, status: "ERRO", erro: e.message, hits: [] };
  }
}

/**
 * PEP (Pessoas Expostas Politicamente, CGU). Consulta por NOME (sócios do QSA e/ou
 * representante legal informado no KYS/KYG) e, opcionalmente, por CPF (representante
 * legal). A correspondência por nome é conservadora (norm exato); a por CPF só aceita
 * quando a API devolve o CPF completo e idêntico (evita falso-positivo se o filtro for
 * ignorado). Resultado é informativo → ATENCAO.
 */
export async function consultaPEP(qsaNomes: string[], cpfs: string[] = []): Promise<any> {
  const base: any = { fonte: "PEP — Pessoas Expostas Politicamente (CGU)", recurso: "pep", url: "https://portaldatransparencia.gov.br/pessoa-fisica/pep", apiUrl: `${PT_BASE}peps`, fetchedAt: new Date().toISOString(), metodo: "GET", param: "Nome/CPF", cache: false };
  if (!process.env.PORTAL_TRANSPARENCIA_KEY) return { ...base, status: "PENDENTE", hits: [], erro: "Chave da API não configurada" };
  const nomes = Array.from(new Set(qsaNomes.map((n) => String(n || "").trim()).filter((n) => norm(n).split(" ").length >= 2))).slice(0, 12);
  const cpfList = Array.from(new Set(cpfs.map(onlyDigits).filter((c) => c.length === 11))).slice(0, 6);
  if (!nomes.length && !cpfList.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const hits: any[] = []; const hoje = new Date();
  const pushHit = (p: any, via: string) => {
    const carenciaOk = !p.dt_fim_carencia || new Date(p.dt_fim_carencia) >= hoje;
    if (carenciaOk) hits.push({ tipo: `PEP: ${String(p.nome).trim()} — ${String(p.descricao_funcao || "").trim()} (${via})`, orgao: `${String(p.nome_orgao || "").trim()} · exercício ${p.dt_inicio_exercicio || "?"}–${p.dt_fim_exercicio || "?"}`, dataFim: p.dt_fim_carencia || "" });
  };
  const t0 = Date.now();
  try {
    for (const nome of nomes) {
      const r = await limitedFetch(`${PT_BASE}peps?nome=${encodeURIComponent(nome)}&pagina=1`, { headers: PT_HEADERS(), signal: AbortSignal.timeout(15000) });
      base.http = r.status; base.ms = Date.now() - t0;
      if (!r.ok) continue;
      const lista = await r.json();
      for (const p of Array.isArray(lista) ? lista : []) if (norm(p.nome) === norm(nome)) pushHit(p, "nome");
    }
    for (const cpf of cpfList) {
      const r = await limitedFetch(`${PT_BASE}peps?cpf=${cpf}&pagina=1`, { headers: PT_HEADERS(), signal: AbortSignal.timeout(15000) });
      base.http = r.status; base.ms = Date.now() - t0;
      if (!r.ok) continue;
      const lista = await r.json();
      // só aceita se a API devolveu o CPF COMPLETO e idêntico (o filtro server-side pode ser ignorado).
      for (const p of Array.isArray(lista) ? lista : []) if (onlyDigits(p.cpf) === cpf) pushHit(p, "CPF");
    }
  } catch (e: any) { return hits.length ? { ...base, status: "ATENCAO", hits: dedupHits(hits), parcial: true } : { ...base, status: "ERRO", erro: e.message, hits: [] }; }
  const uniq = dedupHits(hits);
  return { ...base, status: uniq.length ? "ATENCAO" : "NADA_CONSTA", hits: uniq };
}
const dedupHits = (hits: any[]): any[] => { const seen = new Set<string>(); return hits.filter((h) => { const k = norm(h.tipo); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** Representante legal do KYS mais recente para um CNPJ (p/ incluir na consulta PEP da diligência). */
export function latestKysRepLegal(DATA_DIR: string, cnpj: string): { nome: string; cpf: string } | null {
  const KYC_DIR = path.join(DATA_DIR, "kyc");
  let best: any = null;
  try {
    for (const f of fs.readdirSync(KYC_DIR)) {
      if (!f.endsWith(".json")) continue;
      let rec: any; try { rec = JSON.parse(fs.readFileSync(path.join(KYC_DIR, f), "utf-8")); } catch { continue; }
      if (rec?.type !== "kys" || onlyDigits(rec?.kys?.cnpj) !== onlyDigits(cnpj)) continue;
      if (!best || String(rec.createdAt) > String(best.createdAt)) best = rec;
    }
  } catch { /* sem diretório kyc ainda */ }
  if (!best?.kys?.repNome) return null;
  return { nome: String(best.kys.repNome || "").trim(), cpf: onlyDigits(best.kys.repCpf) };
}

// ── supplier base ─────────────────────────────────────────────────────────────

/**
 * Diligência completa de um CNPJ (Receita+CEP + listas de restrição CGU) com cache de
 * 30 dias e persistência em DATA_DIR/diligencia/{cnpj}.json. Em escopo de módulo p/ ser
 * reusada pelo cockpit de fornecedores (kycRoutes) além das próprias rotas de diligência.
 */
export async function runDiligence(DATA_DIR: string, cnpj: string, opts: { checkedBy?: string; ip?: string; userAgent?: string; force?: boolean } = {}): Promise<any> {
  const DIL_DIR = path.join(DATA_DIR, "diligencia");
  fs.mkdirSync(DIL_DIR, { recursive: true });
  const recPath = path.join(DIL_DIR, `${cnpj}.json`);
  const readRec = (): any => { try { return JSON.parse(fs.readFileSync(recPath, "utf-8")); } catch { return null; } };
  const isValid = (rec: any) => rec && rec.validUntil && new Date(rec.validUntil).getTime() > Date.now();
  const cached = readRec();
  // #104: além de vencido/forçado, re-roda quando o registro foi gerado sob uma VERSÃO ANTERIOR
  // do conjunto de fontes (senão o sweep enfileiraria mas o cache devolveria o registro velho).
  if (cached && isValid(cached) && cached.fontesVersao === SOURCES_VERSION && !opts.force) return { ...cached, fromCache: true };
  const t0run = Date.now(); // #103: tempo total da execução (só quando roda de fato, não no cache)
  const receita = await fetchReceita(cnpj);
  const razao = receita?.razao_social || cached?.razaoSocial || "";
  const apis: string[] = [];
  if (receita) apis.push(receita.fonte);
  let sancoes: any[] = [];
  if (razao) {
    const qsaNomes: string[] = (receita?.qsa || []).map((s: any) => s?.nome).filter(Boolean);
    // PEP cobre os sócios do QSA + o representante legal informado no KYS mais recente (#88).
    const rep = latestKysRepLegal(DATA_DIR, cnpj);
    const pepNomes = [...qsaNomes, ...(rep?.nome ? [rep.nome] : [])];
    const pepCpfs = rep?.cpf ? [rep.cpf] : [];
    sancoes = await Promise.all([
      consultaPT("ceis", "CEIS — Inidôneas e Suspensas", razao, cnpj),
      consultaPT("cnep", "CNEP — Empresas Punidas (Lei Anticorrupção)", razao, cnpj),
      consultaPT("cepim", "CEPIM — Entidades sem fins lucrativos impedidas", razao, cnpj),
      consultaPT("acordos-leniencia", "Acordos de Leniência", razao, cnpj),
      consultaListaSuja(DATA_DIR, cnpj),
      consultaOFAC(DATA_DIR, [razao, ...qsaNomes]),
      consultaOFACCons(DATA_DIR, [razao, ...qsaNomes]),
      consultaUN(DATA_DIR, [razao, ...qsaNomes]),
      consultaEU(DATA_DIR, [razao, ...qsaNomes]),
      consultaIDB(DATA_DIR, [razao, ...qsaNomes]),
      consultaUK(DATA_DIR, [razao, ...qsaNomes]),
      consultaTCU(cnpj),
      consultaTCESP(cnpj),
      consultaPEP(pepNomes, pepCpfs),
    ]);
    apis.push("Portal da Transparência/CGU (CEIS, CNEP, CEPIM, Leniência, PEP)", "Cadastro de Empregadores/MTE (trabalho escravo)", "OFAC SDN + Consolidated (EUA, Tesouro)", "UN Security Council Consolidated List", "EU Consolidated Financial Sanctions (CFSP)", "Inter-American Development Bank (BID)", "UK Sanctions List (FCDO)", "TCU — Licitantes Inidôneos (art. 46, Lei 8.443/92)", "TCE-SP — Relação de Apenados (impedimento de licitar/contratar SP)");
  }
  const anySancao = sancoes.some((s) => s.status === "CONSTA");
  const receitaInativa = receita && !/ATIVA/i.test(receita.situacao_cadastral || "");
  const erro = !receita || sancoes.some((s) => s.status === "ERRO" || s.status === "PENDENTE");
  const verdict = anySancao || receitaInativa ? "ALERTA" : (erro && !razao ? "PENDENTE" : "NADA_CONSTA");
  const now = new Date();
  const rec: any = {
    cnpj, razaoSocial: razao || "—", nomeFantasia: receita?.nome_fantasia || "",
    checkedAt: now.toISOString(), validUntil: new Date(now.getTime() + VALIDADE_DIAS * 86400000).toISOString(),
    checkedBy: opts.checkedBy || "—", ip: opts.ip || "—",
    receita, sancoes, verdict,
    fontesVersao: SOURCES_VERSION, fontesCount: DILIGENCE_SOURCES.length, // #104
    diligenciaId: crypto.randomUUID(), tempoTotalMs: Date.now() - t0run, // #103
    metadata: { apis, userAgent: opts.userAgent || "", geradoEm: now.toISOString(), commit: APP_COMMIT || undefined },
  };
  // #103: carimbo de integridade (SHA-256 do conteúdo substantivo) — evidência anti-adulteração reproduzível.
  rec.integridadeHash = crypto.createHash("sha256").update(JSON.stringify({ cnpj: rec.cnpj, verdict: rec.verdict, sancoes: rec.sancoes, receita: rec.receita, fontesVersao: rec.fontesVersao })).digest("hex");
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2));
  return { ...rec, fromCache: false };
}

export function collectSuppliers(DATA_DIR: string): any[] {
  const map = new Map<string, any>();
  const add = (taxId: string, nome: string, origem: string) => {
    const d = onlyDigits(taxId);
    if (d.length !== 14) return;
    const cur = map.get(d) || { cnpj: d, nome: "", origens: new Set<string>(), ocorrencias: 0 };
    if (nome && (!cur.nome || nome.length > cur.nome.length)) cur.nome = nome;
    cur.origens.add(origem); cur.ocorrencias++; map.set(d, cur);
  };
  const audits = path.join(DATA_DIR, "audits");
  if (fs.existsSync(audits)) for (const id of fs.readdirSync(audits)) {
    try { const a = JSON.parse(fs.readFileSync(path.join(audits, id, "result.json"), "utf-8")); for (const it of a.items || []) add(it.taxId, it.entity, "Auditoria"); } catch { /* */ }
  }
  const feac = path.join(DATA_DIR, "feac");
  if (fs.existsSync(feac)) for (const id of fs.readdirSync(feac)) {
    try { const r = JSON.parse(fs.readFileSync(path.join(feac, id, "record.json"), "utf-8")); for (const l of r.lancamentos || []) add(l.taxId, l.razaoSocial || l.fornecedor, "FEAC"); } catch { /* */ }
  }
  // fornecedores importados manualmente (lista/CSV) — arquivo opcional, fora de diligencia/
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(DATA_DIR, EXTRA_SUPPLIERS_FILE), "utf-8"));
    if (Array.isArray(extra)) for (const e of extra) add(e.cnpj, e.nome || "", "Importado");
  } catch { /* arquivo opcional */ }
  return [...map.values()].map(s => ({ cnpj: s.cnpj, cnpjFormatado: formatCnpjMask(s.cnpj), nome: s.nome, origens: [...s.origens], ocorrencias: s.ocorrencias }))
    .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
}

// ── report (HTML for print/PDF + TXT), aligned to the Casa Hacker design system ──

const VLABEL: Record<string, string> = { ALERTA: "ALERTA — RESTRIÇÕES ENCONTRADAS", NADA_CONSTA: "NADA CONSTA", PENDENTE: "PENDENTE — VERIFICAÇÃO INCOMPLETA" };
const SLABEL: Record<string, string> = { CONSTA: "CONSTA", NADA_CONSTA: "Nada consta", ERRO: "Erro na consulta", PENDENTE: "Pendente" };

// Base legal de cada lista (nota jurídica). `match` = chave de correspondência usada na
// consulta — "CNPJ" é exata; "Nome" é conservadora (pode gerar homônimos, exige confirmação).
const LEGAL_NOTES: Record<string, { orgao: string; base: string; efeito: string; match: string }> = {
  "ceis": { orgao: "CGU — Portal da Transparência", base: "Lei 8.666/1993 (art. 87) e Lei 14.133/2021; Lei 12.846/2013", efeito: "Inidoneidade/suspensão — impedimento de licitar e contratar com a Administração Pública.", match: "CNPJ" },
  "cnep": { orgao: "CGU — Portal da Transparência", base: "Lei 12.846/2013 (Lei Anticorrupção), art. 22", efeito: "Empresa punida por ato lesivo à Administração Pública (sanção administrativa ou judicial).", match: "CNPJ" },
  "cepim": { orgao: "CGU — Portal da Transparência", base: "Lei 8.666/1993; Decreto de transferências voluntárias / IN aplicável", efeito: "Entidade impedida de receber recursos federais por convênio ou transferência voluntária.", match: "CNPJ" },
  "acordos-leniencia": { orgao: "CGU", base: "Lei 12.846/2013, art. 16", efeito: "Acordo de leniência firmado — colaboração na apuração de ato lesivo (fato relevante de risco).", match: "CNPJ" },
  "lista-suja": { orgao: "MTE — Inspeção do Trabalho", base: "Portaria Interministerial MTPS/MMFDH nº 4/2016; art. 149 do Código Penal", efeito: "Empregador autuado por submeter trabalhadores a condição análoga à de escravo.", match: "CNPJ" },
  "pep": { orgao: "CGU / COAF", base: "Lei 9.613/1998; Resolução COAF; regulação do Bacen", efeito: "Pessoa exposta politicamente — não é restrição; exige devida diligência reforçada.", match: "Nome" },
  "ofac-sdn": { orgao: "OFAC — Departamento do Tesouro dos EUA", base: "IEEPA (50 U.S.C. §1701); Executive Orders; 31 CFR", efeito: "Sanção econômica dos EUA (SDN) — bloqueio de ativos e vedação de transações.", match: "Nome" },
  "ofac-cons": { orgao: "OFAC — Departamento do Tesouro dos EUA", base: "Programas setoriais (NS-MBS, SSI, FSE etc.); 31 CFR", efeito: "Lista consolidada não-SDN — restrições setoriais/parciais dos EUA.", match: "Nome" },
  "un-sc": { orgao: "Conselho de Segurança da ONU", base: "Carta da ONU, Cap. VII; resoluções do CSNU; no Brasil, Lei 13.810/2019", efeito: "Sanção internacional vinculante — aplicação imediata em território nacional.", match: "Nome" },
  "eu-fsf": { orgao: "União Europeia — Conselho", base: "Art. 29 TUE e art. 215 TFUE; regulamentos do Conselho", efeito: "Sanção financeira da UE — congelamento de fundos e recursos econômicos.", match: "Nome" },
  "uk-sanctions": { orgao: "Reino Unido — FCDO/OFSI", base: "Sanctions and Anti-Money Laundering Act 2018 (SAMLA)", efeito: "Sanção do Reino Unido (designated person) — congelamento de ativos.", match: "Nome" },
  "idb": { orgao: "Grupo BID (IADB)", base: "Sanctions Procedures do BID; Acordo de Cross-Debarment entre bancos multilaterais (2010)", efeito: "Empresa/indivíduo sancionado por fraude ou corrupção em projetos do Grupo BID.", match: "Nome" },
  "tcu-inidoneos": { orgao: "Tribunal de Contas da União (TCU)", base: "Lei 8.443/1992, art. 46 (declaração de inidoneidade de licitante)", efeito: "Licitante declarado inidôneo — impedido de participar de licitação na Administração Pública Federal por até 5 anos.", match: "CNPJ" },
  "tce-sp-apenados": { orgao: "Tribunal de Contas do Estado de São Paulo (TCE-SP)", base: "Lei 8.666/93 art. 87; Lei 10.520/02 art. 7º; Lei 14.133/21 — impedimento de licitar/contratar; relação publicada mensalmente no DOE-SP", efeito: "Impedido de licitar e contratar com a Administração Pública estadual e municipal de São Paulo (enquanto vigente).", match: "CNPJ exato (vigente) / histórico" },
};

// #103 — proveniência técnica: idade legível do cache + sub-linha por fonte (reusada no HTML e no TXT;
// a tela replica o mesmo formato). Texto cru; quem renderiza em HTML aplica esc().
function humanAge(ms: number): string {
  const m = Math.max(0, ms); const h = m / 3600000;
  if (h < 1) return `${Math.round(m / 60000)} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}
export function provTech(s: any): string {
  const dDate = (x: string) => { try { return new Date(x).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return x; } };
  const out: string[] = [`${s.metodo || "GET"} ${s.apiUrl || s.url || "—"}`.trim()];
  if (s.http != null) out.push(`HTTP ${s.http}`);
  if (s.cache) out.push(`cache${s.stale ? " (vencido, fallback)" : ""} (idade ${s.cacheAge != null ? humanAge(s.cacheAge) : "?"}${s.sourceUpdatedAt ? ` · cópia de ${dDate(s.sourceUpdatedAt)}` : ""})`);
  else if (s.http != null || s.ms != null) out.push(`ao vivo${s.ms != null ? ` · ${s.ms} ms` : ""}`);
  if (s.erro) out.push(`erro: ${s.erro}`);
  return out.join(" · ");
}
// Cabeçalho de auditabilidade da memória do processo (ID + versão do conjunto + tempo + integridade).
function provCaption(rec: any): string {
  const bits: string[] = [];
  const n = rec.fontesCount || (rec.sancoes || []).length;
  if (n) bits.push(`${n} fontes${rec.fontesVersao ? ` (conjunto v${rec.fontesVersao})` : ""}`);
  if (rec.diligenciaId) bits.push(`ID da diligência: ${rec.diligenciaId}`);
  if (rec.tempoTotalMs != null) bits.push(`tempo total: ${(rec.tempoTotalMs / 1000).toFixed(1)} s`);
  if (rec.metadata?.commit) bits.push(`commit ${rec.metadata.commit}`);
  if (rec.integridadeHash) bits.push(`integridade SHA-256: ${rec.integridadeHash}`);
  return bits.length ? `<div class="provcap">${esc(bits.join(" · "))}</div>` : "";
}

// Seções reutilizáveis (report de diligência + report consolidado do cockpit). HTML auto-contido.
export function legalNotesHtml(rec: any): string {
  const uniq: string[] = [];
  for (const s of (rec.sancoes || [])) if (s.recurso && !uniq.includes(s.recurso)) uniq.push(s.recurso);
  return uniq.map((r) => {
    const n = LEGAL_NOTES[r]; if (!n) return "";
    const f = (rec.sancoes || []).find((s: any) => s.recurso === r);
    return `<div class="note"><b>${esc(f?.fonte || r)}</b> — ${esc(n.orgao)}<br><span class="nk">Base legal:</span> ${esc(n.base)}<br><span class="nk">Efeito:</span> ${esc(n.efeito)}<br><span class="nk">Correspondência:</span> por ${esc(n.match)}</div>`;
  }).join("");
}
export function provenanceTableHtml(rec: any): string {
  const rf = rec.receita || {};
  const dt = (s: string) => { try { return new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return s || "—"; } };
  const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u || "—"; } };
  // Cada fonte ocupa 2 linhas: a principal (6 colunas) + uma sub-linha técnica (colspan) com a
  // proveniência detalhada (método/URL/HTTP/latência/cache/idade/erro), conforme #103.
  const rowFor = (fonte: string, apiUrl: string, at: string, registros: string, resultado: string, corresp: string, tech: string) =>
    `<tr><td>${esc(fonte)}</td><td>${apiUrl ? `<a href="${esc(apiUrl)}">${esc(hostOf(apiUrl))}</a>` : "—"}</td><td>${at ? dt(at) : "—"}</td><td>${esc(registros)}</td><td>${esc(resultado)}</td><td>${esc(corresp)}</td></tr>`
    + (tech ? `<tr class="techrow"><td colspan="6" class="tech">↳ ${esc(tech)}</td></tr>` : "");
  const rows = [
    rowFor(rf.fonte || "Receita Federal", rf.apiUrl || "", rf.fetchedAt, "—", rf.situacao_cadastral || "consultado", "CNPJ", rf.apiUrl ? `GET ${rf.apiUrl} · ao vivo` : ""),
    ...(rf.cepFonte ? [rowFor(rf.cepFonte, rf.cepApiUrl || "", rf.cepFetchedAt, "—", "consultado", "CEP", rf.cepApiUrl ? `GET ${rf.cepApiUrl} · ao vivo` : "")] : []),
    ...(rec.sancoes || []).map((s: any) => rowFor(
      s.fonte, s.apiUrl || "", s.fetchedAt,
      s.registros != null ? `${Number(s.registros).toLocaleString("pt-BR")} reg.` : "—",
      `${SLABEL[s.status] || s.status}${s.status === "CONSTA" ? ` (${s.hits.length})` : ""}`,
      (LEGAL_NOTES[s.recurso]?.match) || s.param || "—",
      provTech(s))),
  ].join("");
  return `${provCaption(rec)}<table class="prov"><thead><tr><th>Fonte</th><th>Origem</th><th>Consulta</th><th>Registros</th><th>Resultado</th><th>Corresp.</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function buildReportHtml(rec: any): string {
  const rf = rec.receita || {};
  const dt = (s: string) => { try { return new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return s || "—"; } };
  const vClass = rec.verdict === "ALERTA" ? "v-bad" : rec.verdict === "NADA_CONSTA" ? "v-ok" : "v-pend";
  const row = (k: string, v: any) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v || "—")}</span></div>`;
  const ender = [rf.logradouro, rf.numero, rf.complemento, rf.bairro].filter(Boolean).join(", ");
  const sitOk = /ATIVA/i.test(rf.situacao_cadastral || "");

  const sancoesHtml = (rec.sancoes || []).map((s: any) => {
    const head = `<div class="row"><span class="k">${esc(s.fonte)}</span><span class="v ${s.status === "CONSTA" ? "bad" : s.status === "NADA_CONSTA" ? "ok" : ""}">${esc(SLABEL[s.status] || s.status)}${s.status === "CONSTA" ? ` (${s.hits.length})` : ""}</span></div>`;
    const hits = (s.hits || []).map((h: any) => `<div class="hit"><b>${esc(h.tipo)}</b> — ${esc(h.orgao)}<br><span class="k">vigência ${esc(h.dataInicio || "?")}–${esc(h.dataFim || "?")} · processo ${esc(h.processo || "—")}</span>${h.fundamentacao ? `<br>${esc(h.fundamentacao)}` : ""}</div>`).join("");
    return head + hits;
  }).join("");

  const qsa = (rf.qsa || []).map((s: any) => `${esc(s.nome)}${s.qual ? ` (${esc(s.qual)})` : ""}`).join("; ");
  const secundarios = (rf.cnaes_secundarios || []).map((c: string) => esc(c)).join("<br>");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Diligência ${esc(formatCnpjMask(rec.cnpj))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
/* Documento de diligência: monocromático preto sobre branco (fonte e elementos todos
   em preto). A hierarquia é dada por peso/caixa-alta, não por cor; o significado dos
   status (Consta / Nada consta / Alerta) é dado pelo texto, não pela cor. */
:root{--ink:#000;--soft:#000;--line:#000}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"IBM Plex Mono",ui-monospace,monospace;color:#000;background:#fff;font-size:12px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:820px;margin:0 auto;padding:48px 56px}
.eyebrow{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#000}
h1{font-size:22px;font-weight:700;margin:6px 0 2px;letter-spacing:-.01em;color:#000}
.sub{color:#000;font-size:12px}
.verdict{display:inline-block;margin-top:12px;padding:6px 14px;border:2px solid #000;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:11px;color:#000;background:#fff}
.v-ok,.v-bad,.v-pend{color:#000;border-color:#000;background:#fff}
section{margin-top:26px}
.sectitle{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#000;font-weight:700;border-bottom:1px solid #000;padding-bottom:6px;margin-bottom:10px}
.row{display:flex;gap:10px;padding:1px 0;align-items:baseline}.k{color:#000;min-width:175px;flex-shrink:0}.v{font-weight:600;word-break:break-word;color:#000}.v.ok,.v.bad{color:#000}
.hit{border:1px solid #000;background:#fff;border-radius:4px;padding:8px 10px;margin:6px 0}
a{color:#000;text-decoration:underline}
footer{margin-top:40px;border-top:1px solid #000;padding-top:12px;color:#000;font-size:10px;line-height:1.7}
.brand{font-weight:700;color:#000;text-transform:uppercase;letter-spacing:.04em}
.toolbar{position:fixed;top:12px;right:16px;background:#000;color:#fff;border:none;padding:8px 14px;border-radius:4px;font-family:inherit;font-size:11px;cursor:pointer}
@media print{.toolbar{display:none}.page{padding:0}}
@page{margin:16mm}
table.prov{width:100%;border-collapse:collapse;font-size:10.5px;margin-top:4px}
table.prov th,table.prov td{border:1px solid #000;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-word}
table.prov th{font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:9px}
.note{border:1px solid #000;padding:8px 10px;margin:6px 0}.nk{font-weight:700}
.provcap{font-size:9.5px;margin:6px 0 3px;word-break:break-all}
table.prov td.tech{font-size:9px;padding:2px 6px 4px;border-top:0;word-break:break-all;line-height:1.4}
</style></head><body>
<button class="toolbar" onclick="window.print()">Salvar em PDF / Imprimir</button>
<div class="page">
  <div class="eyebrow">Diligência de Fornecedor · ${esc((rec.cnpj || "").slice(0, 8))}-${esc(new Date(rec.checkedAt).getFullYear())}</div>
  <h1>${esc(rec.razaoSocial || "—")}</h1>
  <div class="sub">CNPJ ${esc(formatCnpjMask(rec.cnpj))}${rf.nome_fantasia ? ` · ${esc(rf.nome_fantasia)}` : ""}</div>
  <div class="verdict ${vClass}">${esc(VLABEL[rec.verdict] || rec.verdict)}</div>

  <section><div class="sectitle">Dados da consulta (auditável)</div>
    ${row("Data/hora da consulta", dt(rec.checkedAt))}
    ${row("Validade (" + VALIDADE_DIAS + " dias)", new Date(rec.validUntil).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }))}
    ${row("Solicitante", rec.checkedBy)}
    ${row("IP de origem", rec.ip)}
  </section>

  <section><div class="sectitle">Receita Federal — cadastro</div>
    <div class="row"><span class="k">Situação cadastral</span><span class="v ${sitOk ? "ok" : "bad"}">${esc(rf.situacao_cadastral || "—")}${rf.data_situacao ? ` (desde ${esc(rf.data_situacao)})` : ""}</span></div>
    ${rf.motivo_situacao ? row("Motivo", rf.motivo_situacao) : ""}
    ${row("Natureza jurídica", rf.natureza_juridica)}
    ${row("Porte", rf.porte)}
    ${row("Data de abertura", rf.abertura)}
    ${row("Capital social", rf.capital_social)}
    ${row("CNAE principal", rf.cnae_principal)}
    ${secundarios ? `<div class="row"><span class="k">CNAEs secundários</span><span class="v">${secundarios}</span></div>` : ""}
    ${row("Endereço", ender)}
    ${row("Município / UF", `${rf.municipio || "—"} / ${rf.uf || "—"}`)}
    ${row("CEP", rf.cep)}
    ${row("Telefone", rf.telefone)}
    ${row("E-mail", rf.email)}
    ${qsa ? `<div class="row"><span class="k">Quadro societário (QSA)</span><span class="v">${qsa}</span></div>` : ""}
  </section>

  <section><div class="sectitle">Listas de restrição — nacionais e internacionais</div>
    ${sancoesHtml || '<div class="sub">Sem consulta.</div>'}
  </section>

  <section><div class="sectitle">Notas jurídicas — base legal das listas consultadas</div>
    ${legalNotesHtml(rec) || '<div class="sub">—</div>'}
  </section>

  <section><div class="sectitle">Memória do processo — proveniência técnica (auditável)</div>
    ${provenanceTableHtml(rec)}
    <div class="sub" style="margin-top:8px">Fontes públicas oficiais, consultadas em tempo real ou a partir de cópia em cache (com prazo de validade). A correspondência por <b>Nome</b> é conservadora e pode apontar homônimos — confirme a identidade antes de qualquer decisão; a correspondência por <b>CNPJ</b> é exata.</div>
  </section>

  <footer>
    <div class="brand">ASSOCIAÇÃO CASA HACKER</div>
    CNPJ 36.038.079/0001-97 · São Paulo · SP · operacoes@casahacker.org · casahacker.org<br>
    Relatório gerado pela plataforma Auditoria (Casa Hacker)${rec.metadata?.commit ? ` · build ${esc(rec.metadata.commit)}` : ""} em ${esc(new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))} (BRT) · conjunto de fontes v${esc(rec.fontesVersao || "—")} · documento de diligência para fins de prestação de contas.<br>
    Todos os horários deste documento estão no fuso de Brasília (BRT, UTC−3).
  </footer>
</div>
<script>window.addEventListener("load",function(){setTimeout(function(){try{window.print()}catch(e){}},400)})</script>
</body></html>`;
}

export function buildReportTxt(rec: any): string {
  const rf = rec.receita || {};
  const dt = (s: string) => { try { return new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return s || "-"; } };
  const L: string[] = [];
  L.push("RELATÓRIO DE DILIGÊNCIA DE FORNECEDOR");
  L.push("=".repeat(60));
  L.push(`${rec.razaoSocial || "-"}`);
  L.push(`CNPJ: ${formatCnpjMask(rec.cnpj)}${rf.nome_fantasia ? "  ·  " + rf.nome_fantasia : ""}`);
  L.push(`RESULTADO: ${VLABEL[rec.verdict] || rec.verdict}`);
  L.push("");
  L.push("DADOS DA CONSULTA (auditável)");
  L.push(`  Data/hora......: ${dt(rec.checkedAt)}`);
  L.push(`  Validade.......: ${new Date(rec.validUntil).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} (${VALIDADE_DIAS} dias)`);
  L.push(`  Solicitante....: ${rec.checkedBy || "-"}`);
  L.push(`  IP de origem...: ${rec.ip || "-"}`);
  if (rec.diligenciaId) L.push(`  ID diligência..: ${rec.diligenciaId}`);
  if (rec.fontesCount) L.push(`  Conjunto fontes: ${rec.fontesCount} fontes (v${rec.fontesVersao || "-"})`);
  if (rec.tempoTotalMs != null) L.push(`  Tempo execução.: ${(rec.tempoTotalMs / 1000).toFixed(1)} s`);
  if (rec.metadata?.commit) L.push(`  Build/commit...: ${rec.metadata.commit}`);
  if (rec.integridadeHash) L.push(`  Integridade....: SHA-256 ${rec.integridadeHash}`);
  L.push("");
  L.push("MEMÓRIA DO PROCESSO — proveniência técnica por fonte");
  L.push(`  Receita: GET ${rf.apiUrl || "-"} | ${rf.fetchedAt ? dt(rf.fetchedAt) : "-"} | ao vivo`);
  if (rf.cepFonte) L.push(`  ${rf.cepFonte}: GET ${rf.cepApiUrl || "-"} | ${rf.cepFetchedAt ? dt(rf.cepFetchedAt) : "-"} | ao vivo`);
  for (const s of rec.sancoes || []) {
    L.push(`  ${s.fonte}: ${SLABEL[s.status] || s.status}${s.status === "CONSTA" ? " (" + s.hits.length + ")" : ""} | ${dt(s.fetchedAt)}${s.registros != null ? " | " + s.registros + " reg." : ""} | corresp. ${LEGAL_NOTES[s.recurso]?.match || s.param || "-"}`);
    L.push(`      ↳ ${provTech(s)}`);
  }
  L.push("");
  L.push("RECEITA FEDERAL — CADASTRO");
  L.push(`  Situação.......: ${rf.situacao_cadastral || "-"}${rf.data_situacao ? " (desde " + rf.data_situacao + ")" : ""}`);
  if (rf.motivo_situacao) L.push(`  Motivo.........: ${rf.motivo_situacao}`);
  L.push(`  Natureza.......: ${rf.natureza_juridica || "-"}`);
  L.push(`  Porte..........: ${rf.porte || "-"}`);
  L.push(`  Abertura.......: ${rf.abertura || "-"}`);
  L.push(`  Capital social.: ${rf.capital_social || "-"}`);
  L.push(`  CNAE principal.: ${rf.cnae_principal || "-"}`);
  for (const c of rf.cnaes_secundarios || []) L.push(`  CNAE secundário: ${c}`);
  L.push(`  Endereço.......: ${[rf.logradouro, rf.numero, rf.complemento, rf.bairro].filter(Boolean).join(", ") || "-"}`);
  L.push(`  Município/UF...: ${rf.municipio || "-"} / ${rf.uf || "-"}  CEP ${rf.cep || "-"}`);
  L.push(`  Telefone.......: ${rf.telefone || "-"}`);
  L.push(`  E-mail.........: ${rf.email || "-"}`);
  for (const s of rf.qsa || []) L.push(`  Sócio..........: ${s.nome}${s.qual ? " (" + s.qual + ")" : ""}`);
  L.push("");
  L.push("LISTAS DE RESTRIÇÃO — NACIONAIS E INTERNACIONAIS");
  for (const s of rec.sancoes || []) {
    L.push(`  [${SLABEL[s.status] || s.status}] ${s.fonte}`);
    for (const h of s.hits || []) {
      L.push(`     - ${h.tipo} — ${h.orgao} | vigência ${h.dataInicio || "?"}–${h.dataFim || "?"} | processo ${h.processo || "-"}`);
      if (h.fundamentacao) L.push(`       ${h.fundamentacao}`);
    }
  }
  const recursosTxt: string[] = [];
  for (const s of rec.sancoes || []) if (s.recurso && !recursosTxt.includes(s.recurso)) recursosTxt.push(s.recurso);
  if (recursosTxt.length) {
    L.push("");
    L.push("NOTAS JURÍDICAS — BASE LEGAL DAS LISTAS");
    for (const r of recursosTxt) {
      const n = LEGAL_NOTES[r]; if (!n) continue;
      const f = (rec.sancoes || []).find((s: any) => s.recurso === r);
      L.push(`  ${f?.fonte || r} — ${n.orgao}`);
      L.push(`     Base legal: ${n.base}`);
      L.push(`     Efeito: ${n.efeito} | Correspondência: por ${n.match}`);
    }
  }
  L.push("");
  L.push("ASSOCIAÇÃO CASA HACKER · CNPJ 36.038.079/0001-97 · São Paulo · SP · operacoes@casahacker.org");
  L.push(`Gerado pela plataforma Auditoria (Casa Hacker) em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (BRT).`);
  L.push("Todos os horários deste documento estão no fuso de Brasília (BRT, UTC-3).");
  return L.join("\n");
}

// ── route registration ────────────────────────────────────────────────────────

export function registerDiligenciaRoutes(app: Express, ctx: DiligenciaCtx) {
  const { DATA_DIR, requireAuth, sanitizeSegment } = ctx;
  const DIL_DIR = path.join(DATA_DIR, "diligencia");
  fs.mkdirSync(DIL_DIR, { recursive: true });
  const recPath = (cnpj: string) => path.join(DIL_DIR, `${cnpj}.json`);
  const readRec = (cnpj: string): any | null => { try { return JSON.parse(fs.readFileSync(recPath(cnpj), "utf-8")); } catch { return null; } };
  const isValid = (rec: any) => rec && rec.validUntil && new Date(rec.validUntil).getTime() > Date.now();
  const cnpjParam = (req: any, res: any): string | null => {
    const c = onlyDigits(sanitizeSegment(req.params.cnpj as string) || "");
    if (c.length !== 14) { res.status(400).json({ error: "CNPJ inválido" }); return null; }
    return c;
  };

  // ── execução da diligência (interativa e automática) ────────────────────────
  // #104: "ainda atual" = dentro dos 30 dias E gravado sob a versão corrente do conjunto de fontes.
  // Um registro válido-no-tempo mas de versão antiga é re-enfileirado pelo sweep (backfill automático);
  // a etiqueta "vencida" da UI continua sendo só temporal (isValid) — versão antiga não vira "vencida".
  const hasValidRec = (cnpj: string) => { const r = readRec(cnpj); return !!(r && isValid(r) && r.fontesVersao === SOURCES_VERSION); };

  // runDiligence vive em escopo de módulo (export) p/ reuso pelo cockpit — chamado abaixo com (DATA_DIR, cnpj, opts).

  // ── fila automática (novos + vencidos), processada em série no ritmo do limiter ─
  const queue: string[] = [];
  const queued = new Set<string>();
  let processing: string | null = null;
  let running = false;
  const counters = { done: 0, failed: 0, enqueuedTotal: 0, lastError: "", lastSweep: "" };
  const forceSet = new Set<string>(); // CNPJs a reconsultar IGNORANDO o cache (force=true)

  // force=true: enfileira mesmo com registro válido (reconsulta forçada — ex.: novas listas adicionadas)
  function enqueue(cnpj: string, force = false): boolean {
    const d = onlyDigits(cnpj);
    if (d.length !== 14 || queued.has(d) || processing === d) return false;
    if (!force && hasValidRec(d)) return false;
    if (force) forceSet.add(d);
    queue.push(d); queued.add(d); counters.enqueuedTotal++;
    return true;
  }

  async function worker(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const cnpj = queue.shift() as string;
        queued.delete(cnpj); processing = cnpj;
        const force = forceSet.delete(cnpj);
        try { await runDiligence(DATA_DIR, cnpj, { checkedBy: "Associação Casa Hacker", ip: process.env.SERVER_IP || "sistema", force }); counters.done++; }
        catch (e: any) { counters.failed++; counters.lastError = e?.message || String(e); console.warn("[Diligência] auto falhou", cnpj, e?.message || e); }
        finally { processing = null; }
      }
    } finally { running = false; }
  }

  /** Enfileira todo fornecedor sem diligência válida (novo ou vencido) e dispara o worker. */
  function sweep(): number {
    let added = 0;
    try { for (const s of collectSuppliers(DATA_DIR)) if (enqueue(s.cnpj)) added++; }
    catch (e: any) { console.warn("[Diligência] sweep falhou", e?.message || e); }
    counters.lastSweep = new Date().toISOString();
    if (queue.length) void worker();
    return added;
  }

  const AUTO_ON = process.env.DILIGENCIA_AUTO !== "0";
  const SWEEP_MS = Math.max(60_000, Number(process.env.DILIGENCIA_SWEEP_MS || 5 * 60_000));
  if (AUTO_ON) {
    setTimeout(() => sweep(), 8_000);       // primeira varredura logo após subir
    setInterval(() => sweep(), SWEEP_MS);   // novos + vencidos periodicamente
  }
  // (atualização cadastral em massa via DILIGENCIA_FORCE_REFRESH=1 vive agora no cockpit —
  //  kycRoutes — porque também re-semeia o perfil consolidado, não só o registro de diligência.)

  // dispara a diligência de todos os ainda não consultados (ou vencidos) — manual
  app.post("/api/diligencia/run-all", requireAuth, (_req, res) => {
    const queuedNow = sweep();
    res.json({ queued: queuedNow, pending: queue.length, processing, running });
  });

  // reconsulta FORÇADA de toda a base (ignora o cache de 30d) — p/ aplicar listas novas sem esperar vencer
  app.post("/api/diligencia/run-all-force", requireAuth, (_req, res) => {
    let added = 0;
    try { for (const s of collectSuppliers(DATA_DIR)) if (enqueue(s.cnpj, true)) added++; }
    catch (e: any) { console.warn("[Diligência] run-all-force falhou", e?.message || e); }
    counters.lastSweep = new Date().toISOString();
    if (queue.length) void worker();
    res.json({ queued: added, forced: forceSet.size, pending: queue.length, processing, running });
  });

  // progresso da fila automática/manual
  app.get("/api/diligencia/queue", requireAuth, (_req, res) => {
    res.json({
      running, processing, pending: queue.length,
      done: counters.done, failed: counters.failed, enqueuedTotal: counters.enqueuedTotal,
      lastError: counters.lastError, lastSweep: counters.lastSweep,
      ratePerMin: RATE_PER_MIN, auto: AUTO_ON,
      pendingCnpjs: [processing, ...queue].filter(Boolean).slice(0, 80),
    });
  });

  // importa uma lista de CNPJs (texto/CSV colado ou { cnpjs: [...] }): adiciona à base
  // de fornecedores e enfileira os novos para diligência. Usa o express.json() global.
  const EXTRA_PATH = path.join(DATA_DIR, EXTRA_SUPPLIERS_FILE);
  const readExtra = (): any[] => { try { const a = JSON.parse(fs.readFileSync(EXTRA_PATH, "utf-8")); return Array.isArray(a) ? a : []; } catch { return []; } };
  app.post("/api/diligencia/import", requireAuth, (req: any, res) => {
    const body = req.body || {};
    const raw: string = Array.isArray(body.cnpjs) ? body.cnpjs.map(String).join("\n") : String(body.text || "");
    const uniq: string[] = Array.from(new Set<string>((raw.match(/\d[\d.\-/]{11,}\d/g) || []).map((x) => onlyDigits(x)).filter((d) => d.length === 14)));
    if (!uniq.length) return res.status(400).json({ error: "Nenhum CNPJ válido (14 dígitos) encontrado." });
    const extra = readExtra();
    const have = new Set(extra.map((e: any) => onlyDigits(e.cnpj)));
    let adicionados = 0;
    for (const d of uniq) if (!have.has(d)) { extra.push({ cnpj: d, origem: "Importado", importedAt: new Date().toISOString() }); have.add(d); adicionados++; }
    if (adicionados) fs.writeFileSync(EXTRA_PATH, JSON.stringify(extra, null, 2));
    let naFila = 0;
    for (const d of uniq) if (enqueue(d)) naFila++;
    if (naFila) void worker();
    res.json({ recebidos: uniq.length, adicionados, naFila, jaValidos: uniq.length - naFila, totalImportados: extra.length });
  });

  app.get("/api/diligencia/suppliers", requireAuth, (_req, res) => {
    const suppliers = collectSuppliers(DATA_DIR);
    for (const s of suppliers) {
      const r = readRec(s.cnpj);
      // Importados entram sem nome (o import só grava o CNPJ); a razão social fica
      // disponível no registro de diligência (vinda da Receita) — usa-a como nome.
      if ((!s.nome || s.nome === "—") && r?.razaoSocial && r.razaoSocial !== "—") s.nome = r.razaoSocial;
      s.diligencia = r ? { checkedAt: r.checkedAt, validUntil: r.validUntil, verdict: r.verdict, valida: isValid(r) } : null;
    }
    res.json(suppliers);
  });

  app.get("/api/diligencia", requireAuth, (_req, res) => {
    const out: any[] = [];
    for (const f of fs.existsSync(DIL_DIR) ? fs.readdirSync(DIL_DIR) : []) {
      if (!f.endsWith(".json")) continue;
      try { const r = JSON.parse(fs.readFileSync(path.join(DIL_DIR, f), "utf-8")); out.push({ cnpj: r.cnpj, razaoSocial: r.razaoSocial, verdict: r.verdict, checkedAt: r.checkedAt, validUntil: r.validUntil, valida: isValid(r) }); } catch { /* */ }
    }
    out.sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)));
    res.json(out);
  });

  app.get("/api/diligencia/:cnpj", requireAuth, (req: any, res) => {
    const cnpj = cnpjParam(req, res); if (!cnpj) return;
    const r = readRec(cnpj); if (!r) return res.status(404).json({ error: "Diligência não encontrada" });
    res.json({ ...r, valida: isValid(r) });
  });

  app.post("/api/diligencia/:cnpj/check", requireAuth, async (req: any, res) => {
    const cnpj = cnpjParam(req, res); if (!cnpj) return;
    const force = String(req.query.force || "") === "1";
    try {
      const rec = await runDiligence(DATA_DIR, cnpj, { checkedBy: req.user?.email || "—", ip: reqIp(req), userAgent: String(req.headers["user-agent"] || ""), force });
      res.json({ ...rec, valida: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || "Falha na diligência" }); }
  });

  // relatório HTML (impressão → PDF), alinhado ao design system
  app.get("/api/diligencia/:cnpj/report.html", requireAuth, (req: any, res) => {
    const cnpj = cnpjParam(req, res); if (!cnpj) return;
    const rec = readRec(cnpj); if (!rec) return res.status(404).send("Execute a diligência primeiro.");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildReportHtml(rec));
  });

  // dados em TXT
  app.get("/api/diligencia/:cnpj/txt", requireAuth, (req: any, res) => {
    const cnpj = cnpjParam(req, res); if (!cnpj) return;
    const rec = readRec(cnpj); if (!rec) return res.status(404).json({ error: "Execute a diligência primeiro" });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="diligencia_${cnpj}.txt"`);
    res.send(buildReportTxt(rec));
  });

  console.log("[Diligência] routes registered (/api/diligencia)");
}
