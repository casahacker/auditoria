# Arquitetura técnica

Documento para desenvolvedores. Descreve como o **Auditoria** está montado por dentro:
processo, módulos, modelo de dados, fluxos, integrações e deploy. Para o uso de cada
ferramenta, veja os guias em [`docs/README.md`](README.md).

> **Resumo em uma frase:** um único processo Node (Express, executado via `tsx`) serve a
> API REST **e** os arquivos estáticos do SPA (React/Vite); os dados ficam em **arquivos
> JSON** sob um volume (sem banco de dados); a autenticação é Google OAuth; tudo roda num
> container Podman no RHEL.

---

## 1. Visão geral

O Auditoria é uma **suíte de 4 ferramentas** sob um único launcher, num único deployável:

| Tool | Nome | Backend | Frontend |
|---|---|---|---|
| **A** | Auditoria de Prestação de Contas (RAPC) | `server.ts` | `src/App.tsx` |
| **B** | Processador FEAC / SGPP | `feacRoutes.ts` | `src/feac/FeacApp.tsx` |
| **C** | Cockpit de Fornecedores (Diligência + KYS/KYG) | `diligenciaRoutes.ts` + `kycRoutes.ts` | `src/fornecedores/FornecedoresApp.tsx` |
| **D** | Wizard público KYS/KYG | `kycRoutes.ts` (`/api/public/kyc/*`) | `src/kyc/KycWizard.tsx` |

> A "Tool C" unifica o que antes eram duas ferramentas (Diligência e Conformidade). A
> "Tool D" é a face **pública** (sem login) da conformidade. Ver §4 e §5.

### Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React 19 · TypeScript · Vite 6 · Tailwind CSS 4 |
| Design system | IBM Carbon (kit próprio em `src/ui/kit.tsx`) — ver §8 |
| Backend | Express 4 · TypeScript executado por **`tsx`** (sem passo de compilação no runtime) |
| Persistência | **Arquivos JSON** sob `DATA_DIR` (sem banco) |
| Auth | Passport.js · Google OAuth 2.0 · sessões em arquivo (`session-file-store`) |
| IA | DeepSeek-V3 (via OpenAI SDK) |
| Extração | Azure AI Document Intelligence (opcional) · `pdftotext` + Tesseract (fallback) |
| PDF | `pdf-lib` + `@pdf-lib/fontkit` · **Ghostscript** (PDF/A-2b) · `poppler-utils` |
| Assinatura | Documenso (API v1, armazenamento S3) |
| Deploy | Podman + podman-compose (RHEL 10) |

---

## 2. Topologia do processo

```text
                          ┌──────────────────────────────────────────┐
   navegador  ──HTTPS──►  │  nginx (host)  auditoria.casahacker.org   │
                          └───────────────────┬──────────────────────┘
                                              │ proxy → 127.0.0.1:18088
                          ┌───────────────────▼──────────────────────┐
                          │  container `auditoria` (Podman)           │
                          │  ┌────────────────────────────────────┐  │
                          │  │  Node (npx tsx server.ts) :3000     │  │
                          │  │   ├─ /api/*      → API REST          │  │
                          │  │   ├─ /assets/*   → estáticos (Vite)  │  │
                          │  │   └─ *           → SPA fallback      │  │
                          │  └────────────────────────────────────┘  │
                          │  volume  /data/auditoria/data → /app/data │
                          └───────────────────────────────────────────┘
```

Não há serviços separados: **um processo** faz API + entrega do SPA + os _workers_
de segundo plano (varredura de diligência, varredura de assinatura). Estado em disco,
nada em memória entre reinícios além do que está no volume.

---

## 3. Frontend

SPA React empacotado pelo Vite. O entrypoint `src/main.tsx` tem **dois modos**:

- **App autenticado** (`<App/>`) — launcher + as ferramentas internas. Exige login.
- **Wizard público** (`<KycWizard/>`) — renderizado direto, **sem passar pelo gate de
  login**, quando a URL casa `^/(kys|kyg)(/|$)` (`IS_KYC_PUBLIC` em `main.tsx`). É a
  página que o fornecedor preenche.

**Roteamento:** SPA com History API (`pushState`/`popstate`). Cada ferramenta parseia o
próprio caminho (deep-link + voltar/avançar). O backend faz **fallback de SPA** (qualquer
rota não-`/api` e não-estática serve o `index.html`), então recarregar um deep-link
funciona. Mapa de rotas: ver README e [`docs/README.md`](README.md).

> **Pegadinha de roteamento:** ao derivar um identificador do caminho (`/fornecedores/<doc>`),
> sempre exclua os segmentos reservados de seção (`ajuda`, `historico`, `kyc`, `convites`,
> `detalhe`). Senão `/fornecedores/ajuda` é interpretado como uma ficha `doc="ajuda"` ao
> recarregar/compartilhar a URL.

**Componentização:** `src/ui/kit.tsx` é a **camada-fonte** dos componentes (Btn, Chip,
Card, ToolSidebar/Header, Modal com focus-trap, Select, SearchInput, Combobox, …). Mudar o
kit propaga para toda a suíte. A **barra de acessibilidade** é vendorizada em `src/a11y/`
(11 funções, sem Libras). O Cockpit (`fornecedores/`) **reusa** views exportadas por
`diligencia/DiligenciaApp.tsx` (`ResultadoView`, `provTechLine`) e `kyc/KycApp.tsx`
(`BaseView`, `DetailView`, `ConvitesView`).

> **Pegadinha:** o Cockpit (`FornecedoresApp` → `DetailView`) **renderiza a diligência por
> conta própria** (não reusa o `ResultadoView`). Ao mexer na tela de diligência do cockpit,
> edite o `FornecedoresApp`.

**Build:** `vite build` → `dist/`. O `APP_URL` entra como **build-arg** (URL pública usada
pelo frontend); o `dist/` é copiado para o estágio de runtime do container.

---

## 4. Backend

### Entrypoint e módulos

`server.ts` é o entrypoint. Ele:

1. configura Passport + Google OAuth e o middleware de sessão (arquivo);
2. define os helpers compartilhados (`requireAuth`, `sanitizeSegment`, extração de PDF,
   cliente de IA, `execFileAsync`, …);
3. serve a **Tool A (Auditoria/RAPC)** diretamente (`/api/audits`, `/api/audit-run`,
   `/api/extract-pdf`, `/api/cnpj`, `/api/search`, `/api/share/:token`, …);
4. **injeta** os outros módulos via funções `register*Routes(app, ctx)`;
5. registra os estáticos do Vite e o **fallback de SPA**.

| Módulo | Registro | Prefixos | Contexto recebido |
|---|---|---|---|
| `feacRoutes.ts` | `registerFeacRoutes(app, ctx)` | `/api/feac/*` | `DATA_DIR`, `requireAuth`, `sanitizeSegment`, `extractTextFromFile`, `parseJsonSafe`, `slugify`, `aiClient`, `execFileAsync` |
| `diligenciaRoutes.ts` | `registerDiligenciaRoutes(app, ctx)` | `/api/diligencia/*` | `DATA_DIR`, `requireAuth`, `sanitizeSegment` |
| `kycRoutes.ts` | `registerKycRoutes(app, ctx)` | `/api/kyc/*`, `/api/public/kyc/*`, `/api/fornecedores/*` | `DATA_DIR`, `requireAuth`, `sanitizeSegment` |

O **padrão de injeção de contexto** (`FeacCtx`/`DiligenciaCtx`/`KycCtx`, exportados por cada
módulo) evita import cruzado e mantém um único dono de coisas como o `DATA_DIR` e o
`requireAuth`. Cada módulo é autocontido (rotas + workers + helpers próprios).

> A referência completa dos endpoints está em [`docs/api.md`](api.md).

### Autenticação e segurança

- **Google OAuth 2.0** restrito ao domínio **`@casahacker.org`** (a estratégia rejeita
  e-mails fora do domínio). Sessão persistida em arquivo (`DATA_DIR/sessions`).
- **`requireAuth`** protege todas as rotas internas (`/api/*` autenticadas e o painel).
- **Endpoints públicos** (`/api/public/kyc/*`) têm **rate limit por IP** e validação forte
  (checksum CPF/CNPJ, e-mail, atestação). Nenhum segredo do Documenso vai ao cliente.
- Relatórios públicos do wizard são **gated por `accessToken`** (token aleatório gerado no
  envio e devolvido ao front).
- **`helmet`** com `hsts/frameguard/referrerPolicy/CSP` **desligados no app** — os
  cabeçalhos de segurança são aplicados pelo **nginx** (evita duplicação).

### Workers de segundo plano

- **Diligência** (`diligenciaRoutes.ts`): fila em memória + worker serial + `sweep()` que
  enfileira todo fornecedor sem registro válido (novo, vencido **ou** com versão de fontes
  antiga). Roda no boot e a cada `DILIGENCIA_SWEEP_MS`. Toda chamada externa passa por um
  **rate limiter global** (`DILIGENCIA_RATE_PER_MIN`, recuo em `429`).
- **Assinatura** (`kycRoutes.ts`): varredura a cada `KYC_SIGN_SWEEP_MS` que consulta o
  Documenso e marca como **assinado** os registros concluídos.

---

## 5. Modelo de dados

**Não há banco de dados.** Cada entidade é um arquivo JSON (ou um diretório por entidade)
sob `DATA_DIR` (no container, `/app/data`; no host, o volume `/data/auditoria/data`).

| Caminho (sob `DATA_DIR`) | Conteúdo |
|---|---|
| `audits/` | Auditorias RAPC (Tool A) — uma por id |
| `feac/<id>/` | Prestações FEAC (Tool B) — JSON + arquivos tratados |
| `diligencia/<doc>.json` | Registro de diligência por CNPJ/CPF (veredito, sanções, proveniência, `validUntil`, `fontesVersao`) |
| `diligencia-extra-suppliers.json` | CNPJs importados manualmente para a base |
| `fornecedores/<doc>.json` | **Perfil consolidado** do fornecedor (cadastro editável) |
| `kyc/<id>.json` | Registros KYS/KYG |
| `kyc-invites.json` | Convites rastreáveis |
| `kyc-uploads/<id>.<ext>` | Comprovantes anexados no wizard |
| `kyc-legacy/<secondaryId>.pdf` | PDFs de conformidade assinados **antes** do app (importados) |
| `sources/` | Cache das listas de sanção baixadas (SDN, OFAC cons., ONU, UE, BID, UK, Lista Suja, `cobes-sp.csv`) |
| `sessions/` | Sessões do Passport |

### Perfil consolidado (`fornecedores/<doc>.json`)

O cockpit mantém um cadastro por fornecedor com **propriedade de campo**: `{ fields, manual:{campo:true}, fontes }`.

- **`refresh`/atualização das APIs:** a API **vence** quando traz dado não-vazio
  (sobrescreve e limpa a flag `manual`); dado vazio **preserva** o que está gravado.
- **`PATCH`** (edição na tela): grava o valor e marca o campo como `manual`.
- Exceção: o conjunto `KYS_OWNED` (banco/agência/conta/PIX/observações) é semeado do KYS e
  **não** é sobrescrito pelas APIs.

---

## 6. Fluxos principais

### Tool A — Auditoria / RAPC
`upload (2 CSV + 2 PDF)` → **extração** (Azure DI **ou** `pdftotext`+Tesseract, conforme
`EXTRACTION_ENGINE`) → **análise/conciliação** por **DeepSeek-V3** → tabela RAPC editável →
**parecer** (Aprovado / Aprovado com Ressalvas / Diligência) → export CSV/XLSX + link público.

### Tool B — FEAC / SGPP
`upload (PDFs + planilha .xlsx)` → parse da aba **"Dados"** (filtra por período) →
**matching determinístico** (valor + CNPJ + nome + data; reforço de IA só para ambíguos) →
relatório preliminar editável → **tratamento** por lançamento: mescla (NF+comprovante) →
**carimbo** na margem → conversão **PDF/A-2b** (Ghostscript) → **Declaração de Rateio**
(`pdf-lib`) → fluxo de caixa atualizado → **ZIP/CSV/.xlsx**. A coluna **Observação** é uma
nota explicativa **determinística** (sem LLM, por auditabilidade).

### Diligência (parte da Tool C)
`CNPJ` → **Receita** (BrasilAPI → fallback ReceitaWS, endereço complementado por API de CEP)
→ **15 listas de restrição** (ver [guia](diligencia-fornecedores.md)). As listas da CGU são
consultadas por **razão social** e filtradas por **CNPJ exato** (o filtro por CNPJ da API é
inoperante). Resultado: **veredito** + **proveniência técnica** (URL/método/HTTP/latência/
cache, hash de integridade, `diligenciaId`) + cache de **30 dias** versionado por
`SOURCES_VERSION` (entrada/saída de fonte invalida o cache).

### KYS/KYG + Documenso (Tools C/D)
`wizard público` → checagens em tempo real (`/api/public/kyc/{cnpj,cep,banks,validate-doc}`)
→ **envio**: roda a régua de conformidade (CGU + PEP), computa **elegibilidade**, e —
se houver `DOCUMENSO_API_TOKEN` — dispara a **assinatura via Documenso** (S3):

```text
generateKycPdf(rec)                       # PDF pré-preenchido + posição da assinatura
  → POST /api/v1/documents                # cria doc; recipients [0]=CC, [1]=SIGNER; devolve uploadUrl S3
  → PUT  <uploadUrl>                       # envia o PDF
  → POST /api/v1/documents/{id}/fields     # campo SIGNATURE no SIGNER
  → POST /api/v1/documents/{id}/send       # dispara
  → iframe /embed/sign/<token do SIGNER>   # assinatura no modal
  → varredura marca "assinado"; download por /api/v1/documents/{id}/download
```

O painel autenticado (`/conformidade`, embutido no Cockpit) lista, filtra por ano fiscal e
baixa o PDF assinado.

---

## 7. Integrações externas

| Serviço | Uso | Variável |
|---|---|---|
| DeepSeek-V3 | Análise da auditoria / matching ambíguo do FEAC | `DEEPSEEK_API_KEY` |
| Azure AI Document Intelligence | Extração de PDF (opcional) | `AZURE_DI_*`, `EXTRACTION_ENGINE` |
| BrasilAPI / ReceitaWS | Receita Federal, CEP, bancos | — |
| Portal da Transparência / CGU | CEIS, CNEP, CEPIM, Leniência, PEP | `PORTAL_TRANSPARENCIA_KEY` |
| Listas de sanção (OFAC, ONU, UE, UK, BID, Lista Suja, TCU, TCE-SP) | Restrições | `*_URL` (overrides) |
| Documenso | Assinatura eletrônica (S3) | `DOCUMENSO_URL`, `DOCUMENSO_API_TOKEN` |

> **Fontes via cron no host (fora do container):** **COBES/Prefeitura-SP** e **UK Sanctions**
> são baixadas por scripts no host (`/data/scripts/refresh_cobes_sp.sh`,
> `refresh_diligencia_sources.sh`) que normalizam o arquivo para `DATA_DIR/sources/`. Motivo:
> o DNS interno do container não resolve o host da FCDO (UK), e o índice do COBES tem _drift_
> de nome/numeração. O app lê o cache; o cron mantém fresco.

---

## 8. Infraestrutura e deploy

Definição em `compose.yaml`:

| Item | Valor |
|---|---|
| Container | `auditoria` (rootful), `no-new-privileges` |
| Porta | `127.0.0.1:18088 → 3000` (só local; nginx faz o TLS) |
| Rede | `auditoria-net` · subnet **`10.89.11.0/24`** |
| Volume | `/data/auditoria/data → /app/data:z` (SELinux relabel) |
| Memória | limite **1G** (o tratamento PDF/A do FEAC é mais pesado) |
| `extra_hosts` | `s3.casahacker.org:10.89.0.1` (alcança o AIStor via nginx do host — anti-hairpin) |
| Fuso / IP | `TZ=America/Sao_Paulo`, `SERVER_IP` (registrado na trilha de auditoria) |
| systemd | `auditoria.service` (com limpeza de **bridge stale** no `ExecStartPre`) |
| nginx (host) | `auditoria.casahacker.org` — TLS + security-headers + _reverse proxy_ → `:18088` |

### Dockerfile (2 estágios)

1. **builder** (`node:22-alpine`): `npm install` → `vite build` (com `APP_URL` build-arg) → `dist/`.
2. **runtime** (`node:22-alpine`): instala **`poppler-utils`, `tesseract-ocr` (+por), `ghostscript`**;
   copia `dist/` + os `.ts` de backend + `assets/`; roda `npx tsx server.ts`.

> **Pegadinha do `COPY`:** o estágio de runtime **não** empacota `src/` — ele copia
> explicitamente `server.ts feacRoutes.ts diligenciaRoutes.ts kycRoutes.ts kycPdf.ts` **+
> `src/kyc/kycTypes.ts`** + `assets`. **Todo novo arquivo de backend na raiz precisa de um
> `COPY`** (a CI/`vite build` passam sem ele, mas o container quebra em runtime).

> **Healthcheck:** o Podman **ignora** o `HEALTHCHECK` do Dockerfile (formato OCI); o
> healthcheck que vale é o do `compose.yaml` (`wget http://127.0.0.1:3000/api/health`).

### Build & deploy de produção

```bash
cd /data/apps/auditoria
export APP_COMMIT=$(git rev-parse --short HEAD)   # carimba o commit no rodapé do relatório
sudo env TMPDIR=/data/podman-tmp/tmp APP_COMMIT="$APP_COMMIT" podman-compose build
sudo systemctl restart auditoria.service
curl -fsS https://auditoria.casahacker.org/api/health   # espera 200
```

O fluxo de contribuição (validação local, smoke test, uma PR por mudança) está em
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## 9. Decisões de design

- **Sem banco de dados:** o domínio é de baixo volume e alta auditabilidade — arquivos JSON
  são simples de inspecionar, versionar e cobrir por backup (`restic`). Cada registro é
  autocontido.
- **Determinismo onde importa:** a **Observação** do FEAC e a **elegibilidade** KYS/KYG são
  computadas por regra (sem LLM) — reprodutíveis e auditáveis. A IA fica nos pontos
  tolerantes a ruído (análise da auditoria, matching ambíguo).
- **Proveniência:** toda diligência grava URL/método/HTTP/latência/cache + hash de
  integridade + commit (`APP_COMMIT`), para que um terceiro reproduza a verificação.
- **IBM Carbon rigoroso (não reverter):** cantos retos (`--radius-*: 0`), escala tipográfica
  12/14/16/20/28/32, _Sentence case_, sidebar 256px, movimento 110ms, token `--color-field`,
  campos 40px com anel de foco 2px, e `--color-warning` **âmbar escuro** (`#8d6a00`) no tema
  claro / `#f1c21b` no escuro (contraste WCAG AA). O kit (`src/ui/kit.tsx`) é a fonte única.
- **Acessibilidade:** barra vendorizada (`src/a11y/`), `prefers-reduced-motion` respeitado
  (com **exceção** para o `.animate-spin` — spinner funcional não pode congelar), foco
  visível, alvos 44px, alto contraste reusando os tokens `.high-contrast`.

---

## 10. Onde olhar primeiro

| Quero entender… | Comece por |
|---|---|
| Como uma ferramenta funciona para o usuário | [`docs/`](README.md) |
| Os endpoints da API | [`docs/api.md`](api.md) |
| Como contribuir / fazer deploy | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| O wiring do backend | `server.ts` (final do arquivo: `register*Routes`) |
| A página pública | `src/main.tsx` (`IS_KYC_PUBLIC`) + `src/kyc/KycWizard.tsx` |
| O design system | `src/ui/kit.tsx` + `src/index.css` |
