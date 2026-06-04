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

const PT_BASE = "https://api.portaldatransparencia.gov.br/api-de-dados/";
const VALIDADE_DIAS = 30;
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
  const base = { fonte: label, recurso, url: consultaPublica[recurso], apiUrl, fetchedAt: new Date().toISOString() };
  if (!process.env.PORTAL_TRANSPARENCIA_KEY) return { ...base, status: "PENDENTE", hits: [], erro: "Chave da API não configurada" };

  const hits: any[] = [];
  let paginasLidas = 0, registros = 0, truncado = false;
  try {
    for (let pagina = 1; pagina <= PT_MAX_PAGES; pagina++) {
      const r = await limitedFetch(urlForPage(pagina), { headers: PT_HEADERS(), signal: AbortSignal.timeout(15000) });
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
    if (hits.length) return { ...base, status: "CONSTA", hits, paginasLidas, registros, parcial: true, erro: e.message };
    return { ...base, status: "ERRO", erro: e.message, hits: [] };
  }
}

// ── listas extras: Lista Suja (trabalho escravo), OFAC SDN, PEP ──────────────────
const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Baixa e cacheia um arquivo de fonte (SDN, Lista Suja) em DATA_DIR/sources, com TTL; usa cache vencido em caso de falha. */
async function cachedSourceFile(DATA_DIR: string, name: string, url: string, ttlMs: number, decode: "utf8" | "latin1"): Promise<string | null> {
  const dir = path.join(DATA_DIR, "sources"); fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  const enc = decode === "latin1" ? "latin1" : "utf-8";
  try { if (Date.now() - fs.statSync(fp).mtimeMs < ttlMs) return fs.readFileSync(fp, enc as BufferEncoding); } catch { /* sem cache */ }
  try {
    const r = await limitedFetch(url, { headers: { "User-Agent": "casahacker-auditoria/1.0", Accept: "*/*" }, signal: AbortSignal.timeout(60000) }, 1);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(fp, buf);
    return buf.toString(enc as BufferEncoding);
  } catch { try { return fs.readFileSync(fp, enc as BufferEncoding); } catch { return null; } }
}

const LISTA_SUJA_URL = process.env.LISTA_SUJA_URL || "https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/areas-de-atuacao/cadastro_de_empregadores.csv";
/** Cadastro de Empregadores (trabalho análogo ao de escravo) — match por CNPJ/CPF EXATO (definitivo → CONSTA). */
async function consultaListaSuja(DATA_DIR: string, cnpj: string, cpfsExtras: string[] = []): Promise<any> {
  const base = { fonte: "Cadastro de Empregadores — trabalho análogo ao de escravo (MTE)", recurso: "lista-suja", url: "https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho", apiUrl: LISTA_SUJA_URL, fetchedAt: new Date().toISOString() };
  const csv = await cachedSourceFile(DATA_DIR, "lista-suja.csv", LISTA_SUJA_URL, 7 * 86400000, "latin1");
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
  const base = { fonte: "OFAC SDN — Sanções dos EUA (Tesouro)", recurso: "ofac-sdn", url: "https://sanctionssearch.ofac.treas.gov/", apiUrl: OFAC_SDN_URL, fetchedAt: new Date().toISOString() };
  const alvos = Array.from(new Set(nomes.map(norm))).filter((n) => n.length >= 8 && n.split(" ").length >= 2);
  if (!alvos.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const csv = await cachedSourceFile(DATA_DIR, "sdn.csv", OFAC_SDN_URL, 3 * 86400000, "utf8");
  if (!csv) return { ...base, status: "ERRO", hits: [], erro: "Falha ao baixar a SDN List" };
  const hits: any[] = []; const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line[0] === '"' && line.indexOf('","') === -1) { /* */ }
    const c = parseCsvLine(line); const sdn = norm(c[1]); if (sdn.length < 4) continue;
    for (const alvo of alvos) if (sdn.includes(alvo)) { hits.push({ tipo: `Possível correspondência OFAC SDN: "${String(c[1] || "").trim()}"`, orgao: `OFAC · ${String(c[2] || "").trim()} · ${String(c[3] || "").trim()} · CONFIRMAR identidade`, processo: String(c[0] || "").trim() }); break; }
  }
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits, ...(hits.length ? { nota: "Correspondência por nome — confirme a identidade antes de qualquer ação." } : {}) };
}

/** PEP (Pessoas Expostas Politicamente) — checa os sócios (QSA) por nome no Portal da Transparência → ATENÇÃO (informativo). */
async function consultaPEP(qsaNomes: string[]): Promise<any> {
  const base = { fonte: "PEP — Pessoas Expostas Politicamente (CGU)", recurso: "pep", url: "https://portaldatransparencia.gov.br/pessoa-fisica/pep", apiUrl: `${PT_BASE}peps`, fetchedAt: new Date().toISOString() };
  if (!process.env.PORTAL_TRANSPARENCIA_KEY) return { ...base, status: "PENDENTE", hits: [], erro: "Chave da API não configurada" };
  const nomes = Array.from(new Set(qsaNomes.map((n) => String(n || "").trim()).filter((n) => norm(n).split(" ").length >= 2))).slice(0, 12);
  if (!nomes.length) return { ...base, status: "NADA_CONSTA", hits: [] };
  const hits: any[] = []; const hoje = new Date();
  try {
    for (const nome of nomes) {
      const r = await limitedFetch(`${PT_BASE}peps?nome=${encodeURIComponent(nome)}&pagina=1`, { headers: PT_HEADERS(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const lista = await r.json();
      for (const p of Array.isArray(lista) ? lista : []) {
        if (norm(p.nome) !== norm(nome)) continue;
        const carenciaOk = !p.dt_fim_carencia || new Date(p.dt_fim_carencia) >= hoje;
        if (carenciaOk) hits.push({ tipo: `PEP: ${String(p.nome).trim()} — ${String(p.descricao_funcao || "").trim()}`, orgao: `${String(p.nome_orgao || "").trim()} · exercício ${p.dt_inicio_exercicio || "?"}–${p.dt_fim_exercicio || "?"}`, dataFim: p.dt_fim_carencia || "" });
      }
    }
  } catch (e: any) { return hits.length ? { ...base, status: "ATENCAO", hits, parcial: true } : { ...base, status: "ERRO", erro: e.message, hits: [] }; }
  return { ...base, status: hits.length ? "ATENCAO" : "NADA_CONSTA", hits };
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
  if (cached && isValid(cached) && !opts.force) return { ...cached, fromCache: true };
  const receita = await fetchReceita(cnpj);
  const razao = receita?.razao_social || cached?.razaoSocial || "";
  const apis: string[] = [];
  if (receita) apis.push(receita.fonte);
  let sancoes: any[] = [];
  if (razao) {
    const qsaNomes: string[] = (receita?.qsa || []).map((s: any) => s?.nome).filter(Boolean);
    sancoes = await Promise.all([
      consultaPT("ceis", "CEIS — Inidôneas e Suspensas", razao, cnpj),
      consultaPT("cnep", "CNEP — Empresas Punidas (Lei Anticorrupção)", razao, cnpj),
      consultaPT("cepim", "CEPIM — Entidades sem fins lucrativos impedidas", razao, cnpj),
      consultaPT("acordos-leniencia", "Acordos de Leniência", razao, cnpj),
      consultaListaSuja(DATA_DIR, cnpj),
      consultaOFAC(DATA_DIR, [razao, ...qsaNomes]),
      consultaPEP(qsaNomes),
    ]);
    apis.push("Portal da Transparência/CGU (CEIS, CNEP, CEPIM, Leniência, PEP)", "Cadastro de Empregadores/MTE (trabalho escravo)", "OFAC SDN (EUA, Tesouro)");
  }
  const anySancao = sancoes.some((s) => s.status === "CONSTA");
  const receitaInativa = receita && !/ATIVA/i.test(receita.situacao_cadastral || "");
  const erro = !receita || sancoes.some((s) => s.status === "ERRO" || s.status === "PENDENTE");
  const verdict = anySancao || receitaInativa ? "ALERTA" : (erro && !razao ? "PENDENTE" : "NADA_CONSTA");
  const now = new Date();
  const rec = {
    cnpj, razaoSocial: razao || "—", nomeFantasia: receita?.nome_fantasia || "",
    checkedAt: now.toISOString(), validUntil: new Date(now.getTime() + VALIDADE_DIAS * 86400000).toISOString(),
    checkedBy: opts.checkedBy || "—", ip: opts.ip || "—",
    receita, sancoes, verdict,
    metadata: { apis, userAgent: opts.userAgent || "", geradoEm: now.toISOString() },
  };
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

export function buildReportHtml(rec: any): string {
  const rf = rec.receita || {};
  const dt = (s: string) => { try { return new Date(s).toLocaleString("pt-BR"); } catch { return s || "—"; } };
  const vClass = rec.verdict === "ALERTA" ? "v-bad" : rec.verdict === "NADA_CONSTA" ? "v-ok" : "v-pend";
  const row = (k: string, v: any) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v || "—")}</span></div>`;
  const ender = [rf.logradouro, rf.numero, rf.complemento, rf.bairro].filter(Boolean).join(", ");
  const sitOk = /ATIVA/i.test(rf.situacao_cadastral || "");

  const consultas = [
    `<div class="row"><span class="k">${esc(rf.fonte || "Receita Federal")}</span><span class="v">${rf.fetchedAt ? dt(rf.fetchedAt) : "—"} · <a href="${esc(rf.apiUrl || "#")}">${esc(rf.apiUrl || "")}</a></span></div>`,
    ...(rf.cepFonte ? [`<div class="row"><span class="k">${esc(rf.cepFonte)}</span><span class="v">${rf.cepFetchedAt ? dt(rf.cepFetchedAt) : "—"} · <a href="${esc(rf.cepApiUrl || "#")}">${esc(rf.cepApiUrl || "")}</a></span></div>`] : []),
    ...(rec.sancoes || []).map((s: any) =>
      `<div class="row"><span class="k">${esc(s.fonte)}</span><span class="v ${s.status === "CONSTA" ? "bad" : s.status === "NADA_CONSTA" ? "ok" : ""}">${esc(SLABEL[s.status] || s.status)}${s.status === "CONSTA" ? ` (${s.hits.length})` : ""} · ${dt(s.fetchedAt)} · <a href="${esc(s.apiUrl || "#")}">consulta</a></span></div>`),
  ].join("");

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
</style></head><body>
<button class="toolbar" onclick="window.print()">Salvar em PDF / Imprimir</button>
<div class="page">
  <div class="eyebrow">Diligência de Fornecedor · ${esc((rec.cnpj || "").slice(0, 8))}-${esc(new Date(rec.checkedAt).getFullYear())}</div>
  <h1>${esc(rec.razaoSocial || "—")}</h1>
  <div class="sub">CNPJ ${esc(formatCnpjMask(rec.cnpj))}${rf.nome_fantasia ? ` · ${esc(rf.nome_fantasia)}` : ""}</div>
  <div class="verdict ${vClass}">${esc(VLABEL[rec.verdict] || rec.verdict)}</div>

  <section><div class="sectitle">Dados da consulta (auditável)</div>
    ${row("Data/hora da consulta", dt(rec.checkedAt))}
    ${row("Validade (30 dias)", new Date(rec.validUntil).toLocaleDateString("pt-BR"))}
    ${row("Solicitante", rec.checkedBy)}
    ${row("IP de origem", rec.ip)}
    <div style="margin-top:8px"></div>${consultas}
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

  <section><div class="sectitle">Listas de restrição — Portal da Transparência (CGU)</div>
    ${sancoesHtml || '<div class="sub">Sem consulta.</div>'}
  </section>

  <footer>
    <div class="brand">ASSOCIAÇÃO CASA HACKER</div>
    CNPJ 36.038.079/0001-97 · São Paulo · SP · operacoes@casahacker.org · casahacker.org<br>
    Relatório gerado por Stack Audit™ em ${esc(new Date().toLocaleString("pt-BR"))} · documento de diligência para fins de prestação de contas.
  </footer>
</div>
<script>window.addEventListener("load",function(){setTimeout(function(){try{window.print()}catch(e){}},400)})</script>
</body></html>`;
}

export function buildReportTxt(rec: any): string {
  const rf = rec.receita || {};
  const dt = (s: string) => { try { return new Date(s).toLocaleString("pt-BR"); } catch { return s || "-"; } };
  const L: string[] = [];
  L.push("RELATÓRIO DE DILIGÊNCIA DE FORNECEDOR");
  L.push("=".repeat(60));
  L.push(`${rec.razaoSocial || "-"}`);
  L.push(`CNPJ: ${formatCnpjMask(rec.cnpj)}${rf.nome_fantasia ? "  ·  " + rf.nome_fantasia : ""}`);
  L.push(`RESULTADO: ${VLABEL[rec.verdict] || rec.verdict}`);
  L.push("");
  L.push("DADOS DA CONSULTA (auditável)");
  L.push(`  Data/hora......: ${dt(rec.checkedAt)}`);
  L.push(`  Validade.......: ${new Date(rec.validUntil).toLocaleDateString("pt-BR")} (30 dias)`);
  L.push(`  Solicitante....: ${rec.checkedBy || "-"}`);
  L.push(`  IP de origem...: ${rec.ip || "-"}`);
  L.push(`  Fonte cadastral: ${rf.fonte || "-"} | ${rf.apiUrl || "-"} | ${rf.fetchedAt ? dt(rf.fetchedAt) : "-"}`);
  if (rf.cepFonte) L.push(`  Endereço (CEP).: ${rf.cepFonte} | ${rf.cepApiUrl || "-"} | ${rf.cepFetchedAt ? dt(rf.cepFetchedAt) : "-"}`);
  for (const s of rec.sancoes || []) L.push(`  ${s.fonte}: ${SLABEL[s.status] || s.status}${s.status === "CONSTA" ? " (" + s.hits.length + ")" : ""} | ${s.apiUrl || ""} | ${dt(s.fetchedAt)}`);
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
  L.push("LISTAS DE RESTRIÇÃO — PORTAL DA TRANSPARÊNCIA (CGU)");
  for (const s of rec.sancoes || []) {
    L.push(`  [${SLABEL[s.status] || s.status}] ${s.fonte}`);
    for (const h of s.hits || []) {
      L.push(`     - ${h.tipo} — ${h.orgao} | vigência ${h.dataInicio || "?"}–${h.dataFim || "?"} | processo ${h.processo || "-"}`);
      if (h.fundamentacao) L.push(`       ${h.fundamentacao}`);
    }
  }
  L.push("");
  L.push("ASSOCIAÇÃO CASA HACKER · CNPJ 36.038.079/0001-97 · São Paulo · SP · operacoes@casahacker.org");
  L.push(`Gerado por Stack Audit™ em ${new Date().toLocaleString("pt-BR")}.`);
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
  const hasValidRec = (cnpj: string) => { const r = readRec(cnpj); return !!(r && isValid(r)); };

  // runDiligence vive em escopo de módulo (export) p/ reuso pelo cockpit — chamado abaixo com (DATA_DIR, cnpj, opts).

  // ── fila automática (novos + vencidos), processada em série no ritmo do limiter ─
  const queue: string[] = [];
  const queued = new Set<string>();
  let processing: string | null = null;
  let running = false;
  const counters = { done: 0, failed: 0, enqueuedTotal: 0, lastError: "", lastSweep: "" };

  function enqueue(cnpj: string): boolean {
    const d = onlyDigits(cnpj);
    if (d.length !== 14 || queued.has(d) || processing === d || hasValidRec(d)) return false;
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
        try { await runDiligence(DATA_DIR, cnpj, { checkedBy: "automático (sistema)", ip: "sistema", force: false }); counters.done++; }
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
