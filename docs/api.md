# Referência da API REST

Endpoints do backend (Express, em `server.ts` + os módulos `feacRoutes.ts`,
`diligenciaRoutes.ts`, `kycRoutes.ts`). Para a arquitetura, veja
[`arquitetura.md`](arquitetura.md).

- **Base:** mesma origem do app (produção: `https://auditoria.casahacker.org`).
- **Formato:** JSON, salvo onde indicado (`report.html`, `*.pdf`, `*.zip`, `*.xlsx`, `txt`).
- **Tudo que não casa `/api/*` nem um arquivo estático** cai no **fallback de SPA**
  (`GET *` → `index.html`).

### Autenticação

| Marcador | Significado |
|---|---|
| 🔒 **sessão** | Exige login (`requireAuth`) — cookie de sessão via Google OAuth (`@casahacker.org`). |
| 🌐 **público** | Sem login; **_rate limit_ por IP**. Usado pelo wizard KYS/KYG. |
| 🎫 **token** | Público, mas exige um _token_ no caminho/_query_ (link compartilhável ou acesso de uso único). |

Respostas de erro usam o código HTTP adequado (`400` validação, `401` não autenticado,
`403` token inválido, `404` inexistente, `429` _rate limit_) com um corpo `{ error: "…" }`.

---

## 1. Autenticação e sessão

| Método | Caminho | Auth | Descrição |
|---|---|---|---|
| `GET` | `/auth/google` | 🌐 | Inicia o fluxo OAuth do Google. |
| `GET` | `/auth/google/callback` | 🌐 | _Callback_ do OAuth; cria a sessão e redireciona. |
| `GET` | `/auth/logout` | 🔒 | Encerra a sessão. |
| `GET` | `/api/me` | 🌐 | Usuário da sessão (ou `401` se não logado). |
| `GET` | `/api/health` | 🌐 | _Healthcheck_ (`200` quando vivo). |

---

## 2. Auditoria de Prestação de Contas (Tool A)

| Método | Caminho | Auth | Descrição |
|---|---|---|---|
| `POST` | `/api/extract-pdf` | 🔒 | Extrai texto de um PDF (Azure DI ou local). _Upload_ multipart. |
| `GET` | `/api/cnpj/:cnpj` | 🔒 | Consulta cadastral de CNPJ (BrasilAPI → ReceitaWS). |
| `POST` | `/api/audit-run` | 🔒 | Roda uma auditoria (extração + análise DeepSeek + conciliação RAPC). |
| `GET` | `/api/audits` | 🔒 | Lista as auditorias. |
| `GET` | `/api/audits/related` | 🔒 | Auditorias relacionadas (mesmo projeto/OSC). |
| `GET` | `/api/audits/:id` | 🔒 | Detalhe de uma auditoria. |
| `PATCH` | `/api/audits/:id` | 🔒 | Edita uma auditoria (anotações, marcação de revisão, etc.). |
| `POST` | `/api/audits/:id/reprocess` | 🔒 | Reauditoria (total ou seletiva). |
| `DELETE` | `/api/audits/:id` | 🔒 | Remove uma auditoria. |
| `GET` | `/api/audits/:id/files/:filename` | 🔒 | Baixa um arquivo da auditoria. |
| `GET` | `/api/audits/:id/items/:itemId/doc` | 🔒 | Documento de um item (NF/comprovante). |
| `GET` | `/api/search` | 🔒 | Busca itens entre auditorias. |
| `GET` | `/api/items/:code` | 🔒 | Histórico de um item por código. |
| `GET` | `/api/share/:token` | 🎫 | **Link público (somente leitura)** de uma auditoria. |

---

## 3. Processador FEAC / SGPP (Tool B)

Todas 🔒. `:id` é a prestação.

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/feac` | Lista as prestações. |
| `GET` | `/api/feac/:id` | Detalhe da prestação. |
| `POST` | `/api/feac/:id/parse` | Faz o _parse_ da planilha "Dados" + matching dos lançamentos. |
| `POST` | `/api/feac/:id/audit` | (Re)gera o relatório preliminar / observações. |
| `PATCH` | `/api/feac/:id` | Edita a prestação (toggles de rateio, campos, etc.). |
| `POST` | `/api/feac/:id/import` | Importa um JSON de prestação (preserva IDs). _Upload_. |
| `GET` | `/api/feac/:id/export` | Exporta a prestação como JSON. |
| `POST` | `/api/feac/:id/treat` | **Tratamento**: mescla → carimbo → PDF/A-2b → rateio. |
| `GET` | `/api/feac/:id/items/:lancId/doc` | PDF tratado de um lançamento. |
| `GET` | `/api/feac/:id/rateio.pdf` | Declaração de Rateio (PDF). |
| `GET` | `/api/feac/:id/fluxo` | Fluxo de caixa atualizado (`.xlsx`). |
| `GET` | `/api/feac/:id/zip` | Pacote completo da prestação (ZIP). |
| `DELETE` | `/api/feac/:id` | Remove a prestação. |

---

## 4. Diligência (parte da Tool C)

Todas 🔒. `:cnpj` aceita CNPJ (ou CPF) só com dígitos.

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/diligencia` | Histórico de diligências. |
| `GET` | `/api/diligencia/suppliers` | Base de fornecedores (agregada de Auditoria + FEAC + importados). |
| `GET` | `/api/diligencia/:cnpj` | Diligência de um CNPJ (cache ≤ 30 dias). |
| `POST` | `/api/diligencia/:cnpj/check` | Força uma nova consulta deste CNPJ. |
| `GET` | `/api/diligencia/:cnpj/report.html` | Relatório auditável (HTML monocromático; imprime em PDF). |
| `GET` | `/api/diligencia/:cnpj/txt` | Mesmos dados em texto. |
| `POST` | `/api/diligencia/import` | Importa CNPJs (`{ text }` colado/CSV **ou** `{ cnpjs: [] }`). |
| `POST` | `/api/diligencia/run-all` | Enfileira todos os não consultados. |
| `POST` | `/api/diligencia/run-all-force` | **Reconsulta toda a base** (ignora o cache de 30 dias). |
| `GET` | `/api/diligencia/queue` | Progresso da fila de diligência. |

---

## 5. Cockpit de Fornecedores (Tool C)

Todas 🔒. `:doc` é o CNPJ/CPF (só dígitos). Unifica diligência + KYS/KYG por fornecedor.

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/fornecedores` | Base unificada (cadastro + diligência + KYS/KYG + elegibilidade + filtros). |
| `GET` | `/api/fornecedores/:doc` | Ficha consolidada de um fornecedor. |
| `PATCH` | `/api/fornecedores/:doc` | Edita o cadastro (marca o campo como `manual`). |
| `POST` | `/api/fornecedores/:doc/refresh` | Atualização cadastral rápida (Receita + CEP). |
| `POST` | `/api/fornecedores/:doc/diligencia` | Diligência completa (15 fontes) deste fornecedor. |
| `POST` | `/api/fornecedores/refresh-all` | Atualização cadastral **em massa** (todas as APIs). |
| `GET` | `/api/fornecedores/refresh-all/status` | Progresso da atualização em massa. |
| `GET` | `/api/fornecedores/:doc/report.html` | Relatório consolidado **colorido** (cadastro + listas + notas + memória). |

---

## 6. KYS/KYG — wizard público (Tool D)

🌐 **público** com _rate limit_. Não exige login (é o link que o fornecedor preenche).
Os endpoints de **relatório/documento** são adicionalmente 🎫 (exigem `?token=<accessToken>`,
devolvido no envio).

| Método | Caminho | Auth | Descrição |
|---|---|---|---|
| `GET` | `/api/public/kyc/banks` | 🌐 | Lista de bancos (BrasilAPI). |
| `GET` | `/api/public/kyc/cep/:cep` | 🌐 | Endereço por CEP. |
| `GET` | `/api/public/kyc/cnpj/:cnpj` | 🌐 | Pré-preenche o cadastro pela Receita. |
| `GET` | `/api/public/kyc/validate-doc/:doc` | 🌐 | Valida CPF/CNPJ (dígitos verificadores). |
| `GET` | `/api/public/kyc/invite/:token` | 🌐 | Resolve um convite rastreável (pré-preenche tipo/CNPJ/solicitante). |
| `POST` | `/api/public/kyc/submit` | 🌐 | **Envia** o formulário: grava o registro, roda a régua de conformidade e dispara a assinatura (Documenso). Devolve `id` + `accessToken`. |
| `POST` | `/api/public/kyc/:id/comprovante` | 🌐 | Anexa comprovante bancário (PDF/imagem, ≤ 10 MB, janela de 24 h). |
| `POST` | `/api/public/kyc/:id/completed` | 🌐 | Sinaliza que o signatário concluiu a assinatura no modal. |
| `GET` | `/api/public/kyc/:id/report.html` | 🎫 | Relatório de conformidade consolidado (colorido). |
| `GET` | `/api/public/kyc/:id/document.pdf` | 🎫 | Cópia do documento KYS/KYG (assinado, se concluído; senão o preenchido). |

---

## 7. KYS/KYG — painel interno

Todas 🔒. `:id` é o registro de conformidade.

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/kyc` | Lista as conformidades (filtros: fornecedor, tipo, status, ano fiscal). |
| `GET` | `/api/kyc/:id` | Detalhe de uma conformidade (respostas + trilha). |
| `GET` | `/api/kyc/:id/signature-status` | _Status_ da assinatura (poll enquanto pendente). |
| `GET` | `/api/kyc/:id/signed.pdf` | PDF assinado (do Documenso; serve o local quando legado). |
| `GET` | `/api/kyc/:id/comprovante` | Comprovante bancário anexado. |
| `GET` | `/api/kyc/invites` | Lista os convites rastreáveis. |
| `POST` | `/api/kyc/invite` | Cria um convite (gera o link `/kys/<token>` ou `/kyg/<token>`). |

---

> **Notas**
> - Os endpoints públicos (§6) têm _rate limit_ por IP (`publicLimiter`/`submitLimiter`).
> - O `accessToken` dos relatórios públicos é aleatório, gerado no envio e devolvido ao
>   front — não é o _id_ do registro.
> - `report.html` aciona `window.print()` ao abrir; para obter o HTML por _script_,
>   busque a rota com as credenciais e leia o corpo (não dependa do `Runtime.evaluate`).
