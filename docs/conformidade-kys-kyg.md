# Conformidade KYS / KYG — Guia

A ferramenta **Conformidade KYS / KYG** coleta e verifica os dados cadastrais de fornecedores e organizações e formaliza a conformidade com **assinatura eletrônica**, integrada ao **Documenso**.

- **KYS** (*Know Your Supplier*) — Formulário de Conformidade para **fornecedores e prestadores de serviço** (pessoa jurídica). 7 blocos: identificação da empresa, do representante legal, PEP/conflito de interesses, relacionamento político, histórico de corrupção, direitos humanos (escravidão/injúria racial/gênero/trabalho infantil), sanções, histórico contratual e impostos.
- **KYG** (*Know Your Grantee*) — Declaração de Conformidade para **OSCs sem fins lucrativos** e **lideranças pessoas físicas** que recebem **doação com encargos**. Identificação do proponente/projeto + 8 declarações sob as penas da lei.

> Acesso público (preenchimento): `https://auditoria.casahacker.org/kys` e `/kyg`.
> Painel interno (autenticado): `https://auditoria.casahacker.org/conformidade`.

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

A assinatura usa a **API do Documenso com armazenamento S3**: a cada envio, o app **gera o PDF de conformidade já pré-preenchido** e o manda para assinatura — **sem templates** e **sem `formValues`**. O setup é mínimo:

1. **Configure o Documenso com S3.** A instância (documenso.casahacker.org) precisa estar com armazenamento S3 habilitado (`NEXT_PUBLIC_UPLOAD_TRANSPORT=s3`). É o que destrava a criação de documentos e o campo de assinatura via API.
2. Em **Settings → API Tokens**, crie um token.
3. No `.env` do Auditoria, preencha e recrie o container:
   ```ini
   DOCUMENSO_URL=https://documenso.casahacker.org
   DOCUMENSO_API_TOKEN=api_...
   ```

> Com o token preenchido, **KYS e KYG ficam ambos habilitados**. Sem ele, o wizard ainda funciona e **grava o registro** (status "aguardando assinatura"), mas a etapa de assinatura fica desabilitada.

### Como funciona por baixo
Por submissão, o backend:
1. **Gera o PDF** de conformidade pré-preenchido (`kycPdf.ts`) e calcula a posição do campo de assinatura.
2. `POST /api/v1/documents` — cria o documento com **2 recipients** na ordem **`[0]` CC (solicitante da Casa Hacker)** e **`[1]` SIGNER (representante do fornecedor)**; o Documenso devolve uma **URL de upload S3** (presigned).
3. **`PUT`** do PDF na URL presigned.
4. `POST /api/v1/documents/<id>/fields` — adiciona **1 campo SIGNATURE** no recipient SIGNER, na posição devolvida pelo gerador.
5. `POST /api/v1/documents/<id>/send` — dispara o fluxo de assinatura.

O **token** do signatário (recipient com `role === "SIGNER"`) alimenta o iframe `/embed/sign/<token>` do modal. Uma **varredura no servidor** (a cada `KYC_SIGN_SWEEP_MS`, padrão 1 min) consulta `GET /api/v1/documents/<id>` e marca o registro como **assinado** quando o Documenso conclui; o PDF assinado é baixado via `GET /api/v1/documents/<id>/download`.

---

## Observações técnicas

- **Endpoints públicos** (`/api/public/kyc/*`) têm *rate limit* por IP e validação forte (checksum CPF/CNPJ, e-mail, atestação). Nenhum segredo do Documenso vai ao cliente — só o token de assinatura e o host.
- **Verificação de CPF** é por dígitos verificadores (não há base pública gratuita por nome); a régua de sanções aplica-se a CNPJ.
- Persistência: `DATA_DIR/kyc/{id}.json` (registros) e `DATA_DIR/kyc-invites.json` (convites).
