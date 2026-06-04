# Conformidade KYS / KYG — Guia

A ferramenta **Conformidade KYS / KYG** coleta e verifica os dados cadastrais de fornecedores e organizações e formaliza a conformidade com **assinatura eletrônica**, integrada ao **Documenso**.

- **KYS** (*Know Your Supplier*) — Formulário de Conformidade para **fornecedores e prestadores de serviço** (pessoa jurídica). 7 blocos: identificação da empresa, do representante legal, PEP/conflito de interesses, relacionamento político, histórico de corrupção, direitos humanos (escravidão/injúria racial/gênero/trabalho infantil), sanções, histórico contratual e impostos.
- **KYG** (*Know Your Grantee*) — Declaração de Conformidade para **OSCs sem fins lucrativos** e **lideranças pessoas físicas** que recebem **doação com encargos**. Identificação do proponente/projeto + 8 declarações sob as penas da lei.

> Acesso público (preenchimento): `https://stack-audit.casahacker.org/kys` e `/kyg`.
> Painel interno (autenticado): `https://stack-audit.casahacker.org/conformidade`.

---

## Como o fornecedor preenche (página pública)

O preenchimento é feito **sem login**, num **wizard** passo a passo, **pelo representante legal ou pessoa autorizada** (há uma atestação obrigatória no início).

1. **Compartilhe o link.** Use os links genéricos `/kys` e `/kyg`, ou gere um **convite rastreável** na aba *Convites* do painel (pré-preenche o tipo, o CNPJ e você como solicitante).
2. **Identificação.** Ao informar o **CNPJ**, os dados são buscados na **Receita Federal** (razão social, nome fantasia, endereço, situação cadastral). Quando a Receita não traz o logradouro (comum em MEIs/Empresários Individuais), o endereço é **complementado por uma API de CEP** (BrasilAPI). O **CEP** também preenche o endereço; a lista de **bancos** vem da BrasilAPI. **CPF** e **CNPJ** são validados pelos dígitos verificadores em tempo real.
3. **Perguntas/declarações.** No KYS, cada pergunta Sim/Não abre um campo de **observação** quando exigido. No KYG, marque o aceite das 8 declarações.
4. **Solicitante (opcional).** Informe o **nome e e-mail da pessoa da Casa Hacker** que pediu o preenchimento — ela receberá uma **cópia** do documento assinado.
5. **Revisão e régua de conformidade.** Antes de assinar, roda-se a **régua de check** (CEIS, CNEP, CEPIM e Acordos de Leniência do Portal da Transparência), registrando uma **trilha auditável**.
6. **Assinatura.** O documento é criado no **Documenso** e assinado num **modal embutido** — sem sair da página. A assinatura tem validade jurídica (MP 2.200-2/2001 e Lei 14.063/2020) e o cofre de assinatura do Documenso aplica o certificado ICP-Brasil.

---

## Painel interno

A aba **Conformidades** lista tudo o que foi preenchido, com filtros por **fornecedor/CNPJ**, **tipo** (KYS/KYG), **status** (assinado, aguardando assinatura, vencido, rascunho) e **ano fiscal**. Abra um registro para ver:

- a **trilha de conformidade** (cada fonte consultada, URL e horário);
- as **respostas** completas do formulário;
- o **PDF assinado** (download direto do Documenso).

A aba **Convites** gera e lista os links rastreáveis.

## Elegibilidade

A ferramenta classifica automaticamente cada conformidade como **Elegível** ou **Inelegível**. É **elegível** quem atende a TODOS os critérios:

1. **Não consta** em listas de restrição (CEIS/CNEP/CEPIM/Leniência) e tem **cadastro ATIVO** na Receita (veredito "Nada consta").
2. **Respostas adequadas** — todas as perguntas de risco respondidas como **"Não"** (PEP, conflito de interesse, condenações/investigações, escravidão, sanções, etc.).
3. **Impostos/previdência cumpridos** — a pergunta de obrigações previdenciárias respondida como **"Sim"** (cumpriu).

Inelegíveis aparecem com os **motivos** no detalhe; a lista tem **filtro por elegibilidade**. No KYG, as 8 declarações são obrigatórias para enviar, então a elegibilidade depende essencialmente de **não constar em restrições**.

## Validade e renovação

Cada conformidade vale por **ano fiscal** (ano civil). Registros assinados em anos anteriores aparecem como **"Vencido"** e devem ser **renovados** com um novo preenchimento. O painel destaca o que precisa renovar.

---

## Setup do Documenso (uma vez)

A assinatura usa **template + `formValues`** (o Documenso desta instalação usa armazenamento local; este é o caminho que não exige S3). Passos:

1. **Gere os PDFs-template fillable:**
   ```bash
   npx tsx scripts/gen-kyc-templates.ts
   # saída: kyc-templates/KYS_template.pdf e KYG_template.pdf
   ```
   Os campos AcroForm são nomeados exatamente como o `formValues` que o backend envia.
2. No **Documenso** (documenso.casahacker.org), em **Templates → New Template**, suba cada PDF. Adicione **1 recipient** ("Signatário") e coloque **1 campo SIGNATURE** (e, se quiser, NAME/DATE) na área *"ASSINADO ELETRONICAMENTE"* da última página. Salve/abilite.
3. Em **Settings → API Tokens**, crie um token.
4. No `.env` do Stack Audit, preencha e recrie o container:
   ```ini
   DOCUMENSO_API_TOKEN=api_...
   DOCUMENSO_KYS_TEMPLATE_ID=<id do template KYS>
   DOCUMENSO_KYG_TEMPLATE_ID=<id do template KYG>
   ```

> Sem essas variáveis o wizard ainda funciona e **grava o registro** (status "aguardando assinatura"), mas a etapa de assinatura fica desabilitada.

### Como funciona por baixo
Por submissão, o backend chama `POST /api/v1/templates/<id>/create-document` com os `recipients` (signatário + CC solicitante) e os `formValues` (que o Documenso insere nos campos do PDF), depois `POST /api/v1/documents/<id>/send`. O **token** do signatário volta na resposta e alimenta o iframe `/embed/sign/<token>` do modal. A conclusão é confirmada via `GET /api/v1/documents/<id>` (status `COMPLETED`).

---

## Observações técnicas

- **Endpoints públicos** (`/api/public/kyc/*`) têm *rate limit* por IP e validação forte (checksum CPF/CNPJ, e-mail, atestação). Nenhum segredo do Documenso vai ao cliente — só o token de assinatura e o host.
- **Verificação de CPF** é por dígitos verificadores (não há base pública gratuita por nome); a régua de sanções aplica-se a CNPJ.
- Persistência: `DATA_DIR/kyc/{id}.json` (registros) e `DATA_DIR/kyc-invites.json` (convites).
