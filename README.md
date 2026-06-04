# Stack Audit™

[![Node.js](https://img.shields.io/badge/node-22+-339933.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/react-19-61DAFB.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/typescript-5.8-3178C6.svg)](https://www.typescriptlang.org/)
[![Design](https://img.shields.io/badge/design-IBM%20Carbon-0f62fe.svg)](https://carbondesignsystem.com/)
[![Casa Hacker](https://img.shields.io/badge/by-Casa%20Hacker-32fa96.svg)](https://casahacker.org)

**Suíte de auditoria e prestação de contas para organizações de impacto social.**

O **Stack Audit™** é uma plataforma da **Associação Casa Hacker** com **três ferramentas** sob um único launcher, compartilhando autenticação, design system (IBM Carbon) e base de fornecedores:

| # | Ferramenta | Para que serve |
|---|---|---|
| **A** | **Auditoria de Prestação de Contas** | Concilia notas fiscais, comprovantes e orçamento por rubrica com IA (DeepSeek + Azure Document Intelligence) e emite o parecer final (RAPC). |
| **B** | **Processador FEAC / SGPP** | Concilia lançamentos × documentos, **trata** os PDFs (mescla, carimbo de margem, conversão **PDF/A-2b**), gera a **Declaração de Rateio** e o Relatório de Prestação de Contas para a Fundação FEAC. |
| **C** | **Cockpit de Fornecedores** | Concentra, por fornecedor, a **Diligência** (Receita Federal + listas de restrição CEIS/CNEP/CEPIM/Leniência) **e** a **Conformidade KYS / KYG** (cadastro verificado + **assinatura via Documenso**). A diferença entre fornecedores é apenas ter ou não KYS/KYG assinado. |

> O **Cockpit de Fornecedores** unifica as antigas ferramentas *Diligência* e *Conformidade KYS/KYG* numa só (o KYS/KYG é exigido apenas para contratações específicas). O preenchimento do KYS/KYG é feito pelo próprio fornecedor numa **página pública** (`/kys`, `/kyg`).

> Produção: `https://stack-audit.casahacker.org` · login Google OAuth restrito ao domínio `@casahacker.org`.

---

## Ferramentas

### A — Auditoria de Prestação de Contas (RAPC)
- Upload de 2 CSVs (orçamento aprovado + prestação de contas) e 2 PDFs (notas fiscais + comprovantes).
- Extração por **Azure AI Document Intelligence** (opcional) com fallback local (`pdftotext` + Tesseract OCR), análise e conciliação com **DeepSeek-V3**.
- Tabela RAPC interativa (busca, filtro por status, agrupamento, marcação para revisão, anotações com auto-save).
- Parecer automático: **Aprovado**, **Aprovado com Ressalvas** ou **Diligência**.
- Execução orçamentária por rubrica (Planejado × Executado), reauditoria seletiva, histórico e **link público compartilhável** com código de acesso.
- Exportação CSV/XLSX.

### B — Processador de Prestação de Contas FEAC / SGPP
Fluxo em 4 etapas, cada prestação persistida no servidor:
1. **Entrada de documentos** — notas fiscais, comprovantes e extrato (PDF) + a planilha de fluxo de caixa (`.xlsx`, aba `Dados`) + identificação do projeto/contrato (SGPP) e período.
2. **Relatório preliminar** — conciliação determinística (valor + CNPJ + nome + data, com reforço de IA para casos ambíguos), com situação por lançamento, toggle de **Rateio**, consulta de CNPJ, observação gerada e export/import JSON.
3. **Tratamento** — para cada lançamento: mescla (NF + comprovante) → **carimbo** na margem de todas as páginas → conversão **PDF/A-2b** (Ghostscript) → Declaração de Rateio (pdf-lib) → fluxo de caixa atualizado.
4. **Prestação de contas** — relatório de 13 colunas + downloads (ZIP, CSV, `.xlsx`, Declaração de Rateio, PDF por lançamento).

### C — Diligência de Fornecedores
- Consulta por **CNPJ**: cadastro completo na Receita (BrasilAPI → fallback ReceitaWS) + listas de restrição da CGU.
- As listas do Portal da Transparência são consultadas **por razão social** e filtradas pelo **CNPJ exato** — varrendo todas as páginas da resposta (o filtro por CNPJ da API oficial é inoperante). Na prática a verificação combina **nome + CNPJ**.
- Veredito **Nada consta / Alerta / Pendente**, registro auditável (data-hora, IP, solicitante, APIs), **validade de 30 dias** (cache) e base de fornecedores agregada da Auditoria + FEAC.
- **Geração automática:** fornecedores novos e diligências vencidas entram numa fila e são consultados em segundo plano, respeitando um teto de **chamadas/minuto** às APIs oficiais (com recuo em `429`). Botão **"Consultar todos os não consultados"** + faixa de progresso na Base.
- Exportação: relatório **PDF** (documento monocromático preto, pronto para arquivo, via impressão do navegador) e dados em **TXT**.

### D — Conformidade KYS / KYG
- **Página pública** (sem login) em formato de **wizard**, preenchida pelo próprio **representante legal/autorizado**: `/kys` (fornecedores PJ) e `/kyg` (OSCs e lideranças PF que recebem doação com encargos). Links genéricos ou **convites rastreáveis** gerados no painel.
- **Verificação em tempo real por APIs:** CNPJ → Receita (auto-preenche razão social, endereço, situação cadastral); **CEP** → endereço; lista de **bancos** (BrasilAPI); validação de **CPF/CNPJ** (dígitos verificadores). No envio, roda a **régua de conformidade** (CEIS/CNEP/CEPIM/Leniência) montando uma **trilha auditável** com fonte, URL e horário de cada consulta.
- **Assinatura via Documenso** (documenso.casahacker.org) por **template + `formValues`** — num **modal embutido** (iframe `/embed/sign/<token>`), sem o usuário sair da página. O **solicitante da Casa Hacker** (opcional) entra como **CC** e recebe cópia do documento assinado.
- **Painel interno** (`/conformidade`): lista todas as conformidades com filtros por fornecedor/CNPJ, tipo, status (assinado/aguardando/vencido) e **ano fiscal**; abre a trilha de conformidade, as respostas e baixa o **PDF assinado**. **Validade por ano fiscal** — renovação anual.

> **Setup único do Documenso** (uma vez): `npx tsx scripts/gen-kyc-templates.ts` gera os PDFs-template fillable em `kyc-templates/`; suba cada um como **Template** no Documenso, coloque 1 campo **SIGNATURE** + 1 recipient "Signatário", e preencha `DOCUMENSO_API_TOKEN` + `DOCUMENSO_KYS_TEMPLATE_ID`/`_KYG_` no `.env`. Sem isso, o wizard recebe os dados mas a assinatura fica desabilitada.

---

## Roteamento (URLs compartilháveis)

Cada página tem um caminho próprio no navegador (deep-link + voltar/avançar):

| Caminho | Página |
|---|---|
| `/` | Launcher |
| `/auditoria/<seção>` | Auditoria (`nova`, `processando`, `resultado`, `historico`, `pesquisa`, `documentacao`) |
| `/feac` · `/feac/ajuda` · `/feac/nova` | FEAC — histórico, como usar, nova prestação |
| `/feac/<id>/<preliminar\|tratamento\|relatorio>` | FEAC — uma prestação numa etapa específica |
| `/fornecedores` · `/fornecedores/kyc` · `/fornecedores/historico` · `/fornecedores/ajuda` | Cockpit — base unificada, gestão KYS/KYG, histórico, como usar |
| `/fornecedores/<cnpj\|cpf>` | Cockpit — ficha do fornecedor (diligência + KYS/KYG juntos) |
| `/diligencia` · `/conformidade` | Redirecionam (soft) para o Cockpit de Fornecedores |
| `/kys` · `/kyg` · `/kys/<token>` · `/kyg/<token>` | **Página pública** do wizard KYS/KYG (sem login) |
| `/share/<token>` | Link público (somente leitura) de uma auditoria |

O servidor faz fallback de SPA para qualquer rota, então recarregar ou compartilhar um deep-link funciona.

---

## Tecnologias

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS 4 |
| Design system | **IBM Carbon** (IBM Plex Sans/Mono, paleta Carbon Gray 10 + Casa Hacker) — kit compartilhado em `src/ui/kit.tsx` |
| Backend | Express 4, TypeScript (runtime `tsx`) |
| IA | DeepSeek-V3 (via OpenAI SDK) |
| OCR / Extração | Azure AI Document Intelligence (opcional) · `pdftotext` + Tesseract (fallback) |
| PDF | `pdf-lib` + `@pdf-lib/fontkit` (carimbo, rateio) · **Ghostscript** (PDF/A-2b) · `poppler-utils` (merge/split) |
| Empacotamento | `archiver` (ZIP) · SheetJS `xlsx` |
| Dados públicos | BrasilAPI / ReceitaWS (Receita) · Portal da Transparência / CGU |
| Autenticação | Passport.js + Google OAuth 2.0 (sessões em `session-file-store`) |
| Deploy | Podman + podman-compose (RHEL 10) |

### Acessibilidade
Barra fixa de acessibilidade (tema claro/escuro, **alto contraste WCAG AA**, tamanho de fonte), foco visível consistente (anel Carbon), skip-link, modais com *focus trap* + `Esc`, e rótulos ARIA nos controles. Validação de a11y/visual roda na CI.

---

## Estrutura do projeto

```text
stack-audit/
├── src/
│   ├── App.tsx                  # Launcher + Auditoria (Tool A) + roteamento de tools
│   ├── ui/kit.tsx               # Kit de UI compartilhado (Carbon): Btn, Chip, Card,
│   │                            #   ToolSidebar, ToolHeader, Modal, SkipLink, …
│   ├── feac/                    # Tool B — Processador FEAC/SGPP
│   │   ├── FeacApp.tsx
│   │   └── feacTypes.ts
│   ├── fornecedores/           # Tool C — Cockpit (unifica diligência + KYS/KYG)
│   │   └── FornecedoresApp.tsx  #   base unificada + ficha do fornecedor (reusa as views abaixo)
│   ├── diligencia/             # detalhe de diligência (ResultadoView é exportado p/ o cockpit)
│   │   └── DiligenciaApp.tsx
│   ├── kyc/                     # KYS/KYG: wizard público + views (BaseView/ConvitesView/DetailView) reusadas
│   │   ├── KycApp.tsx
│   │   ├── KycWizard.tsx        #   wizard PÚBLICO (renderizado por main.tsx em /kys /kyg)
│   │   └── kycTypes.ts          #   tipos + perguntas/declarações (KYS/KYG)
│   ├── services/auditService.ts
│   ├── types.ts
│   └── index.css                # Tokens do design system (Tailwind @theme)
├── server.ts                    # API REST (Express) — Auditoria + registro dos módulos
├── feacRoutes.ts                # API /api/feac (registerFeacRoutes)
├── diligenciaRoutes.ts          # API /api/diligencia (registerDiligenciaRoutes)
├── kycRoutes.ts                 # API /api/kyc + /api/public/kyc (registerKycRoutes)
├── scripts/gen-kyc-templates.ts # gera os PDFs-template fillable do Documenso (uso único)
├── assets/                      # Fontes IBM Plex, sRGB.icc, logos do rateio
├── docs/                        # Guias do usuário (ver docs/README.md)
├── Dockerfile
├── compose.yaml
└── vite.config.ts
```

> O estágio final do `Dockerfile` copia explicitamente `server.ts feacRoutes.ts diligenciaRoutes.ts kycRoutes.ts` + `assets`. **Todo novo arquivo de backend na raiz precisa de um `COPY`.** Arquivos sob `src/` são empacotados pelo Vite.

---

## Requisitos

- **Node.js 22+**
- **Ghostscript**, **poppler-utils** e **tesseract-ocr** (incluídos na imagem Podman) — necessários para o tratamento de PDFs do FEAC.
- Chave **DeepSeek**; (opcional) **Azure AI Document Intelligence**; **Google OAuth 2.0**; (opcional) token do **Portal da Transparência**.

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha. Resumo:

```ini
DEEPSEEK_API_KEY=sk-...                 # IA da auditoria/FEAC
GOOGLE_CLIENT_ID=...                    # Login Google
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...                      # openssl rand -hex 32
APP_URL=https://stack-audit.example.org # base do callback OAuth (sem barra final)

# Opcionais
AZURE_DI_ENDPOINT=                      # extração via Azure DI
AZURE_DI_KEY=
EXTRACTION_ENGINE=local                 # local | azure
PORTAL_TRANSPARENCIA_KEY=               # listas de restrição da Diligência (header chave-api-dados)
DILIGENCIA_RATE_PER_MIN=100             # teto de chamadas/min às APIs externas da Diligência
DILIGENCIA_SWEEP_MS=300000              # varredura de novos/vencidos (5 min; mín 60000)
DILIGENCIA_AUTO=1                       # "0" desliga a geração automática

# KYS/KYG — assinatura via Documenso (sem isso, o wizard recebe os dados sem assinar)
DOCUMENSO_URL=https://documenso.casahacker.org
DOCUMENSO_API_TOKEN=                    # Documenso → Settings → API Tokens
DOCUMENSO_KYS_TEMPLATE_ID=             # id do template KYS no Documenso
DOCUMENSO_KYG_TEMPLATE_ID=             # id do template KYG no Documenso
```

## Desenvolvimento

```bash
npm install
npx tsx server.ts        # API Express (porta 3000)
npm run dev              # Frontend Vite (HMR)
npm run lint             # tsc --noEmit (deve ficar 0)
npm run build            # build de produção (Vite)
```

## Produção (Podman)

```bash
# build (TMPDIR em /data porque /var é pequeno; formato docker p/ compatibilidade)
sudo TMPDIR=/data/podman-tmp/tmp BUILDAH_FORMAT=docker podman-compose build
sudo systemctl stop stack-audit && sudo podman rm -f stack-audit && sudo systemctl start stack-audit
# saúde: https://stack-audit.casahacker.org/api/health
```

Porta interna `127.0.0.1:18088 → 3000`, volume `/data/stack-audit/data → /app/data`, rede `10.89.11.0/24`, memória 1G (o tratamento PDF/A do FEAC é mais pesado que a auditoria).

---

## Documentação

- **`docs/README.md`** — índice dos guias do usuário.
- **`docs/processador-feac-sgpp.md`** — guia do Processador FEAC/SGPP.
- **`docs/diligencia-fornecedores.md`** — guia da Diligência de Fornecedores.
- **`docs/conformidade-kys-kyg.md`** — guia do KYS/KYG (inclui o setup do Documenso).
- Cada ferramenta também tem uma seção **"Como usar"** dentro do próprio app.

## Licença

Distribuído sob a licença Apache-2.0. Veja [LICENSE](LICENSE).

## ❤️ Agradecimentos

- **Casa Hacker** — idealizadora e mantenedora.
- **DeepSeek** e **Microsoft Azure** — IA e extração de documentos.
- **BrasilAPI**, **Receita Federal** e **Portal da Transparência / CGU** — dados públicos.
- **Comunidade open source**.
