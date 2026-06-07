/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — helpers de DATA puros (#146).
 *
 * Sem dependências externas (NÃO importa `extenso`), para ser reaproveitado tanto pelo
 * servidor/templates (via validacoes.ts, que re-exporta) quanto pelo bundle do frontend
 * (ContratosApp) — sem arrastar a lib `extenso` para o navegador (decisão original do
 * ContratosApp.tsx de manter a formatação local).
 */

export interface ParcelaLike { numero?: number; valorCentavos?: number; vencimento?: string | null; estimada?: boolean }

export const iso10 = (d: any): string => String(d ?? "").slice(0, 10);

/** Soma n dias a uma data yyyy-mm-dd (retorna yyyy-mm-dd, sem deslocar fuso). */
export function addDias(isoDate: string, n: number): string {
  const d = new Date(`${iso10(isoDate)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Soma n meses a uma data yyyy-mm-dd (retorna yyyy-mm-dd, sem deslocar fuso). */
export function addMeses(isoDate: string, n: number): string {
  const d = new Date(`${iso10(isoDate)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Fim de vigência a partir do início + prazo, em MESES ou DIAS. Como a vigência só começa
 * na assinatura (data futura desconhecida na redação), o resultado é uma ESTIMATIVA —
 * "confirmar na assinatura" (a marcação fica no contrato).
 */
export function calcularVigenciaFim(inicioIso?: string | null, duracaoMeses?: number | null, duracaoDias?: number | null): string | null {
  if (!inicioIso) return null;
  if (duracaoMeses && duracaoMeses > 0) return addMeses(iso10(inicioIso), Number(duracaoMeses));
  if (duracaoDias && duracaoDias > 0) return addDias(iso10(inicioIso), Number(duracaoDias));
  return null;
}

/** Dia útil = segunda a sexta (não considera feriados — é uma estimativa, o operador ajusta). */
export const ehDiaUtil = (d: Date): boolean => { const w = d.getUTCDay(); return w >= 1 && w <= 5; };

/** 5º dia útil (seg–sex) do mês `mes0` (0-based) de `ano`, em yyyy-mm-dd. */
export function quintoDiaUtil(ano: number, mes0: number): string {
  let uteis = 0;
  for (let dia = 1; dia <= 31; dia++) {
    const d = new Date(Date.UTC(ano, mes0, dia));
    if (d.getUTCMonth() !== mes0) break; // estourou o mês
    if (ehDiaUtil(d)) { uteis++; if (uteis === 5) return d.toISOString().slice(0, 10); }
  }
  return new Date(Date.UTC(ano, mes0 + 1, 0)).toISOString().slice(0, 10); // fallback (não ocorre: todo mês tem ≥5 dias úteis)
}

/**
 * Propõe vencimentos (estimados) para as parcelas sem data confirmada pela regra PADRÃO:
 * **5º dia útil do mês subsequente ao da prestação** (parcela i, 0-based → 5º dia útil do mês
 * de início + i + 1). Determinístico — para a minuta não sair com [XX/XX/XXXX]. Preserva as
 * parcelas confirmadas manualmente (estimada === false); as demais voltam `estimada: true`,
 * editáveis. As datas são estritamente crescentes (meses consecutivos).
 */
export function proporVencimentos<T extends ParcelaLike>(parcelas: T[], baseIso?: string | null): T[] {
  if (!baseIso) return parcelas;
  const base = new Date(`${iso10(baseIso)}T00:00:00Z`);
  return parcelas.map((p, i) => {
    if (p.estimada === false && p.vencimento) return p;
    const m = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i + 1, 1));
    return { ...p, vencimento: quintoDiaUtil(m.getUTCFullYear(), m.getUTCMonth()), estimada: true };
  });
}
