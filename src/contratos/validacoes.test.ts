/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes unitários das validações determinísticas (#132, critérios 16.4 e 16.5).
 * Sem framework (o repo não tem runner): rode com `npm run test:contratos`.
 */
import {
  valorPorExtenso, numeroPorExtenso, fmtMoeda, fmtData,
  somaParcelasCentavos, validarContratoParaGeracao,
  isValidCnpj, calcularVigenciaFim, addDias, addMeses, proporVencimentos, quintoDiaUtil, validarJiraKey,
  type ParcelaLike,
} from "./validacoes";

let pass = 0, fail = 0;
const eq = (got: any, want: any, msg: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  ✓", msg); }
  else { fail++; console.log("  ✗ FALHA:", msg, "\n     esperado:", JSON.stringify(want), "\n     obtido:  ", JSON.stringify(got)); }
};
const ok = (cond: boolean, msg: string) => eq(!!cond, true, msg);

// ── 16.5 — valor por extenso (os três valores do critério) ──
eq(valorPorExtenso(1_800_000), "dezoito mil reais", "extenso R$ 18.000,00");
eq(valorPorExtenso(123_456), "mil duzentos e trinta e quatro reais e cinquenta e seis centavos", "extenso R$ 1.234,56");
eq(valorPorExtenso(100_000_000), "um milhão de reais", "extenso R$ 1.000.000,00");
eq(numeroPorExtenso(6), "seis", "número 6 por extenso");

// ── formatação ──
eq(fmtMoeda(1_800_000), "R$ 18.000,00", "moeda 18.000");
eq(fmtMoeda(123_456), "R$ 1.234,56", "moeda 1.234,56");
eq(fmtMoeda(100_000_000), "R$ 1.000.000,00", "moeda 1.000.000");
eq(fmtMoeda(0), "R$ 0,00", "moeda 0");
eq(fmtData("2026-06-15"), "15/06/2026", "data yyyy-mm-dd → dd/mm/aaaa");
eq(fmtData("2026-06-15T03:00:00Z"), "15/06/2026", "data ISO completa → dd/mm/aaaa");

// ── datas / vigência ──
eq(calcularVigenciaFim("2026-01-15", 6), "2026-07-15", "vigência fim = início + 6 meses");
eq(calcularVigenciaFim("2026-01-15", 0, 90), "2026-04-15", "vigência fim = início + 90 dias (#146)");
eq(addDias("2026-06-15", 30), "2026-07-15", "addDias +30");
eq(addMeses("2026-01-31", 1), "2026-03-03", "addMeses +1 (overflow fevereiro)");

// ── #146: proposta de vencimentos (mensais a partir do início; preserva os manuais) ──
const vprops = proporVencimentos([
  { numero: 1, valorCentavos: 100 },
  { numero: 2, valorCentavos: 100, vencimento: "2026-05-05", estimada: false },
], "2026-01-10");
eq(quintoDiaUtil(2026, 1), "2026-02-06", "5º dia útil de fev/2026 (#163)");
eq(vprops[0].vencimento, "2026-02-06", "proporVencimentos: parcela 1 = 5º dia útil do mês subsequente (#163)");
eq(vprops[0].estimada, true, "proporVencimentos: parcela proposta fica estimada");
eq(vprops[1].vencimento, "2026-05-05", "proporVencimentos: parcela manual (estimada=false) preservada");
eq(validarJiraKey("JUR-42"), true, "JUR-42 formato ok");
eq(validarJiraKey("ABC-1"), false, "ABC-1 formato inválido");

// ── DV CNPJ (reuso do KYS) ──
eq(isValidCnpj("11222333000181"), true, "CNPJ válido");
eq(isValidCnpj("45448325000192"), false, "CNPJ inválido");

// ── gabarito #136: 6 parcelas de R$ 3.000 = R$ 18.000 ──
const seisParcelas: ParcelaLike[] = Array.from({ length: 6 }, (_, i) => ({
  numero: i + 1, valorCentavos: 300_000, vencimento: addMeses(new Date().toISOString().slice(0, 10), i + 1),
}));
eq(somaParcelasCentavos(seisParcelas), 1_800_000, "Σ 6×R$3.000 = R$18.000");

const futuro = addMeses(new Date().toISOString().slice(0, 10), 12);
const baseOk = { cnpj: "11222333000181", jira: { issueKey: "JUR-42" }, valorTotalCentavos: 1_800_000, parcelas: seisParcelas, vigenciaFim: futuro };
eq(validarContratoParaGeracao(baseOk).ok, true, "contrato consistente → ok");

// 16.4 — Σ parcelas divergente bloqueia com mensagem clara
const somaErrada = validarContratoParaGeracao({ ...baseOk, valorTotalCentavos: 1_700_000 });
ok(!somaErrada.ok && somaErrada.bloqueios.some((b) => /soma das parcelas/i.test(b)), "16.4 — Σ parcelas ≠ total bloqueia com mensagem clara");

// CNPJ inválido bloqueia
ok(!validarContratoParaGeracao({ ...baseOk, cnpj: "45448325000192" }).ok, "CNPJ inválido bloqueia");

// vencimentos não crescentes bloqueiam
const desordem: ParcelaLike[] = [
  { numero: 1, valorCentavos: 900_000, vencimento: "2026-08-10" },
  { numero: 2, valorCentavos: 900_000, vencimento: "2026-08-10" },
];
ok(validarContratoParaGeracao({ ...baseOk, parcelas: desordem, valorTotalCentavos: 1_800_000 }).bloqueios.some((b) => /crescentes/i.test(b)), "vencimentos não crescentes bloqueiam");

// vigência no passado bloqueia
ok(!validarContratoParaGeracao({ ...baseOk, vigenciaFim: "2020-01-01" }).ok, "vigência no passado bloqueia");

// último vencimento > vigência: aviso + sugestão (não bloqueia por isso)
const curta = validarContratoParaGeracao({ ...baseOk, vigenciaFim: addMeses(new Date().toISOString().slice(0, 10), 2) });
ok(curta.avisos.some((a) => /vigência/i.test(a)) && !!curta.sugestoes?.vigenciaFim, "último vencimento > vigência → aviso + sugestão");

console.log(`\n${fail === 0 ? "✅ OK" : "❌ FALHOU"} — ${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
