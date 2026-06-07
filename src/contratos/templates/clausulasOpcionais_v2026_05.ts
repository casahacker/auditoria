/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — biblioteca de CLÁUSULAS OPCIONAIS versionadas (#157).
 *
 * Guard-rail (épico #126): o texto é FIXO e versionado — a IA NUNCA o redige. O operador
 * apenas LIGA/DESLIGA cada cláusula no wizard; quando ligada, ela entra na minuta com
 * numeração dinâmica (montarBlocos), antes da cláusula de FORO. Como toda geração passa
 * por aprovação humana (HITL), estas cláusulas são boilerplate padrão — devem ser
 * CONFERIDAS com o jurídico a cada nova versão (como o contrato padrão foi conferido
 * contra o .docx oficial).
 */
export const VERSAO_CLAUSULAS_OPCIONAIS = "2026-05";

export interface ClausulaOpcional {
  id: string;          // chave estável (persistida em Contrato.clausulasOpcionais)
  titulo: string;      // título da cláusula (caixa-alta, padrão do contrato)
  rotulo: string;      // rótulo curto para o seletor do wizard
  paragrafos: string[];
}

export const CLAUSULAS_OPCIONAIS: ClausulaOpcional[] = [
  {
    id: "confidencialidade",
    titulo: "CONFIDENCIALIDADE",
    rotulo: "Confidencialidade",
    paragrafos: [
      "As Partes obrigam-se a manter o mais absoluto sigilo sobre todas as informações confidenciais a que tiverem acesso em razão deste Contrato, não podendo divulgá-las a terceiros sem autorização prévia e por escrito da outra Parte, salvo por exigência legal ou determinação de autoridade competente.",
      "A obrigação de confidencialidade subsiste pelo prazo de 5 (cinco) anos contados do término deste Contrato, por qualquer motivo.",
    ],
  },
  {
    id: "lgpd",
    titulo: "PROTEÇÃO DE DADOS PESSOAIS",
    rotulo: "Proteção de dados (LGPD)",
    paragrafos: [
      "No tratamento de dados pessoais a que tenha acesso em decorrência deste Contrato, a CONTRATADA observará a Lei nº 13.709/2018 (LGPD), tratando-os exclusivamente para as finalidades deste instrumento e pelo tempo necessário à sua execução.",
      "A CONTRATADA adotará medidas técnicas e administrativas de segurança adequadas, eliminará ou devolverá os dados ao término do Contrato — salvo obrigação legal de guarda — e comunicará à CASA HACKER, sem demora injustificada, qualquer incidente de segurança envolvendo tais dados.",
    ],
  },
  {
    id: "propriedade_intelectual",
    titulo: "PROPRIEDADE INTELECTUAL",
    rotulo: "Propriedade intelectual",
    paragrafos: [
      "Todos os direitos de propriedade intelectual sobre os trabalhos, materiais e entregáveis produzidos pela CONTRATADA na execução deste Contrato pertencerão à CASA HACKER, ficando desde já cedidos, de forma definitiva e sem ônus adicional, os respectivos direitos patrimoniais, ressalvados os direitos morais do autor quando aplicáveis.",
    ],
  },
  {
    id: "multa_atraso",
    titulo: "MULTA POR ATRASO",
    rotulo: "Multa por atraso",
    paragrafos: [
      "O atraso injustificado na execução dos serviços ou na entrega dos produtos sujeitará a CONTRATADA à multa de 0,5% (cinco décimos por cento) por dia de atraso, limitada a 10% (dez por cento) do valor da parcela correspondente, sem prejuízo das demais sanções e da possibilidade de rescisão previstas nos Termos e Condições.",
    ],
  },
  {
    id: "reajuste",
    titulo: "REAJUSTE",
    rotulo: "Reajuste (IPCA)",
    paragrafos: [
      "Os valores previstos neste Contrato serão reajustados anualmente, a contar da data de assinatura, pela variação acumulada do IPCA/IBGE no período — ou, na sua ausência, por outro índice oficial que o substitua —, aplicável aos serviços prestados após o respectivo aniversário contratual.",
    ],
  },
];

const POR_ID = new Map(CLAUSULAS_OPCIONAIS.map((c) => [c.id, c]));

/** Resolve os ids selecionados para as cláusulas do catálogo, na ordem do catálogo. */
export function clausulasOpcionaisSelecionadas(ids?: string[]): ClausulaOpcional[] {
  if (!ids?.length) return [];
  const set = new Set(ids);
  return CLAUSULAS_OPCIONAIS.filter((c) => set.has(c.id));
}

export const ehClausulaOpcionalValida = (id: string): boolean => POR_ID.has(id);
