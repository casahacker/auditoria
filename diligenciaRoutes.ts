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

// ── external lookups ──────────────────────────────────────────────────────────

export async function fetchReceita(cnpj: string): Promise<any> {
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      return {
        fonte: "BrasilAPI (Receita Federal)", apiUrl: `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, fetchedAt: new Date().toISOString(),
        razao_social: d.razao_social, nome_fantasia: d.nome_fantasia,
        situacao_cadastral: d.descricao_situacao_cadastral, data_situacao: d.data_situacao_cadastral, motivo_situacao: d.descricao_motivo_situacao_cadastral,
        natureza_juridica: d.natureza_juridica, porte: d.porte, abertura: d.data_inicio_atividade,
        capital_social: d.capital_social != null ? Number(d.capital_social).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "",
        logradouro: d.logradouro, numero: d.numero, complemento: d.complemento, bairro: d.bairro, municipio: d.municipio, uf: d.uf, cep: d.cep,
        email: d.email, telefone: [d.ddd_telefone_1, d.ddd_telefone_2].filter(Boolean).join(" / "),
        cnae_principal: d.cnae_fiscal ? `${d.cnae_fiscal} - ${d.cnae_fiscal_descricao}` : "",
        cnaes_secundarios: Array.isArray(d.cnaes_secundarios) ? d.cnaes_secundarios.filter((c: any) => c.codigo).map((c: any) => `${c.codigo} - ${c.descricao}`) : [],
        qsa: Array.isArray(d.qsa) ? d.qsa.map((s: any) => ({ nome: s.nome_socio, qual: s.qualificacao_socio, entrada: s.data_entrada_sociedade, faixa: s.faixa_etaria })) : [],
      };
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      return {
        fonte: "ReceitaWS (Receita Federal)", apiUrl: `https://www.receitaws.com.br/v1/cnpj/${cnpj}`, fetchedAt: new Date().toISOString(),
        razao_social: d.nome, nome_fantasia: d.fantasia, situacao_cadastral: d.situacao, data_situacao: d.data_situacao, motivo_situacao: d.motivo_situacao,
        natureza_juridica: typeof d.natureza_juridica === "object" ? d.natureza_juridica?.descricao : d.natureza_juridica,
        porte: d.porte, abertura: d.abertura, capital_social: d.capital_social,
        logradouro: d.logradouro, numero: d.numero, complemento: d.complemento, bairro: d.bairro, municipio: d.municipio, uf: d.uf, cep: d.cep,
        email: d.email, telefone: d.telefone,
        cnae_principal: Array.isArray(d.atividade_principal) && d.atividade_principal[0] ? `${d.atividade_principal[0].code} - ${d.atividade_principal[0].text}` : "",
        cnaes_secundarios: Array.isArray(d.atividades_secundarias) ? d.atividades_secundarias.filter((c: any) => c.code && c.code !== "00.00-0-00").map((c: any) => `${c.code} - ${c.text}`) : [],
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

export async function consultaPT(recurso: string, label: string, razaoSocial: string, cnpjDigits: string): Promise<any> {
  const apiUrl = `${PT_BASE}${recurso}?nomeSancionado=${encodeURIComponent(razaoSocial)}&pagina=1`;
  const consultaPublica: Record<string, string> = {
    ceis: "https://portaldatransparencia.gov.br/sancoes/ceis", cnep: "https://portaldatransparencia.gov.br/sancoes/cnep",
    cepim: "https://portaldatransparencia.gov.br/sancoes/cepim", "acordos-leniencia": "https://portaldatransparencia.gov.br/acordos-leniencia",
  };
  const base = { fonte: label, recurso, url: consultaPublica[recurso], apiUrl, fetchedAt: new Date().toISOString() };
  if (!process.env.PORTAL_TRANSPARENCIA_KEY) return { ...base, status: "PENDENTE", hits: [], erro: "Chave da API não configurada" };
  try {
    const r = await fetch(apiUrl, { headers: PT_HEADERS(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ...base, status: "ERRO", http: r.status, hits: [] };
    const arr = await r.json();
    const hits = (Array.isArray(arr) ? arr : []).filter((x: any) => recordMatchesCnpj(x, cnpjDigits)).map((x: any) => ({
      tipo: x.tipoSancao?.descricaoResumida || x.tipoSancao?.descricaoPortal || (typeof x.tipoSancao === "string" ? x.tipoSancao : "") || "Sanção",
      orgao: x.orgaoSancionador?.nome || x.orgaoSancionador?.siglaUf || "",
      dataInicio: x.dataInicioSancao || "", dataFim: x.dataFimSancao || "",
      fundamentacao: Array.isArray(x.fundamentacao) ? x.fundamentacao.map((f: any) => f.descricao || f.descricaoResumida).filter(Boolean).join("; ") : "",
      processo: x.numeroProcesso || "", nome: x.pessoa?.razaoSocialReceita || x.pessoa?.nome || "",
    }));
    return { ...base, status: hits.length ? "CONSTA" : "NADA_CONSTA", hits };
  } catch (e: any) { return { ...base, status: "ERRO", erro: e.message, hits: [] }; }
}

// ── supplier base ─────────────────────────────────────────────────────────────

function collectSuppliers(DATA_DIR: string): any[] {
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
:root{--ink:#3C433C;--soft:#91938C;--bg:#F8FCF8;--line:#D7DCD7;--accent:#E8D048;--ok:#1A7A3A;--bad:#C0392B}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--ink);background:#fff;font-size:12px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:820px;margin:0 auto;padding:48px 56px}
.eyebrow{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--soft)}
h1{font-size:22px;font-weight:600;margin:6px 0 2px;letter-spacing:-.01em}
.sub{color:var(--soft);font-size:12px}
.verdict{display:inline-block;margin-top:12px;padding:6px 14px;border:1.5px solid;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:11px}
.v-ok{color:var(--ok);border-color:var(--ok);background:#1a7a3a12}.v-bad{color:var(--bad);border-color:var(--bad);background:#c0392b12}.v-pend{color:#8a6d00;border-color:#caa400;background:#caa40018}
section{margin-top:26px}
.sectitle{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft);border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:10px}
.row{display:flex;gap:10px;padding:1px 0;align-items:baseline}.k{color:var(--soft);min-width:175px;flex-shrink:0}.v{font-weight:500;word-break:break-word}.v.ok{color:var(--ok)}.v.bad{color:var(--bad)}
.hit{border:1px solid #c0392b40;background:#c0392b08;border-radius:4px;padding:8px 10px;margin:6px 0}
a{color:var(--ink)}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:12px;color:var(--soft);font-size:10px;line-height:1.7}
.brand{font-weight:600;color:var(--ink);text-transform:lowercase;letter-spacing:.02em}
.toolbar{position:fixed;top:12px;right:16px;background:var(--ink);color:#fff;border:none;padding:8px 14px;border-radius:4px;font-family:inherit;font-size:11px;cursor:pointer}
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
    <div class="brand">casa hacker</div>
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
  L.push("casa hacker · CNPJ 36.038.079/0001-97 · São Paulo · SP · operacoes@casahacker.org");
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

  app.get("/api/diligencia/suppliers", requireAuth, (_req, res) => {
    const suppliers = collectSuppliers(DATA_DIR);
    for (const s of suppliers) { const r = readRec(s.cnpj); s.diligencia = r ? { checkedAt: r.checkedAt, validUntil: r.validUntil, verdict: r.verdict, valida: isValid(r) } : null; }
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
    const cached = readRec(cnpj);
    if (cached && isValid(cached) && !force) return res.json({ ...cached, valida: true, fromCache: true });

    const receita = await fetchReceita(cnpj);
    const razao = receita?.razao_social || cached?.razaoSocial || "";
    const apis: string[] = [];
    if (receita) apis.push(receita.fonte);
    let sancoes: any[] = [];
    if (razao) {
      sancoes = await Promise.all([
        consultaPT("ceis", "CEIS — Inidôneas e Suspensas", razao, cnpj),
        consultaPT("cnep", "CNEP — Empresas Punidas (Lei Anticorrupção)", razao, cnpj),
        consultaPT("cepim", "CEPIM — Entidades sem fins lucrativos impedidas", razao, cnpj),
        consultaPT("acordos-leniencia", "Acordos de Leniência", razao, cnpj),
      ]);
      apis.push("Portal da Transparência/CGU (CEIS, CNEP, CEPIM, Leniência)");
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
      receita, sancoes, verdict,
      metadata: { apis, userAgent: String(req.headers["user-agent"] || ""), geradoEm: now.toISOString() },
    };
    fs.writeFileSync(recPath(cnpj), JSON.stringify(rec, null, 2));
    res.json({ ...rec, valida: true, fromCache: false });
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
