# Contribuindo com o Auditoria

Obrigado por contribuir! Este guia descreve o fluxo de trabalho, a validação e o deploy.
Para entender o sistema por dentro, leia [`docs/arquitetura.md`](docs/arquitetura.md).

> Este é um software interno da **Associação Casa Hacker**. O acesso em produção é
> restrito ao domínio `@casahacker.org`.

---

## Pré-requisitos

- **Node.js 22+**
- Para mexer no tratamento de PDF do FEAC: **Ghostscript**, **poppler-utils** e
  **tesseract-ocr** (já vêm na imagem Podman).

## Ambiente local

```bash
cp .env.example .env       # preencha as chaves (ver comentários no arquivo)
npm install
npm run dev                # frontend Vite (HMR) na :3000
npx tsx server.ts          # API Express (:3000) — use DATA_DIR de teste, nunca o de prod
```

> ⚠️ **Nunca** rode `npx tsx server.ts` apontando para o `DATA_DIR` de produção: os
> _workers_ de segundo plano (varredura de diligência e de assinatura) disparam consultas
> reais e escrevem no volume. Em desenvolvimento, use um `DATA_DIR` temporário.

---

## Fluxo de trabalho

1. **Uma PR por mudança.** Mantenha cada PR focada num assunto.
2. Trabalhe no branch **`feat/feac-sgpp-processor`** (o branch de trabalho que produção
   acompanha). Commite, faça push e abra a PR **para `main`**.
3. **Conventional commits:** `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`. Mensagens com
   parênteses/aspas: use `git commit -F arquivo.txt` para evitar problemas de _shell_.
4. **Valide** (abaixo) antes de abrir a PR.
5. Faça o **merge** e, se a mudança afetar o _runtime_, o **deploy** (abaixo). Mudanças
   só de documentação não precisam de deploy.

## Validação

```bash
npx tsc --noEmit       # type-check (deve ficar 0)
npm run build          # build de produção (Vite)
```

No servidor da Casa Hacker, o build de produção roda como root (o `dist/` é servido pelo
container). O comando equivalente:

```bash
NODE_BIN=$(which node)
sudo env TMPDIR=/tmp PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" "$NODE_BIN" \
  ./node_modules/vite/bin/vite.js build
sudo chown -R geraldo:geraldo dist
```

### Smoke test do backend

Para rotas de backend, prefira um **smoke isolado** a subir o servidor inteiro: monte um
app Express só com as rotas em teste, com um **`DATA_DIR` temporário**, um `requireAuth`
**fake**, **sem `DOCUMENSO_API_TOKEN`** e com o **`global.fetch` mockado**. Rode com
`npx tsx` **dentro de `/data/apps/auditoria`** (senão o `node_modules` não resolve). Assim
você exercita o handler sem tocar em produção nem em APIs externas.

---

## Deploy de produção (servidor da Casa Hacker)

Sempre passe o **`APP_COMMIT`** (carimba o commit no rodapé/memória do relatório):

```bash
cd /data/apps/auditoria
export APP_COMMIT=$(git rev-parse --short HEAD)
sudo env TMPDIR=/data/podman-tmp/tmp APP_COMMIT="$APP_COMMIT" podman-compose build
sudo systemctl restart auditoria.service
curl -fsS https://auditoria.casahacker.org/api/health     # espera 200
```

Depois de um deploy de frontend, dê **Ctrl+Shift+R** antes de revalidar no navegador (o
bundle JS fica em cache).

> **Pegadinha do `Dockerfile`:** o estágio de runtime **não** empacota `src/` — ele copia
> os `.ts` de backend explicitamente. Ao criar um novo arquivo de backend na raiz, adicione
> um `COPY` no `Dockerfile`, senão a CI/`build` passam mas o **container quebra em runtime**.

---

## Design system (IBM Carbon) — **não reverter**

A UI segue o IBM Carbon de forma rigorosa. As decisões abaixo são intencionais; **não as
reverta** sem pedido explícito (detalhes em [`docs/arquitetura.md`](docs/arquitetura.md) §9):

- **Cantos retos** (`--radius-*: 0`); nunca "arredondar" de volta.
- Escala tipográfica **12/14/16/20/28/32**; **Sentence case** (sem CAIXA ALTA/tracking).
- **Sidebar 256px**, movimento **110ms**, token **`--color-field`** nos campos, campos
  **40px** com anel de foco **2px**.
- **`--color-warning`** é **âmbar escuro `#8d6a00`** no tema claro (contraste WCAG AA) e
  `#f1c21b` no escuro — **não** troque por amarelo vivo no claro.
- **Nunca** recrie uma classe CSS com nome de _utility_ do Tailwind (ex.: `.font-normal`):
  uma regra _unlayered_ vence `@layer utilities` e quebra os componentes do kit.
- O `.animate-spin` tem **exceção** sob `prefers-reduced-motion`/"sem animação" (spinner
  funcional não pode congelar) — **mantenha**.

### Outras pegadinhas

- O **Cockpit** (`FornecedoresApp` → `DetailView`) renderiza a diligência **por conta
  própria** — não reusa o `ResultadoView`. Ao editar a tela de diligência do cockpit, mexa
  no `FornecedoresApp`.
- Ao derivar identificador de rota (`/fornecedores/<doc>`), **exclua** os segmentos de seção
  reservados (`ajuda`, `historico`, `kyc`, `convites`, `detalhe`), senão recarregar/
  compartilhar a URL abre uma ficha vazia.
- A seção "Fontes complementares" (BEC-SP/IBAMA) foi **removida** a pedido — **não**
  re-adicionar.

---

## Estrutura do código

Veja a [árvore do projeto no README](README.md#estrutura-do-projeto) e a
[arquitetura técnica](docs/arquitetura.md). Resumo: `server.ts` é o entrypoint e injeta os
módulos `feacRoutes.ts` / `diligenciaRoutes.ts` / `kycRoutes.ts`; o frontend fica em `src/`
(kit em `src/ui/kit.tsx`, a11y em `src/a11y/`).
