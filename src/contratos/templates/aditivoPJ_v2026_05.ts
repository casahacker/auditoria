/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — template versionado do Termo Aditivo PJ (#137, Seção 11).
 *
 * Lógica fixa; só os {{PLACEHOLDERS}} variam. Devolve blocos (mesma estrutura do
 * contrato) — render HTML/PDF compartilhado. Numeração ordinal por contrato.
 */
import type { Contrato, Aditivo } from "../contratosTypes";
import { fmtMoeda, fmtData, valorPorExtenso, numeroPorExtenso } from "../validacoes";
import { CASA_HACKER, ph, qualificacaoContratada, type Bloco } from "./contratoPJ_v2026_05";

export const VERSAO_ADITIVO = "2026-05";

const ORDINAIS = ["", "PRIMEIRO", "SEGUNDO", "TERCEIRO", "QUARTO", "QUINTO", "SEXTO", "SÉTIMO", "OITAVO", "NONO", "DÉCIMO"];
const ordinal = (n: number): string => ORDINAIS[n] || `${n}º`;

const TIPO_LABEL: Record<Aditivo["tipo"], string> = {
  prorrogacao: "prorrogação de vigência",
  valor_parcelas: "alteração de valor e/ou forma de pagamento",
  escopo: "alteração de escopo do objeto",
  dados_cadastrais: "atualização de dados cadastrais da CONTRATADA",
};

/** Cláusula 2ª — redação consolidada das cláusulas alteradas, por tipo. */
function consolidacao(c: Contrato, ad: Aditivo): string[] {
  switch (ad.tipo) {
    case "prorrogacao":
      return [`A Cláusula 2ª (VIGÊNCIA) passa a vigorar com a seguinte redação: “O presente instrumento vigorará até ${ad.vigenciaNovaFim ? fmtData(ad.vigenciaNovaFim) : "[NOVA DATA FINAL]"}.”`];
    case "valor_parcelas": {
      const novo = ad.valorNovoCentavos || 0;
      const linhas = [`A Cláusula 3ª (VALOR) passa a vigorar com o valor bruto de ${novo > 0 ? `${fmtMoeda(novo)} (${valorPorExtenso(novo)})` : "[NOVO VALOR]"}.`];
      if (ad.parcelasNovas?.length) {
        linhas.push(`A Cláusula 4ª (FORMA DE PAGAMENTO) passa a contemplar ${ad.parcelasNovas.length} (${numeroPorExtenso(ad.parcelasNovas.length)}) parcela(s):`);
        for (const p of ad.parcelasNovas) linhas.push(`Parcela ${p.numero}, valor ${fmtMoeda(p.valorCentavos)}, com vencimento em ${p.vencimento ? fmtData(p.vencimento) : "[DATA]"};`);
      }
      return linhas;
    }
    case "escopo":
      return [`A Cláusula 1ª (OBJETO) passa a vigorar com a seguinte redação: “${ph(ad.escopoNovo, "NOVA DESCRIÇÃO DO SERVIÇO")}”, conforme o novo Termo de Referência que integra este Aditivo.`];
    case "dados_cadastrais":
      return [`Ficam atualizados os dados cadastrais da CONTRATADA no preâmbulo, sem alteração das demais condições do Contrato.`];
  }
}

export function montarBlocosAditivo(c: Contrato, ad: Aditivo): Bloco[] {
  const blocos: Bloco[] = [];
  blocos.push({ tipo: "titulo", texto: `${ordinal(ad.numeroOrdinal)} TERMO ADITIVO AO CONTRATO DE PRESTAÇÃO DE SERVIÇOS` });
  blocos.push({ tipo: "paragrafo", texto: "Pelo presente Instrumento Particular, as Partes a saber:" });
  blocos.push({ tipo: "paragrafo", texto: CASA_HACKER });
  blocos.push({ tipo: "paragrafo", texto: qualificacaoContratada(c) });

  blocos.push({ tipo: "paragrafo", texto: `CONSIDERANDO que as Partes celebraram o Contrato de Prestação de Serviços ${c.id}${c.createdAt ? `, em ${fmtData(c.createdAt)}` : ""}, cujo objeto é ${ph(c.objeto || c.extracao?.objeto?.valor, "OBJETO DO CONTRATO")};` });
  blocos.push({ tipo: "paragrafo", texto: "CONSIDERANDO que os Termos e Condições aplicáveis preveem a possibilidade de alteração do Contrato mediante acordo escrito entre as Partes;" });
  blocos.push({ tipo: "paragrafo", texto: "resolvem celebrar o presente Termo Aditivo, que se regerá pelas cláusulas seguintes:" });

  blocos.push({ tipo: "clausula", numero: "1ª", titulo: "OBJETO DO ADITIVO" });
  blocos.push({ tipo: "paragrafo", texto: `O presente Termo Aditivo tem por objeto a ${TIPO_LABEL[ad.tipo]}${ad.descricao ? `: ${ad.descricao}` : ""}.` });

  blocos.push({ tipo: "clausula", numero: "2ª", titulo: "DAS ALTERAÇÕES" });
  for (const l of consolidacao(c, ad)) blocos.push(l.startsWith("Parcela") ? { tipo: "item", texto: l } : { tipo: "paragrafo", texto: l });

  blocos.push({ tipo: "clausula", numero: "3ª", titulo: "RATIFICAÇÃO" });
  blocos.push({ tipo: "paragrafo", texto: "Ficam ratificadas todas as demais cláusulas e condições do Contrato original e dos Termos e Condições a ele aplicáveis, não expressamente alteradas por este Termo Aditivo, que com ele formam um todo único e indissociável." });

  blocos.push({
    tipo: "assinaturas",
    esquerda: ["GERALDO DOS SANTOS BARROS", "DIRETOR-PRESIDENTE", "ASSOCIAÇÃO CASA HACKER"],
    direita: [ph(c.dadosContratada?.representante?.nome, "REPRESENTANTE LEGAL"), ph(c.dadosContratada?.representante?.cargo, "CARGO"), "CONTRATADA"],
  });
  blocos.push({ tipo: "nota", texto: "Esta página de assinaturas é parte integrante e indissociável do presente Termo Aditivo." });

  return blocos;
}
