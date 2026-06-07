/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — pipeline de extração com DeepSeek-V3 (#131, Seção 8).
 *
 * A IA apenas EXTRAI os dados variáveis do TR/Proposta em JSON validado por zod; NUNCA
 * redige cláusula nem infere/estima/completa valores ausentes (valor=null). Aponta
 * lacunas e confere a COMPLETUDE ESTRUTURAL do documento ("o que não pode faltar":
 * objeto, valor, parcelas, vigência, identificação da contratada, nº da OC) + conflitos
 * com o padrão (só Proposta). O radar trabalhista (anti-pejotização) foi removido (#145).
 *
 * LGPD (3.6): SÓ o texto do documento de entrada vai à IA. Dados cadastrais do
 * fornecedor/representante e o conteúdo dos T&C NUNCA são enviados.
 *
 * Módulo SERVER-ONLY (chama o LLM). Recebe o texto já extraído (PDF/DOCX) e os deps
 * (aiClient, parseJsonSafe) injetados — testável com um aiClient mock.
 */
import { z } from "zod";
import type { ExtracaoIA } from "./contratosTypes";

const MAX_CHARS = 60_000; // teto de contexto enviado à IA

// ── schema zod do JSON da IA (Seção 8.2) ─────────────────────────────────────────
const campo = <T extends z.ZodTypeAny>(t: T) => z.object({ valor: t.nullable(), trechoFonte: z.string().nullable() });
const parcela = z.object({
  numero: z.number(), valorCentavos: z.number(), vencimento: z.string().nullable(), descricao: z.string().optional(),
});
const conflito = z.object({ clausula: z.string(), trecho: z.string(), motivo: z.string() });

export const ExtracaoSchema = z.object({
  objeto: campo(z.string()),
  resumoEscopo: campo(z.string()),
  vigencia: z.object({
    dataInicio: campo(z.string()),
    dataFim: campo(z.string()),
    duracaoMeses: campo(z.number()),
    prorrogavel: campo(z.boolean()),
    prorrogacaoMaxMeses: campo(z.number()),
  }),
  valorTotalCentavos: campo(z.number()),
  parcelas: z.array(parcela).default([]),
  condicoesPagamento: campo(z.string()),
  sla: campo(z.string()),
  localExecucao: campo(z.string()),
  equipamentosFornecidosPelaContratante: campo(z.string()),
  dadosContratadaNoDocumento: z.record(campo(z.string())).optional(),
  lacunas: z.array(z.string()).default([]),
  alertas: z.array(z.string()).default([]),
  conflitosComPadrao: z.array(conflito).default([]),
});

const PROMPT_SISTEMA = (tipo: "tr" | "proposta") => `Você é um EXTRATOR de dados para contratos de prestação de serviços (PJ) da Casa Hacker.
Sua função é EXTRAIR informações do documento abaixo e CONFERIR a completude estrutural dele. Você NUNCA redige cláusulas, NUNCA infere, estima ou completa dados ausentes.

Responda SOMENTE com um objeto JSON no schema (sem texto fora do JSON). Cada campo extraído tem a forma { "valor": <valor ou null>, "trechoFonte": "<citação LITERAL do documento>" }. Se a informação NÃO estiver no documento, use "valor": null e "trechoFonte": null. É PROIBIDO inventar.

Regras de normalização:
- Valores monetários em CENTAVOS inteiros (R$ 3.000,00 → 300000).
- Datas no formato ISO "yyyy-mm-dd". Durações em MESES (número inteiro).
- parcelas: lista [{ "numero", "valorCentavos", "vencimento" (ISO ou null), "descricao"? }]. Se o documento descreve uma regra (ex.: "mensal, até o 5º dia útil do mês subsequente"), liste a quantidade de parcelas que der para inferir do valor total e da duração, com "vencimento": null e a regra em "descricao".

Schema (chaves obrigatórias):
{
  "objeto": campo, "resumoEscopo": campo,
  "vigencia": { "dataInicio": campo, "dataFim": campo, "duracaoMeses": campo, "prorrogavel": campo, "prorrogacaoMaxMeses": campo },
  "valorTotalCentavos": campo, "parcelas": [...], "condicoesPagamento": campo, "sla": campo,
  "localExecucao": campo, "equipamentosFornecidosPelaContratante": campo,
  ${tipo === "proposta" ? `"dadosContratadaNoDocumento": { "razaoSocial": campo, "cnpj": campo, ... } (só o que a Proposta declarar, para CONFERÊNCIA — não vira cláusula),` : ""}
  "lacunas": ["<elemento obrigatório ausente>"],
  "alertas": ["<observação estrutural relevante>"],
  "conflitosComPadrao": [{ "clausula": "...", "trecho": "...", "motivo": "..." }]
}

CHECAGEM ESTRUTURAL — "o que não pode faltar" no ${tipo === "proposta" ? "documento" : "Termo de Referência"}:
Verifique se o documento traz, de forma clara, CADA elemento mínimo abaixo. Para cada item AUSENTE ou indefinido, adicione uma entrada objetiva em "lacunas":
- objeto/escopo do serviço; valor total; forma de pagamento e parcelas; vigência/prazo (data de início, fim OU duração); identificação da CONTRATADA (razão social, CNPJ e endereço); número da Ordem de Compra (OC); condições de pagamento (nota fiscal, relatório, aprovação).
Em "alertas", registre observações estruturais relevantes para a redação do contrato — por exemplo: "O documento é um Termo de Referência, não um contrato assinado"; "Não há identificação da contratada no documento"; "Não há data de início nem de fim — apenas duração"; "Cronograma de pagamento descrito por regra, sem datas".

${tipo === "proposta" ? `CONFLITOS COM O PADRÃO: em "conflitosComPadrao", aponte cláusulas da Proposta incompatíveis com um contrato de prestação de serviços padrão (ex.: exclusividade, multas atípicas, foro diferente, reajuste automático, propriedade intelectual divergente). Essas cláusulas NÃO entram no contrato.` : `CONFLITOS COM O PADRÃO: não se aplica a Termo de Referência (devolva "conflitosComPadrao": []).`}`;

export interface ExtrairDeps {
  aiClient: { chat: { completions: { create: (args: any) => Promise<any> } } };
  parseJsonSafe: (text: string) => any;
}

export interface ResultadoExtracao {
  ok: boolean;
  extracao?: ExtracaoIA;
  erro?: string;
}

/**
 * Extrai os dados do texto via DeepSeek-V3, valida com zod e tenta 1 reparo se o JSON
 * vier fora do schema. Falhando, devolve erro amigável (o operador preenche manual).
 */
export async function extrairDados(texto: string, tipoDocumento: "tr" | "proposta", deps: ExtrairDeps): Promise<ResultadoExtracao> {
  const sys = PROMPT_SISTEMA(tipoDocumento);
  const rotulo = tipoDocumento === "proposta" ? "Proposta Comercial" : "Termo de Referência";
  const userBase = `Documento (${rotulo}):\n\n${String(texto || "").slice(0, MAX_CHARS)}`;
  let lastErr = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0
      ? userBase
      : `${userBase}\n\nATENÇÃO: a resposta anterior não respeitou o schema JSON. Responda SOMENTE com o JSON válido. Problema: ${lastErr}`;
    let content = "";
    try {
      const resp = await deps.aiClient.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 4000,
      });
      content = resp?.choices?.[0]?.message?.content || "";
    } catch (e: any) {
      lastErr = `Falha na chamada à IA: ${e?.message || e}`;
      continue;
    }
    const parsed = deps.parseJsonSafe(content);
    if (!parsed) { lastErr = "A resposta não era um JSON interpretável."; continue; }
    const res = ExtracaoSchema.safeParse(parsed);
    if (res.success) {
      // zod garante o shape em runtime; o cast reconcilia a nuance de opcionalidade da inferência.
      const extracao = { ...res.data, modelo: "deepseek-chat", extraidoEm: new Date().toISOString() } as unknown as ExtracaoIA;
      return { ok: true, extracao };
    }
    lastErr = res.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; ");
  }
  return { ok: false, erro: `Não foi possível extrair os dados automaticamente (${lastErr}). Confira o documento ou preencha os campos manualmente.` };
}
