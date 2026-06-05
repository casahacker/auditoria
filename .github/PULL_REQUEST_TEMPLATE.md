<!-- Uma PR por mudança. Descreva o "o quê" e o "porquê". -->

## O que muda

<!-- Resumo da mudança. Se fechar uma issue, use "Closes #NN". -->

## Como foi validado

- [ ] `npx tsc --noEmit` (0 erros)
- [ ] `npm run build` (Vite) verde
- [ ] Smoke do backend, se mexeu em rotas (DATA_DIR temp, `requireAuth` fake, `fetch` mockado)
- [ ] Validação visual no navegador, se mexeu na UI (após deploy, Ctrl+Shift+R antes de revalidar)

## Tipo

- [ ] `feat` — nova funcionalidade
- [ ] `fix` — correção
- [ ] `docs` — documentação (não precisa de deploy)
- [ ] `chore`/`refactor` — manutenção

## Checklist

- [ ] Novo arquivo de backend na raiz? Adicionei o `COPY` no `Dockerfile`.
- [ ] Não reverti nenhuma decisão do Carbon (cantos retos, escala 12/14/16/20/28/32, Sentence case, sidebar 256px, `--color-warning` âmbar no claro, `--color-field`, campos 40px) — ver [CONTRIBUTING](../CONTRIBUTING.md).
- [ ] Não re-adicionei a seção "Fontes complementares" (BEC-SP/IBAMA).
- [ ] Deploy feito com `APP_COMMIT`, se a mudança afeta runtime.
