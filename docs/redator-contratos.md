# Contratos (Tool E) — redator de contratos PJ + termos aditivos

Ferramenta da suíte **Auditoria** que gera contratos de prestação de serviços (Pessoa
Jurídica) e termos aditivos a partir de um **Termo de Referência (TR)** ou **Proposta
Comercial**, com guard-rails jurídicos rígidos. Épico #126.

## Princípios inegociáveis (guard-rails)

1. **T&C imutáveis** — os Termos e Condições são anexados **byte a byte** a partir do PDF
   oficial (`assets/contratos/termos-e-condicoes-pj-v2026-05.pdf`); o **SHA-256** é
   conferido no boot e por contrato. Se o arquivo for alterado, a geração de pacotes é
   **recusada**. O conteúdo dos T&C **nunca** passa pela IA.
2. **A IA só extrai** — o DeepSeek-V3 extrai os dados variáveis do TR/Proposta (com o
   trecho-fonte literal); **nunca redige** cláusula. A lógica do contrato é fixa.
3. **Determinismo** — somas de parcelas, datas, dígitos verificadores e valor por extenso
   são validados por **código** (`src/contratos/validacoes.ts`), nunca por IA.
4. **Aprovação humana obrigatória (HITL)** — nada vai ao Documenso sem um usuário
   autenticado aprovar; a trilha registra **quem, quando e o hash do PDF aprovado**.
5. **Gate de elegibilidade no servidor** — Receita ATIVA, diligência válida (≤30 dias),
   KYS assinado, CNAE × objeto e porte (MEI). Avaliado **sempre no servidor**.
6. **Trilha auditável** de tudo (append-only).
7. **v1 = somente Pessoa Jurídica.**

## Fluxo (wizard `/contratos/novo`, 5 passos)

1. **Fornecedor** — CNPJ → gate de elegibilidade (servidor). Inelegível bloqueia, com
   motivos e atalho para a ficha; diligência em Alerta admite **prosseguimento
   justificado** (justificativa + aprovador, na trilha).
2. **Documento** — upload do TR/Proposta (PDF/DOCX) + **issue Jira (projeto JUR)**
   validada ao vivo + nº da Ordem de Compra (opcional).
3. **Conferência** — a IA extrai os campos (cada um com o trecho-fonte) e confere a
   **completude estrutural** do TR; lacunas destacadas; **alertas** (estruturais +
   conflitos com o padrão) exigem **ciência individual**. A **vigência** é informada por
   **prazo (dias/meses)** — com botões rápidos (+1/+3/+6/+12 meses · +30/+60/+90 dias) — e
   uma **data de início estimada**; o fim e os **vencimentos das parcelas** são calculados
   (estimados) e editáveis. A vigência conta **da assinatura**, então a Cláusula 2ª usa o
   prazo relativo ("por X meses a contar da assinatura") com a data de fim apenas como
   previsão estimada — a minuta nunca sai com `[XX/XX/XXXX]`. O operador pode ainda **ligar
   cláusulas opcionais** (confidencialidade, LGPD/DPA, propriedade intelectual, multa por
   atraso, reajuste) de texto **fixo e versionado** (#157), inseridas na minuta com
   numeração dinâmica, antes da cláusula de foro. Cada campo extraído exibe o **trecho-fonte**
   e um *ver no documento* que destaca a citação no texto extraído da entrada (#152/#160).
4. **Minuta** — preview HTML + validações determinísticas; baixar PDF; salvar/enviar para
   revisão.
5. **Aprovação e assinatura** — na **ficha do contrato**: *Gerar pacote* (Contrato + TR +
   T&C) → *Aprovar (HITL interna)* → *Enviar para assinatura*. O envelope do Documenso segue
   uma **ordem fixa, sequencial**: **aprovadores** (Melissa, Everton — papel APPROVER) →
   **assinatura da Casa Hacker** (Diretor/representante legal, `geraldo@`) → **assinatura da
   Contratada** (representante legal) → **CC** (`juridico@`). Se o Documenso não suportar o
   upload, há **fallback** (baixar o pacote para envio manual). Configurável por
   `CONTRATOS_APROVADORES` / `CONTRATOS_DIRETOR_EMAIL` / `CONTRATOS_CC_EMAIL`. A conclusão da
   assinatura é detectada automaticamente por **webhook do Documenso** (#156): configure no
   Documenso um webhook do evento `DOCUMENT_COMPLETED` para
   `POST /api/contratos/webhooks/documenso` com o segredo `DOCUMENSO_WEBHOOK_SECRET` (header
   `X-Documenso-Secret` ou `?secret=`) — o contrato vira *assinado* sozinho. O botão
   *Verificar assinatura* (polling) segue como fallback.

## Termos aditivos (Fase 2)

Sobre contratos **assinados**: `prorrogacao`, `valor_parcelas`, `escopo` (novo TR, roda a
checagem estrutural) e `dados_cadastrais`. Numeração ordinal por contrato (`CH-AD-…`), gate
de elegibilidade **reavaliado** na data do aditivo, redação consolidada das cláusulas
alteradas + ratificação das demais.

## Checagem estrutural do TR ("o que não pode faltar")

A extração confere se o documento traz os elementos mínimos para a redação do contrato:
**objeto**, **valor total**, **forma de pagamento/parcelas**, **vigência/prazo** (início,
fim ou duração), **identificação da CONTRATADA** (razão social, CNPJ, endereço), **nº da
Ordem de Compra** e **condições de pagamento**. O que faltar entra em `lacunas`; observações
estruturais (ex.: "é um TR, não um contrato assinado", "sem identificação da contratada",
"sem datas — apenas duração") entram em `alertas`, que exigem **ciência individual**.

> O **radar trabalhista** (anti-pejotização, art. 3º da CLT) foi **removido** em #145 — a
> conferência foca na completude estrutural do TR, não em risco de vínculo empregatício.

## Tratamento de dados e IA (LGPD — Seção 15)

- **O que vai ao DeepSeek:** **somente** o texto do documento de entrada (TR/Proposta). Os
  **dados cadastrais** do fornecedor/representante (Cockpit/KYS) e o **conteúdo dos T&C**
  **nunca** são enviados à IA — são combinados por *merge* determinístico no servidor.
- **Minimização:** a IA recebe o mínimo necessário para extrair os campos variáveis.
- **Retenção:** os artefatos (JSON do contrato, TR de entrada, minuta, pacote e PDF
  assinado) ficam em `/app/data/contratos/<id>/` no servidor, sob backup `restic`.
- **Base legal/Provedor:** o DeepSeek é usado como operador de processamento de texto; não
  há decisão automatizada — toda geração passa por conferência e **aprovação humana**.
- **Encarregado (DPO):** privacidade@casahacker.org.

## Integração com o Jira (projeto JUR)

Todo contrato/aditivo nasce vinculado a uma issue do projeto `JUR` (validação obrigatória
na criação, sem bypass). A **sincronização** de eventos (comentários nos marcos + anexo do
PDF assinado) é **best-effort** e nunca trava o fluxo: falhas ficam visíveis no detalhe,
com botão *Reenviar ao Jira*. `JIRA_SYNC=0` desliga só a sincronização (a validação
permanece). **Não** executamos transições de workflow automaticamente.

## Variáveis de ambiente

Ver `.env.example` (seção Jira `JIRA_*`, `DOCUMENSO_URL`/`DOCUMENSO_API_TOKEN` — a mesma
instância do KYS, com S3 ligado — e `CONTRATOS_DIRETOR_EMAIL`).

## Arquivos

| Arquivo | Papel |
|---|---|
| `contratosRoutes.ts` | rotas Express (CRUD, gate, extração, minuta, HITL, Documenso, aditivos, Jira) |
| `src/contratos/contratosTypes.ts` | modelo de dados |
| `src/contratos/termosCondicoes.ts` | T&C imutáveis (SHA-256, fail-safe) |
| `src/contratos/jiraClient.ts` | validação + sincronização Jira |
| `src/contratos/validacoes.ts` | validações determinísticas + formatação (`extenso`) |
| `src/contratos/elegibilidade.ts` | gate de elegibilidade (servidor) |
| `src/contratos/extracao.ts` | pipeline DeepSeek-V3 (zod, checagem estrutural do TR) |
| `src/contratos/dadosContratada.ts` | merge Receita + KYS da CONTRATADA |
| `src/contratos/documenso.ts` | envio para assinatura (2 signatários + CC) |
| `src/contratos/templates/contratoPJ_v2026_05.ts` · `aditivoPJ_v2026_05.ts` | templates versionados (numeração de cláusulas dinâmica) |
| `src/contratos/templates/clausulasOpcionais_v2026_05.ts` | catálogo de cláusulas opcionais versionadas (#157) — texto fixo, IA não redige |
| `src/contratos/render.ts` | render HTML/PDF (rodapé IBM Plex Mono em todas as páginas) |
| `src/contratos/ContratosApp.tsx` | frontend (lista, wizard, detalhe, aditivos, ajuda) |

## Testes

- `npm run lint` — `tsc --noEmit`.
- `npm run test:contratos` — validações determinísticas (extenso, Σ parcelas, datas).
- `npm run test:contratos:e2e` — fixture E2E (TR Assistente de Comunicação) ponta a ponta.
