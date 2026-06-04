/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * KYS / KYG (Tool D) — tipos e conteúdo compartilhados (client + server).
 *
 * KYS = Formulário de Conformidade para Fornecedores (pessoa jurídica / prestadores).
 * KYG = Declaração de Conformidade para OSCs sem fins lucrativos e lideranças PF que
 *       recebem doação com encargos.
 *
 * As perguntas e declarações são transcritas FIELMENTE dos modelos oficiais da Casa
 * Hacker (/home/geraldo/KYS.pdf, /home/geraldo/KYG.pdf). Não alterar o texto legal sem
 * revisão — ele aparece no wizard, no PDF assinado e na trilha de conformidade.
 */

export type KycType = 'kys' | 'kyg';
export type KycStatus = 'rascunho' | 'aguardando_assinatura' | 'assinado' | 'cancelado';
export type YesNo = 'sim' | 'nao' | '';
export type KycVerdict = 'NADA_CONSTA' | 'ALERTA' | 'PENDENTE';

// ── Endereço / banco ───────────────────────────────────────────────────────────
export interface KycAddress {
  cep: string; logradouro: string; numero: string; complemento: string;
  bairro: string; municipio: string; uf: string;
}
export const emptyAddress = (): KycAddress => ({ cep: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', uf: '' });
export const addressOneLine = (a?: KycAddress): string =>
  !a ? '' : [
    [a.logradouro, a.numero].filter(Boolean).join(', '),
    a.complemento, a.bairro, [a.municipio, a.uf].filter(Boolean).join('/'),
    a.cep ? `CEP ${a.cep}` : '',
  ].filter(Boolean).join(' · ');

export interface KycBank { banco: string; agencia: string; conta: string; chavePix: string; }
export const emptyBank = (): KycBank => ({ banco: '', agencia: '', conta: '', chavePix: '' });

/** Pessoa da Casa Hacker que solicitou o preenchimento (opcional) — vira cópia (CC). */
export interface KycRequester { nome: string; email: string; }

// ── Dados do KYS (pessoa jurídica) ──────────────────────────────────────────────
export interface KysAnswer { resposta: YesNo; obs: string; }
export interface KysData {
  razaoSocial: string; cnpj: string; nomeFantasia: string;
  endereco: KycAddress; telefone: string; email: string;
  banco: KycBank;
  repNome: string; repCpf: string; repEstadoCivil: string; repProfissao: string;
  repEndereco: KycAddress; repTelefone: string; repEmail: string;
  respostas: Record<string, KysAnswer>;
  observacoes: string;
}

// ── Dados do KYG (OSC pessoa jurídica OU liderança pessoa física) ────────────────
export interface KygData {
  tipoPessoa: 'pj' | 'pf';
  nome: string;            // razão social (OSC) ou nome completo (PF)
  documento: string;       // CNPJ (pj) ou CPF (pf)
  nomeFantasia: string;
  projeto: string;         // nome do projeto
  endereco: KycAddress; telefone: string; email: string;
  banco: KycBank;
  declaracoes: boolean[];  // aceite das 8 declarações (índice = KYG_DECLARACOES)
  observacoes: string;
}

// ── Trilha de verificação (conformidade verificada nas APIs) ────────────────────
export interface KycVerification {
  fonte: string;                                   // ex.: "BrasilAPI (Receita Federal)"
  tipo: string;                                    // ex.: "Situação cadastral", "CEIS"
  apiUrl?: string;
  resultado: string;                               // texto legível
  status: 'ok' | 'alerta' | 'pendente' | 'erro';
  checkedAt: string;                               // ISO
  detalhe?: any;
}

/** Elegibilidade da Casa Hacker: sem restrições + respostas adequadas + previdência em dia. */
export interface KycEligibility { elegivel: boolean; motivos: string[]; }

// ── Registro persistido (DATA_DIR/kyc/{id}.json) ───────────────────────────────
export interface KycRecord {
  id: string;
  type: KycType;
  status: KycStatus;
  kys?: KysData;
  kyg?: KygData;
  requester?: KycRequester;
  verificationTrail: KycVerification[];
  verdict?: KycVerdict;
  elegibilidade?: KycEligibility;
  documensoDocumentId?: number;
  documensoToken?: string;       // token do signatário (uso no embed; nunca exposto na lista)
  signedAt?: string;
  inviteToken?: string;
  fiscalYear: number;
  validUntil: string;            // 31/12 do fiscalYear (ISO)
  createdAt: string;
  ip?: string;
  userAgent?: string;
}

/** Resumo enviado ao painel (sem PII sensível / sem token). */
export interface KycSummary {
  id: string; type: KycType; status: KycStatus;
  nome: string; documento: string; documentoFmt: string;
  requester?: KycRequester; verdict?: KycVerdict; elegivel?: boolean;
  fiscalYear: number; validUntil: string; valida: boolean;
  createdAt: string; signedAt?: string;
}

export interface KycInvite {
  token: string; type: KycType; cnpj?: string;
  requester?: KycRequester; createdBy: string; createdAt: string;
  expiresAt?: string; usedByRecordId?: string;
}

// ── Conteúdo legal: KYS (perguntas Sim/Não por seção) ───────────────────────────
export interface KysQuestion {
  key: string;
  text: string;
  obsOn?: YesNo;     // quando exibir/exigir observação (default: 'sim')
}
export interface KysSection { id: string; title: string; intro?: string; questions: KysQuestion[]; }

export const KYS_SECTIONS: KysSection[] = [
  {
    id: 'pep', title: 'Pessoa Exposta Politicamente (PEP) e Conflito de Interesses',
    questions: [
      { key: 'pep', text: 'Algum proprietário, sócio, acionista majoritário, membro do conselho de administração, diretor e/ou representante da empresa enquadra-se na condição de Pessoa Exposta Politicamente, conforme definido no §1º, Artigo 1º, da Resolução nº 29, de 7 de dezembro de 2017, do COAF? Em caso afirmativo, informe quem é a pessoa, a posição ocupada e o órgão do governo em observações.' },
      { key: 'familiar_governo', text: 'Algum membro familiar de até 3º grau de parentesco ou afinidade, de seus proprietários, sócios, acionistas majoritários, diretores ou empregados faz ou fez parte (nos últimos 5 anos) de ente de governo nacional ou estrangeiro, incluindo ministério, agência ou departamento, órgão governamental, empresa pública ou de economia mista, seja como funcionário, procurador, consultor ou prestador de serviço? Em caso afirmativo, informe quem é a pessoa, a posição ocupada e o órgão do governo em observações.' },
      { key: 'parentesco_casahacker', text: 'Algum proprietário, acionista majoritário, sócio, diretor ou empregado possui parentesco até o quarto grau de consanguinidade ou segundo grau de afinidade que seja empregado, executivo ou conselheiro da Casa Hacker? Em caso afirmativo, informe quem é a pessoa, a posição ocupada e a área operacional/projeto em observações.' },
      { key: 'acao_judicial', text: 'A empresa, seus proprietários ou acionistas majoritários tem alguma ação judicial, seja como autor ou réu, contra a Casa Hacker ou subsidiária? Em caso afirmativo, descreva-a, inclusive fornecendo o número do processo em observações.' },
      { key: 'conflito_interesse', text: 'A empresa, seus proprietários ou acionistas majoritários possuem conflitos de interesse potencial aparente ou existente em relação à Casa Hacker? Em caso afirmativo, descreva o conflito de interesse em observações.' },
    ],
  },
  {
    id: 'politico', title: 'Relacionamento Político',
    questions: [
      { key: 'candidato_politico', text: 'Algum proprietário, acionista majoritário, sócio, membro do conselho de administração, diretor e/ou representante da empresa é ou foi candidato a um cargo político ou público, ou ainda nomeado/apontado para tal cargo em algum estado da Federação brasileira?' },
      { key: 'partido_politico', text: 'Algum proprietário, acionista majoritário, sócio, membro do conselho de administração, diretor e/ou representante da empresa é executivo, diretor ou funcionário de um partido político?' },
    ],
  },
  {
    id: 'corrupcao', title: 'Histórico de Crimes ou Ilicitudes de Corrupção',
    questions: [
      { key: 'condenacao_corrupcao', text: 'A empresa, algum dos sócios, conselheiros, dirigentes ou proprietários têm qualquer condenação, ainda que não transitada em julgado, por crimes ou ilicitudes de corrupção, lavagem de dinheiro, improbidade administrativa, relacionados à legislação de combate a lavagem de dinheiro, de defesa da concorrência ou de licitações? Em caso afirmativo, explique em observações.' },
      { key: 'investigacao_anticorrupcao', text: 'A empresa ou seus sócios está sendo, ou foi, nos últimos 5 (cinco) anos formalmente acusada ou investigada por parte de autoridade governamental competente por qualquer crime, nos termos da Lei nº 12.846/13 (Lei Anticorrupção) ou sob os crimes previstos no Código Penal (Capítulos II — crimes praticados por particular contra a administração pública e II-A — dos crimes praticados por particular contra a administração pública estrangeira) ou ainda nos termos da Lei 12.529/11? Em caso afirmativo, explique em observações.' },
      { key: 'bloqueio_confisco', text: 'A empresa ou seus sócios está sendo, ou foi, nos últimos 5 (cinco) anos, sujeita a qualquer mandado ou sentença de bloqueio, confisco ou perda de direito baseada em qualquer violação alegada de quaisquer leis de corrupção, lavagem de dinheiro ou de terrorismo, ou por violar quaisquer leis anti-lavagem de dinheiro ou anti-terrorismo? Em caso afirmativo, explique em observações.' },
    ],
  },
  {
    id: 'direitos', title: 'Direitos Humanos',
    questions: [
      { key: 'escravidao', text: 'Escravidão moderna e tráfico humano: a empresa, algum dos sócios, conselheiros, dirigentes ou proprietários têm qualquer condenação, ainda que não transitada em julgado, ou é investigado(a) por crimes de trabalho escravo ou análogo de escravo? Em caso afirmativo, explique em observações.' },
      { key: 'injuria_racial', text: 'Injúria racial: a empresa, algum dos sócios, conselheiros, dirigentes ou proprietários têm qualquer condenação, ainda que não transitada em julgado, ou é investigado(a) por crimes de injúria racial? Em caso afirmativo, explique em observações.' },
      { key: 'crimes_genero', text: 'Crimes de gênero: a empresa, algum dos sócios, conselheiros, dirigentes ou proprietários têm qualquer condenação, ainda que não transitada em julgado, ou é investigado(a) por crimes de gênero? Em caso afirmativo, explique em observações.' },
      { key: 'trabalho_infantil', text: 'Crimes de exploração do trabalho infantil: a empresa, algum dos sócios, conselheiros, dirigentes ou proprietários têm qualquer condenação, ainda que não transitada em julgado, ou é investigado(a) por crimes de exploração do trabalho infantil? Em caso afirmativo, explique em observações.' },
    ],
  },
  {
    id: 'sancoes', title: 'Sanções Governamentais e Histórico',
    questions: [
      { key: 'sancoes', text: 'A empresa, algum dos sócios, conselheiros, dirigentes ou proprietários estão sancionados em uma ou mais das seguintes blocklists e/ou cadastros: (1) CEIS — Cadastro de Empresas Inidôneas e Suspensas; (2) CNEP — Cadastro Nacional de Empresas Punidas; (3) CEPIM — Cadastro Nacional de Entidades Privadas sem Fins Lucrativos Impedidas; (4) outras listas restritivas do Portal da Transparência; (5) Cadastro de Empregadores (trabalho análogo ao de escravo); (6) Banco Nacional de Mandados de Prisão; (7) SDN — Specially Designated Nationals and Blocked Persons (OFAC)? Em caso afirmativo, explique em observações.' },
      { key: 'historico_contratual', text: 'A empresa, algum dos sócios, conselheiros, dirigentes ou proprietários forneceu bens e/ou serviços anteriormente à Casa Hacker? Em caso afirmativo, informe em observações.' },
      { key: 'impostos_previdencia', text: 'A empresa cumpriu com as obrigações relativas ao pagamento de impostos e contribuições para a Previdência Social de acordo com a lei da(s) jurisdição(ões) na qual está estabelecida e na qual está operando? Em caso NEGATIVO, explique em observações.', obsOn: 'nao' },
    ],
  },
];

export const KYS_QUESTIONS: KysQuestion[] = KYS_SECTIONS.flatMap((s) => s.questions);
export const kysObsTrigger = (q: KysQuestion): YesNo => q.obsOn ?? 'sim';

// Declarações finais do KYS (página 6–7 do modelo).
export const KYS_DECLARACOES: string[] = [
  'Declaro ter tomado conhecimento integral do Código de Conduta Ética da Casa Hacker disponível em casahacker.org/conduta, e a Empresa compromete-se a adotar e fazer cumprir seus padrões éticos, valores e diretrizes em todas as relações contratuais com a Casa Hacker (sob pena de rescisão imediata por descumprimento grave); garantir conformidade com normas e políticas internas, incluindo LGPD (Lei 13.709/2018), Lei Anticorrupção (12.846/2013), Marco Regulatório das OSCs (13.019/2014), ECA (8.069/1990) e demais legislações de proteção a direitos humanos, à criança e adolescente, anticorrupção, lavagem de dinheiro e proteção de dados; reportar imediatamente, pelo canal de denúncias (abreojogo.casahacker.org), qualquer suspeita de violação, conflito de interesse, ato de corrupção, discriminação ou incidente de segurança de dados; e manter sigilo sobre informações confidenciais da Casa Hacker, mesmo após o término da relação contratual.',
  'Declaro que as respostas aqui fornecidas são verdadeiras e corretas e autorizo a Casa Hacker, ou seus representantes, a verificar e confirmar as informações contidas neste questionário.',
  'Autorizo a Casa Hacker, diretamente ou por meio de terceiros vinculados contratualmente, a consultar os demais dados necessários para identificação da empresa e de seus responsáveis legais e para confirmar os dados fornecidos, incluindo, sem limitação, as bases da Receita Federal, dos Tribunais de Justiça, do Banco Nacional de Monitoramento Penitenciário, de Pessoa Politicamente Exposta, de restrições creditícias e de bases públicas, privadas e internacionais de listas restritivas (CEIS/CNEP/CEPIM, OFAC, Consolidated Screening Lists, ONU, World Bank, entre outras), de forma periódica enquanto durar a relação.',
  'Estou ciente e concordo em notificar imediatamente a Casa Hacker sobre quaisquer alterações das informações fornecidas neste questionário ou no cadastro, antes do início de qualquer relação de negócios (inclusive coletas de preço) e durante a vigência do contrato, sob pena de descadastramento, exclusão do processo de coleta ou rescisão contratual.',
  'Estou ciente de que a decisão de contratação é exclusiva da Casa Hacker, não servindo o cadastramento nem o fornecimento de informações como qualquer expectativa de contratação, e de que a Casa Hacker não assume responsabilidade por danos decorrentes de atrasos ou da decisão de não contratar.',
];

// ── Conteúdo legal: KYG (8 declarações sob as penas da lei) ─────────────────────
export const KYG_DECLARACOES: string[] = [
  'Não sou funcionário(a), contratado(a), diretor(a), associado(a) ou conselheiro(a) de administração da Casa Hacker, nem tenho cônjuge, companheiro(a), ou parente em linha reta, colateral ou por afinidade, até o 3º grau, ocupando tais posições.',
  'Não possuo prestação de contas pendente de apresentação ou reprovada pela Casa Hacker, por qualquer órgão ou instituição pública, em âmbito municipal, estadual ou federal.',
  'Não estou, direta ou indiretamente, envolvido(a) em qualquer atividade ou associação com práticas discriminatórias, incluindo, mas não se limitando a: trabalho análogo ao de escravo; exploração infantil e/ou sexual; envolvimento em escândalos públicos ou repercussão midiática negativa.',
  'Não fui condenado(a), em decisão definitiva, em matéria trabalhista, ambiental, de direitos humanos, ou por crimes relacionados ao objeto do presente projeto, tampouco por crimes contra a administração pública ou atos de corrupção, conforme as legislações aplicáveis, incluindo, mas não se limitando a: Lei nº 12.846/13 (Lei Anticorrupção); Código Penal Brasileiro; Lei nº 8.429/92 (Lei de Improbidade Administrativa); U.S. Foreign Corrupt Practices Act of 1977 (FCPA); demais legislações nacionais e estrangeiras correlatas.',
  'Não tenho vínculo direto ou indireto com partidos políticos, tampouco envolvimento público, notório ou comprovado com cargos eletivos no Poder Executivo ou Legislativo.',
  'Comprometo-me a não incluir, promover ou executar, no âmbito do projeto apresentado, quaisquer atividades de natureza religiosa, independentemente de credo ou doutrina.',
  'Comprometo-me a manter a veracidade das informações aqui prestadas durante todo o período de avaliação e execução do projeto, sob pena de exclusão imediata do processo de seleção ou revogação do apoio concedido, caso seja constatada qualquer inveracidade.',
  'Declaro estar ciente e de acordo com a Política de Investimento em Projetos da Casa Hacker disponível em https://docs.casahacker.org/governanca.',
];

// Aceite de assinatura eletrônica (comum aos dois).
export const ASSINATURA_ACEITE =
  'As partes aceitam e concordam com o processo de assinatura eletrônica desta declaração, conferindo-lhe o caráter de título certo, líquido e exigível, revestido dos requisitos de Título Executivo Extrajudicial, nos termos da legislação civil e processual civil vigente (MP 2.200-2/2001 e Lei 14.063/2020). A Associação Casa Hacker armazenará os dados de transação das partes, incluindo o registro de seus acessos ao sistema. As partes concordam em não contestar a autenticidade ou correção deste documento pelo único motivo de a assinatura ter sido efetuada em formato eletrônico.';

// ── Validade (ano fiscal = ano civil no Brasil) ─────────────────────────────────
export const fiscalYearOf = (iso?: string): number => (iso ? new Date(iso) : new Date()).getFullYear();
export const fiscalValidUntil = (year: number): string => new Date(year, 11, 31, 23, 59, 59).toISOString();
export const isFiscalValid = (rec: { validUntil?: string }): boolean =>
  !!rec.validUntil && new Date(rec.validUntil).getTime() > Date.now();

// ── Helpers de documento (CPF/CNPJ) ─────────────────────────────────────────────
export const onlyDigits = (s: any): string => String(s ?? '').replace(/\D/g, '');
export function maskCnpj(d: string): string {
  const x = onlyDigits(d);
  return x.length === 14 ? `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}` : d;
}
export function maskCpf(d: string): string {
  const x = onlyDigits(d);
  return x.length === 11 ? `${x.slice(0, 3)}.${x.slice(3, 6)}.${x.slice(6, 9)}-${x.slice(9)}` : d;
}
export const maskDoc = (d: string): string => (onlyDigits(d).length === 14 ? maskCnpj(d) : maskCpf(d));

/** Validação de dígitos verificadores do CPF. */
export function isValidCpf(value: string): boolean {
  const c = onlyDigits(value);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(c[i], 10) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === parseInt(c[9], 10) && calc(10) === parseInt(c[10], 10);
}

/** Validação de dígitos verificadores do CNPJ. */
export function isValidCnpj(value: string): boolean {
  const c = onlyDigits(value);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(c[i], 10) * w[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === parseInt(c[12], 10) && calc(13) === parseInt(c[13], 10);
}

export const KYC_TYPE_LABEL: Record<KycType, string> = { kys: 'KYS — Fornecedor', kyg: 'KYG — Organização/Liderança' };
export const KYC_STATUS_LABEL: Record<KycStatus, string> = {
  rascunho: 'Rascunho', aguardando_assinatura: 'Aguardando assinatura', assinado: 'Assinado', cancelado: 'Cancelado',
};
