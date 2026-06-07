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

/**
 * Propõe vencimentos MENSAIS (estimados) para as parcelas sem data confirmada, a partir de
 * uma data-base (parcela i → base + i meses). Determinístico — para a minuta não sair com
 * placeholders [XX/XX/XXXX]. Preserva as parcelas com vencimento confirmado manualmente
 * (estimada === false); as demais voltam marcadas como `estimada: true` e são editáveis.
 */
export function proporVencimentos<T extends ParcelaLike>(parcelas: T[], baseIso?: string | null): T[] {
  if (!baseIso) return parcelas;
  const base = iso10(baseIso);
  return parcelas.map((p, i) =>
    (p.estimada === false && p.vencimento) ? p : { ...p, vencimento: addMeses(base, i + 1), estimada: true },
  );
}
