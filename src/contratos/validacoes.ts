/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — validações determinísticas e formatação (#132).
 *
 * Tudo que precisa ser EXATO e nunca pode depender da IA: somas de parcelas, coerência
 * de datas/cronograma, dígitos verificadores, valor por extenso e formatação pt-BR.
 * Estas funções bloqueiam a geração do contrato até serem resolvidas (Seção 9, 16.4/16.5).
 *
 * Puro (sem React, sem Express) — compartilhado entre o backend (gate de geração) e o
 * frontend (preview do wizard).
 */
import extenso from "extenso";
import { isValidCpf, isValidCnpj } from "../kyc/kycTypes";
import { iso10, addDias, addMeses, calcularVigenciaFim, proporVencimentos, quintoDiaUtil, ehDiaUtil, type ParcelaLike } from "./datas";

export { isValidCpf, isValidCnpj };
// Helpers de data puros vivem em ./datas (sem `extenso`) e são re-exportados aqui para
// não quebrar os imports existentes (templates, rotas, testes) — #146.
export { iso10, addDias, addMeses, calcularVigenciaFim, proporVencimentos, quintoDiaUtil, ehDiaUtil };
export type { ParcelaLike };

export const onlyDigits = (s: any): string => String(s ?? "").replace(/\D/g, "");

// ── Jira key (formato; existência/projeto é o #133) ──────────────────────────────
export const JIRA_KEY_RE = /^JUR-\d+$/i;
export const validarJiraKey = (k: any): boolean => JIRA_KEY_RE.test(String(k ?? "").trim());

// ── Formatação (determinística, sem depender de locale do ambiente) ──────────────
/** Centavos → "R$ 18.000,00". */
export function fmtMoeda(centavos: number): string {
  const neg = Number(centavos) < 0;
  const c = Math.abs(Math.trunc(Number(centavos) || 0));
  const reais = Math.trunc(c / 100);
  const cc = String(c % 100).padStart(2, "0");
  const milhar = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${milhar},${cc}`;
}

/** ISO (yyyy-mm-dd ou completa) → "dd/mm/aaaa" (sem deslocar fuso). */
export function fmtData(iso?: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(String(iso));
  if (isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Centavos → valor por extenso pt-BR ("dezoito mil reais"). */
export function valorPorExtenso(centavos: number): string {
  const c = Math.abs(Math.trunc(Number(centavos) || 0));
  const reais = Math.trunc(c / 100);
  const cc = String(c % 100).padStart(2, "0");
  return extenso(`${reais},${cc}`, { mode: "currency" });
}

/** Inteiro → por extenso ("seis"). Usado p/ nº de parcelas. */
export function numeroPorExtenso(n: number): string {
  return extenso(String(Math.abs(Math.trunc(Number(n) || 0))), { mode: "number" });
}

// ── Datas ────────────────────────────────────────────────────────────────────────
// iso10/addDias/addMeses/calcularVigenciaFim/proporVencimentos vêm de ./datas (puros).
const hojeIso = (): string => new Date().toISOString().slice(0, 10);

// ── Parcelas ──────────────────────────────────────────────────────────────────────
export function somaParcelasCentavos(parcelas?: ParcelaLike[]): number {
  return (parcelas || []).reduce((s, p) => s + (Number(p?.valorCentavos) || 0), 0);
}

// ── Resultado agregado da validação determinística ───────────────────────────────
export interface ResultadoValidacao {
  ok: boolean;                       // false = bloqueia a geração
  bloqueios: string[];               // impedem gerar (Σ parcelas, datas inválidas, DV…)
  avisos: string[];                  // não bloqueiam (ex.: último vencimento > vigência)
  sugestoes?: Record<string, any>;   // ex.: { vigenciaFim: "2026-..." }
}

export interface ContratoValidavel {
  cnpj?: string;
  jira?: { issueKey?: string };
  valorTotalCentavos?: number;
  parcelas?: ParcelaLike[];
  vigenciaFim?: string | null;
}

/**
 * Validações determinísticas que travam a geração (Seção 9). Não usa IA.
 * Reúne: DV do CNPJ, vínculo Jira, Σ parcelas == total, cronograma crescente,
 * último vencimento × fim da vigência (aviso + sugestão) e vigência futura.
 */
export function validarContratoParaGeracao(c: ContratoValidavel): ResultadoValidacao {
  const bloqueios: string[] = [];
  const avisos: string[] = [];
  const sugestoes: Record<string, any> = {};

  if (!isValidCnpj(c.cnpj || "")) bloqueios.push(`CNPJ inválido (dígitos verificadores): ${c.cnpj || "—"}.`);

  if (!c.jira?.issueKey) bloqueios.push("Vincule uma issue do projeto JUR (passo 2).");
  else if (!validarJiraKey(c.jira.issueKey)) bloqueios.push(`Issue Jira fora do formato JUR-<número>: ${c.jira.issueKey}.`);

  const total = Number(c.valorTotalCentavos) || 0;
  const parcelas = Array.isArray(c.parcelas) ? c.parcelas : [];
  if (total <= 0) bloqueios.push("Informe o valor total do contrato.");
  if (!parcelas.length) bloqueios.push("Informe ao menos uma parcela.");
  if (total > 0 && parcelas.length) {
    const soma = somaParcelasCentavos(parcelas);
    if (soma !== total) {
      bloqueios.push(`A soma das parcelas (${fmtMoeda(soma)}) difere do valor total (${fmtMoeda(total)}).`);
    }
  }

  // cronograma: vencimentos estritamente crescentes
  const datas = parcelas.map((p) => p?.vencimento).filter(Boolean).map(iso10) as string[];
  if (datas.length === parcelas.length && datas.length > 1) {
    for (let i = 1; i < datas.length; i++) {
      if (!(datas[i] > datas[i - 1])) { bloqueios.push("Os vencimentos das parcelas devem ser estritamente crescentes."); break; }
    }
  }

  // último vencimento × fim da vigência (não bloqueia — sugere estender)
  if (datas.length && c.vigenciaFim) {
    const ultimo = datas[datas.length - 1];
    if (ultimo > iso10(c.vigenciaFim)) {
      avisos.push(`O último vencimento (${fmtData(ultimo)}) é posterior ao fim da vigência (${fmtData(c.vigenciaFim)}).`);
      sugestoes.vigenciaFim = addDias(ultimo, 30);
    }
  }

  // vigência futura
  if (!c.vigenciaFim) avisos.push("Defina o fim da vigência.");
  else if (iso10(c.vigenciaFim) <= hojeIso()) bloqueios.push(`O fim da vigência (${fmtData(c.vigenciaFim)}) deve ser uma data futura.`);

  return { ok: bloqueios.length === 0, bloqueios, avisos, ...(Object.keys(sugestoes).length ? { sugestoes } : {}) };
}
