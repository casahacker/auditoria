/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — template versionado do Contrato Padrão PJ (#129, Seção 10).
 *
 * LÓGICA FIXA: o texto e a numeração das cláusulas são imutáveis; só os
 * {{PLACEHOLDERS}} variam (preenchidos com os dados do contrato). NENHUMA cláusula da
 * Proposta entra aqui. Conferido contra "Modelo_Contrato de Prestação de Serviços
 * Pessoa Jurídica.docx" (mammoth) — em divergência, o .docx prevalece.
 *
 * Devolve uma lista de BLOCOS (estrutura intermediária) consumida igualmente pelos
 * renderizadores HTML (preview) e PDF — garantindo o mesmo conteúdo (16.10).
 */
import type { Contrato } from "../contratosTypes";
import { fmtMoeda, fmtData, valorPorExtenso, numeroPorExtenso, somaParcelasCentavos } from "../validacoes";

export const VERSAO_TEMPLATE = "2026-05";

export type Bloco =
  | { tipo: "titulo"; texto: string }
  | { tipo: "paragrafo"; texto: string }
  | { tipo: "clausula"; numero: string; titulo: string }
  | { tipo: "item"; texto: string }
  | { tipo: "assinaturas"; esquerda: string[]; direita: string[] }
  | { tipo: "nota"; texto: string };

// dados fixos da CONTRATANTE
const CASA_HACKER = "ASSOCIAÇÃO CASA HACKER, associação privada, inscrita no CNPJ sob o n° 36.038.079/0001-97, com sede na Rua Doutor Renato Paes de Barros, 618, Cj 01 — Itaim Bibi, São Paulo — SP, 04530-000, neste ato representada na forma de seu Estatuto Social, doravante denominada simplesmente “CASA HACKER”; e";

const ph = (v: any, placeholder: string): string => {
  const s = String(v ?? "").trim();
  return s || `[${placeholder}]`;
};

function qualificacaoContratada(c: Contrato): string {
  const d = c.dadosContratada;
  const r = d?.representante;
  return [
    `${ph(d?.razaoSocial, "RAZÃO SOCIAL")}, ${ph(d?.naturezaJuridica, "NATUREZA JURÍDICA")},`,
    `inscrita no CNPJ sob o n° ${ph(d?.cnpj, "CNPJ DO CONTRATADO")},`,
    `com sede na ${ph([d?.endereco?.logradouro, d?.endereco?.numero, d?.endereco?.bairro, d?.endereco?.municipio && d?.endereco?.uf ? `${d?.endereco?.municipio}/${d?.endereco?.uf}` : "", d?.endereco?.cep].filter(Boolean).join(", "), "ENDEREÇO COMPLETO DO CONTRATADO")},`,
    `neste ato representada por seu representante legal ${ph(r?.nome, "NOME COMPLETO DO REPRESENTANTE LEGAL")}, ${ph(r?.estadoCivil, "ESTADO CIVIL")}, ${ph(r?.cargo, "PROFISSÃO")},`,
    `inscrito no CPF sob n° ${ph(r?.cpf, "CPF DO REPRESENTANTE LEGAL")},`,
    `domiciliado(a) na ${ph(r?.enderecoCompleto, "ENDEREÇO COMPLETO DO REPRESENTANTE LEGAL")},`,
    `endereço eletrônico ${ph(r?.email, "E-MAIL DO REPRESENTANTE LEGAL")},`,
    `telefone móvel ${ph(r?.telefone, "TELEFONE MÓVEL")},`,
    `doravante denominada simplesmente “CONTRATADA”;`,
  ].join(" ");
}

/** Monta os blocos do Contrato Padrão PJ a partir dos dados do contrato. */
export function montarBlocos(c: Contrato): Bloco[] {
  const objeto = c.objeto || c.extracao?.objeto?.valor || "";
  const valorTotal = c.valorTotalCentavos || 0;
  const parcelas = Array.isArray(c.parcelas) ? c.parcelas : [];
  const blocos: Bloco[] = [];

  blocos.push({ tipo: "titulo", texto: "CONTRATO DE PRESTAÇÃO DE SERVIÇOS" });
  blocos.push({ tipo: "paragrafo", texto: "Pelo Presente Instrumento Particular, e na melhor forma de Direito, as Partes a saber:" });
  blocos.push({ tipo: "paragrafo", texto: CASA_HACKER });
  blocos.push({ tipo: "paragrafo", texto: qualificacaoContratada(c) });
  blocos.push({ tipo: "paragrafo", texto: 'Resolvem as partes acima qualificadas, doravante denominadas em conjunto "Partes" e individualmente como "Parte", celebrar CONTRATO DE PRESTAÇÃO DE SERVIÇOS ("CONTRATO"), que será regido pelos seguintes termos:' });

  blocos.push({ tipo: "clausula", numero: "1ª", titulo: "OBJETO" });
  blocos.push({ tipo: "paragrafo", texto: `O presente Contrato tem por objeto a prestação de serviços pela CONTRATADA, de ${ph(objeto, "DESCRIÇÃO DO SERVIÇO")} que será realizada conforme o Termo de Referência que integra o presente instrumento.` });
  blocos.push({ tipo: "paragrafo", texto: "O cronograma previsto no Termo de Referência poderá ser alterado mediante prévio acordo entre as partes." });

  blocos.push({ tipo: "clausula", numero: "2ª", titulo: "VIGÊNCIA" });
  blocos.push({ tipo: "paragrafo", texto: `O presente instrumento vigorará a partir da assinatura por todas as partes até ${c.vigenciaFim ? fmtData(c.vigenciaFim) : "[DATA FINAL DA VIGÊNCIA DO CONTRATO]"}${c.vigenciaEstimada ? " (data estimada — confirmar na assinatura)" : ""}.` });

  blocos.push({ tipo: "clausula", numero: "3ª", titulo: "VALOR" });
  blocos.push({ tipo: "paragrafo", texto: `A CASA HACKER pagará à CONTRATADA o valor bruto de ${valorTotal > 0 ? `${fmtMoeda(valorTotal)} (${valorPorExtenso(valorTotal)})` : "[VALOR TOTAL] ([VALOR POR EXTENSO])"}, referente à totalidade da prestação de serviços.` });
  blocos.push({ tipo: "paragrafo", texto: "A CONTRATADA declara haver considerado no valor pactuado todos os custos, despesas e tributos incidentes sobre a execução dos serviços objeto do presente, não cabendo qualquer reivindicação devido a erro de avaliação para o efeito de solicitar revisão de valor." });

  blocos.push({ tipo: "clausula", numero: "4ª", titulo: "FORMA DE PAGAMENTO" });
  const n = parcelas.length;
  blocos.push({ tipo: "paragrafo", texto: `O pagamento do valor autorizado à CONTRATADA será realizado em ${n > 0 ? `${n} (${numeroPorExtenso(n)}) parcela(s)` : "[NÚMERO DE PARCELAS] ([NÚMERO POR EXTENSO])"} a saber:` });
  if (n) {
    for (const p of parcelas) {
      blocos.push({ tipo: "item", texto: `Parcela ${p.numero}, valor ${fmtMoeda(p.valorCentavos)}, com vencimento em ${p.vencimento ? fmtData(p.vencimento) : "[XX/XX/XXXX]"}${p.estimada ? " (estimado)" : ""}, condicionado à entrega do relatório de execução dos serviços e aprovação da CASA HACKER;` });
    }
    const soma = somaParcelasCentavos(parcelas);
    if (soma !== valorTotal && valorTotal > 0) {
      blocos.push({ tipo: "item", texto: `⚠ Atenção: a soma das parcelas (${fmtMoeda(soma)}) difere do valor total (${fmtMoeda(valorTotal)}). Corrija antes de gerar o pacote.` });
    }
  }
  blocos.push({ tipo: "paragrafo", texto: "O pagamento do valor autorizado à CONTRATADA está sujeito ao cumprimento cumulativo das seguintes condições:" });
  blocos.push({ tipo: "item", texto: "Execução integral e satisfatória dos serviços previstos no período, conforme especificações técnicas e padrões de qualidade definidos no Objeto deste Contrato;" });
  blocos.push({ tipo: "item", texto: "Entrega de relatório mensal detalhado, em PDF, contendo, no mínimo: descrição cronológica dos serviços realizados; métricas de desempenho e/ou resultados alcançados; assinatura do responsável técnico da CONTRATADA;" });
  blocos.push({ tipo: "item", texto: "Emissão de nota fiscal válida, com: número da ordem de compra emitida pela CASA HACKER; descrição precisa dos serviços prestados; observância das formalidades legais vigentes." });
  blocos.push({ tipo: "paragrafo", texto: "Os pagamentos serão realizados pela CASA HACKER mediante crédito em conta corrente de titularidade da CONTRATADA, cabendo à CONTRATADA reter, dos valores quitados, os tributos incidentes sobre a remuneração." });

  blocos.push({ tipo: "clausula", numero: "5ª", titulo: "TERMOS E CONDIÇÕES APLICÁVEIS À PRESTAÇÃO DE SERVIÇOS À CASA HACKER" });
  blocos.push({ tipo: "paragrafo", texto: `O presente Contrato é regido, em caráter complementar e indissociável, aos Termos e Condições Aplicáveis à Prestação de Serviços à Casa Hacker (versão ${c.versaoTC || VERSAO_TEMPLATE}, “Termos e Condições”), que a este se anexam, formando um todo único para todos os efeitos legais. As Partes, por meio de seus representantes legais devidamente constituídos, declaram, sob as penas da lei, ter plena ciência, inequívoca compreensão e expressa anuência a todas as cláusulas e condições estipuladas nos referidos Termos e Condições.` });

  blocos.push({ tipo: "clausula", numero: "6ª", titulo: "FORO" });
  blocos.push({ tipo: "paragrafo", texto: "Fica eleito o foro da cidade de São Paulo, Estado de São Paulo, com exclusão de qualquer outro, por mais privilegiado que seja ou venha a ser, para dirimir eventuais dúvidas ou controvérsias, oriundas deste contrato, que não possam ser solucionadas por via amigável." });
  blocos.push({ tipo: "paragrafo", texto: "As Partes aceitam e reconhecem a validade jurídica deste instrumento assinado eletronicamente, nos termos da Medida Provisória nº 2.200-2/2001, da Lei nº 14.063/2020 (Lei de Assinaturas Eletrônicas) e da Lei nº 13.874/2019 (Lei da Liberdade Econômica), bem como da legislação civil e processual civil aplicável. Os relatórios de auditoria, registros eletrônicos e metadados gerados pela plataforma utilizada (tais como endereços de IP, data, hora, e-mail dos signatários e outros dados de auditoria) constituirão evidências válidas e suficientes da autoria, integridade e tempestividade do documento. Este Termo, assim assinado, constitui Título Executivo Extrajudicial, sendo certo, líquido e plenamente exigível para todos os fins de direito. As Partes renunciam expressamente ao direito de contestar a validade ou a executoriedade deste instrumento com base, unicamente, em seu formato eletrônico ou no método de assinatura." });

  blocos.push({
    tipo: "assinaturas",
    esquerda: ["GERALDO DOS SANTOS BARROS", "DIRETOR-PRESIDENTE", "ASSOCIAÇÃO CASA HACKER"],
    direita: [ph(c.dadosContratada?.representante?.nome, "REPRESENTANTE LEGAL"), ph(c.dadosContratada?.representante?.cargo, "CARGO"), "CONTRATADA"],
  });
  blocos.push({ tipo: "nota", texto: "Esta página de assinaturas é parte integrante e indissociável do Contrato de Prestação de Serviços, com ela formando um só todo e produzindo efeitos somente com relação a este instrumento." });

  return blocos;
}
