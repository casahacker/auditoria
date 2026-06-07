/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — tipos e modelo de dados compartilhados (client + server).
 *
 * Ferramenta de redação de contratos de prestação de serviços (PJ) e termos
 * aditivos da suíte Auditoria. Guard-rails jurídicos (épico #126):
 *  - T&C imutáveis (PDF oficial anexado byte a byte; SHA-256 conferido) — nunca pela IA.
 *  - Lógica do contrato é fixa; a IA só EXTRAI dados do TR/Proposta (nunca redige).
 *  - Determinismo: somas, datas, extenso e dígitos verificadores validados por código.
 *  - Human-in-the-loop obrigatório antes da assinatura (Documenso).
 *  - Gate de elegibilidade avaliado no servidor (nunca confiar no frontend).
 *  - Trilha auditável append-only de tudo.
 *
 * v1 = somente Pessoa Jurídica. Templates versionados para futura extensão.
 */

// ── Trilha auditável (append-only) ───────────────────────────────────────────────
export interface EventoTrilha {
  ts: string;                    // ISO 8601
  usuario: string;               // e-mail da sessão (ou "sistema")
  acao: string;                  // verbo curto: "criou_rascunho", "editou_campos", "rodou_extracao"…
  resumo?: string;               // descrição legível
  meta?: Record<string, any>;    // detalhes estruturados (ex.: campos alterados)
}

// ── Parcelas / pagamento ─────────────────────────────────────────────────────────
export interface Parcela {
  numero: number;
  valorCentavos: number;
  vencimento: string | null;     // ISO date (yyyy-mm-dd); null = a definir
  descricao?: string;
  estimada?: boolean;            // data proposta por regra (ex.: "5º dia útil"), não confirmada
}

// ── Dados da CONTRATADA (merge determinístico do Cockpit/KYS — nunca da IA) ───────
export interface EnderecoContratada {
  cep?: string; logradouro?: string; numero?: string; complemento?: string;
  bairro?: string; municipio?: string; uf?: string;
}
export interface RepresentanteLegal {
  nome: string;
  cpf: string;
  cargo?: string;
  email?: string;
  nacionalidade?: string;
  estadoCivil?: string;
  enderecoCompleto?: string;
  telefone?: string;
}
export interface DadosContratada {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string;
  endereco: EnderecoContratada;
  representante?: RepresentanteLegal;
  cnaePrincipal?: string;
  cnaesSecundarios?: string[];
  porte?: string;                // p/ regra MEI (#130)
  naturezaJuridica?: string;
  banco?: string; agencia?: string; conta?: string; chavePix?: string;
  fonte?: string;                // proveniência (Cockpit/KYS) p/ trilha
}

// ── Gate de elegibilidade (Seção 7 / #130) — snapshot congelado no contrato ───────
export type ResultadoCriterio = "ok" | "alerta" | "bloqueio";
export interface CriterioElegibilidade {
  id: string;                    // "receita_ativa" | "diligencia" | "kys_assinado" | "cnae_objeto" | "porte_mei"
  nome: string;
  fonte: string;                 // ex.: "Receita Federal", "Diligência (CGU)", "KYS/Documenso"
  data?: string;                 // ISO da consulta/fonte
  resultado: ResultadoCriterio;
  bloqueia: boolean;             // se ESTE critério, neste resultado, impede avançar
  detalhe?: string;
  // prosseguimento justificado (critério 2 = Alerta): registrado na trilha
  justificativa?: string;
  aprovador?: string;
}
export interface ElegibilidadeSnapshot {
  avaliadoEm: string;            // ISO
  elegivel: boolean;             // derivado: nenhum critério bloqueante ativo (ou todos justificados)
  criterios: CriterioElegibilidade[];
}
// prosseguimento justificado (critério Alerta da diligência) — fica na trilha (#130)
export interface JustificativaElegibilidade {
  criterioId: string;
  justificativa: string;
  aprovador: string;
  ts: string;
}

// ── Extração da IA (Seção 8.2 / #131) — só EXTRAI; cada campo cita o trecho-fonte ─
export interface CampoExtraido<T> {
  valor: T | null;               // null = ausente no documento (proibido inferir)
  trechoFonte: string | null;    // citação literal do TR/Proposta
}
export interface ConflitoComPadrao {
  clausula: string;
  trecho: string;
  motivo: string;
}
export interface VigenciaExtraida {
  dataInicio: CampoExtraido<string>;
  dataFim: CampoExtraido<string>;
  duracaoMeses: CampoExtraido<number>;
  prorrogavel: CampoExtraido<boolean>;
  prorrogacaoMaxMeses: CampoExtraido<number>;
}
export interface ParcelaExtraida {
  numero: number;
  valorCentavos: number;
  vencimento: string | null;
  descricao?: string;
}
export interface ExtracaoIA {
  objeto: CampoExtraido<string>;
  resumoEscopo: CampoExtraido<string>;
  vigencia: VigenciaExtraida;
  valorTotalCentavos: CampoExtraido<number>;
  parcelas: ParcelaExtraida[];
  condicoesPagamento: CampoExtraido<string>;
  sla: CampoExtraido<string>;
  localExecucao: CampoExtraido<string>;
  equipamentosFornecidosPelaContratante: CampoExtraido<string>;
  dadosContratadaNoDocumento?: Record<string, CampoExtraido<string>>; // só Proposta, p/ conferência
  lacunas: string[];
  alertas: string[];
  conflitosComPadrao: ConflitoComPadrao[];
  // metadados da execução
  modelo?: string;               // ex.: "deepseek-chat"
  extraidoEm?: string;           // ISO
}

// ── Anexos do pacote (arquivos no diretório do contrato) ──────────────────────────
export type TipoAnexo = "entrada" | "minuta" | "pacote" | "assinado" | "tc";
export interface AnexoRef {
  nome: string;                  // filename dentro de /app/data/contratos/<id>/
  tipo: TipoAnexo;
  mime?: string;
  tamanho?: number;
  hash?: string;                 // SHA-256 (T&C e pacote)
  adicionadoEm: string;          // ISO
}
export interface AnexosContrato {
  entrada?: AnexoRef;            // TR/Proposta original
  minuta?: AnexoRef;            // PDF da minuta gerada
  pacote?: AnexoRef;            // Contrato + TR anexo + T&C oficial
  assinado?: AnexoRef;          // PDF assinado (Documenso)
}

// ── Ciências registradas (alertas 8.3 / porte MEI etc.) ──────────────────────────
export interface Ciencia {
  item: string;                  // identificador do alerta a que o usuário deu ciência
  usuario: string;
  ts: string;
}

// ── Ciclo de vida ────────────────────────────────────────────────────────────────
export type ContratoStatus =
  | "rascunho"             // em construção no wizard
  | "em_revisao"          // enviado para revisão (passo 4)
  | "aprovado"            // aprovação humana registrada (HITL — Fase 3)
  | "enviado_assinatura"  // enviado ao Documenso
  | "assinado"            // assinado por todas as partes
  | "vigente"             // dentro da vigência
  | "encerrado"           // vigência terminada / rescindido
  | "cancelado";          // cancelado

// Transições permitidas via PATCH simples (as demais têm endpoints dedicados na Fase 3).
export const STATUS_EDITAVEIS_VIA_PATCH: ContratoStatus[] = ["rascunho", "em_revisao", "cancelado"];

export interface JiraVinculo {
  issueKey: string;              // JUR-nnn
  resumo?: string;
  status?: string;
  categoriaStatus?: string;      // "Done" gera alerta com ciência (#133)
  syncStatus?: string;           // estado da sincronização best-effort (Fase 3)
}

// ── Termo aditivo (Seção 5 / Fase 2 — #137/#138) ─────────────────────────────────
export type TipoAditivo = "prorrogacao" | "valor_parcelas" | "escopo" | "dados_cadastrais";
export interface Aditivo {
  id: string;                    // CH-AD-{ANO}-{SEQ}
  contratoId: string;            // CH-CT-{ANO}-{SEQ}
  numeroOrdinal: number;         // 1º, 2º aditivo do contrato
  tipo: TipoAditivo;
  status: ContratoStatus;        // reusa o ciclo de vida
  jira?: JiraVinculo;
  descricao?: string;
  // campos alterados conforme o tipo (preenchidos na Fase 2)
  vigenciaNovaFim?: string;
  valorNovoCentavos?: number;
  parcelasNovas?: Parcela[];
  escopoNovo?: string;
  dadosCadastraisNovos?: Partial<DadosContratada>;
  extracao?: ExtracaoIA;                          // só no aditivo de escopo (novo TR)
  variacaoPercentual?: number;                    // aditivo de valor: % sobre o valor original
  elegibilidadeSnapshot?: ElegibilidadeSnapshot; // gate reavaliado
  versaoTC?: string;
  hashTC?: string;
  anexos?: AnexosContrato;
  aprovacao?: { usuario: string; ts: string; hashPdf: string };
  documenso?: DocumensoVinculo;
  trilha: EventoTrilha[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface DocumensoVinculo {
  documentId?: number;
  status?: string;
  enviadoEm?: string;
  assinadoEm?: string;
  fallback?: boolean;   // Documenso indisponível → envio manual do pacote
  host?: string;
}

// ── Contrato (registro principal — Seção 5) ──────────────────────────────────────
export interface Contrato {
  id: string;                    // CH-CT-{ANO}-{SEQ}
  status: ContratoStatus;
  cnpj: string;                  // 14 dígitos (CONTRATADA)
  jira?: JiraVinculo;            // vínculo obrigatório a uma issue JUR (validado em #133)
  ordemCompra?: string;          // nº da OC (opcional)
  tipoDocumentoEntrada?: "tr" | "proposta";

  dadosContratada?: DadosContratada;       // merge determinístico (Cockpit/KYS)
  elegibilidadeSnapshot?: ElegibilidadeSnapshot;
  elegibilidadeJustificativas?: JustificativaElegibilidade[];
  extracao?: ExtracaoIA;

  // campos finais do contrato (após conferência/edição humana)
  objeto?: string;
  resumoEscopo?: string;
  vigenciaInicio?: string;       // ISO
  vigenciaFim?: string;          // ISO
  vigenciaEstimada?: boolean;    // "estimado — confirmar na assinatura"
  prorrogavel?: boolean;
  prorrogacaoMaxMeses?: number;
  valorTotalCentavos?: number;
  parcelas?: Parcela[];
  condicoesPagamento?: string;
  sla?: string;
  localExecucao?: string;
  equipamentosFornecidosPelaContratante?: string;

  ciencias?: Ciencia[];          // alertas 8.3 / porte MEI etc.

  // T&C imutáveis (snapshot — #128)
  versaoTC?: string;
  hashTC?: string;

  anexos?: AnexosContrato;
  aditivos?: string[];           // IDs de aditivos (CH-AD-…)

  // aprovação humana + assinatura (Fase 3 — #139)
  aprovacao?: { usuario: string; ts: string; hashPdf: string };
  documenso?: DocumensoVinculo;
  jiraSync?: { marco: string; ok: boolean; ts: string; erro?: string }[]; // sincronização best-effort (#140)

  trilha: EventoTrilha[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

// ── Resumo para listagem (Seção 14.1) ────────────────────────────────────────────
export interface ContratoResumo {
  id: string;
  status: ContratoStatus;
  cnpj: string;
  razaoSocial?: string;
  objeto?: string;
  valorTotalCentavos?: number;
  vigenciaInicio?: string;
  vigenciaFim?: string;
  jiraIssueKey?: string;
  qtdAditivos: number;
  createdAt: string;
  updatedAt: string;
}

export const resumoDoContrato = (c: Contrato): ContratoResumo => ({
  id: c.id,
  status: c.status,
  cnpj: c.cnpj,
  razaoSocial: c.dadosContratada?.razaoSocial,
  objeto: c.objeto || c.extracao?.objeto?.valor || undefined,
  valorTotalCentavos: c.valorTotalCentavos,
  vigenciaInicio: c.vigenciaInicio,
  vigenciaFim: c.vigenciaFim,
  jiraIssueKey: c.jira?.issueKey,
  qtdAditivos: c.aditivos?.length || 0,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});
