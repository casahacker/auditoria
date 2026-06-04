# Auditoria — Documentação

Plataforma de auditoria e prestação de contas da Associação Casa Hacker. Acesse em
`https://auditoria.casahacker.org` (login Google `@casahacker.org`). A tela inicial é
um **launcher** com três ferramentas:

| Ferramenta | Para que serve | Guia |
|---|---|---|
| **Auditoria de Prestação de Contas** | Conciliação de NF, comprovantes e orçamento por rubrica, com IA (RAPC). | *(no app: seção "Documentação")* |
| **Processador de Prestação de Contas — SGPP / FEAC** | Concilia, trata documentos (mescla + carimbo + PDF/A-2b), Declaração de Rateio e relatório FEAC. | [processador-feac-sgpp.md](processador-feac-sgpp.md) |
| **Cockpit de Fornecedores** | Diligência (Receita + listas de restrição) **e** Conformidade KYS/KYG (cadastro verificado + assinatura) por fornecedor, num só lugar. | [diligencia-fornecedores.md](diligencia-fornecedores.md) · [conformidade-kys-kyg.md](conformidade-kys-kyg.md) |

Cada ferramenta também tem uma seção **"Como usar"** dentro do próprio app.

## URLs

Cada página tem um caminho próprio no navegador (deep-link compartilhável; voltar/avançar do navegador funcionam):

| Caminho | Página |
|---|---|
| `/` | Launcher (seleção de ferramenta) |
| `/auditoria/<seção>` | Auditoria — `nova`, `processando`, `resultado`, `historico`, `pesquisa`, `documentacao` |
| `/feac` · `/feac/ajuda` · `/feac/nova` | FEAC — histórico, como usar, nova prestação |
| `/feac/<id>/<preliminar\|tratamento\|relatorio>` | FEAC — uma prestação numa etapa específica |
| `/fornecedores` (+ `/kyc` `/historico` `/ajuda` `/<cnpj\|cpf>`) | Cockpit de Fornecedores — base unificada, gestão KYS/KYG, histórico, ficha |
| `/diligencia` · `/conformidade` | Redirecionam para o cockpit |
| `/kys` · `/kyg` (+ `/<token>`) | **Página pública** do wizard KYS/KYG (sem login) |
| `/share/<token>` | Link público (somente leitura) de uma auditoria |

## Acessibilidade e design

Toda a suíte segue o design system **IBM Carbon** (IBM Plex, paleta Carbon Gray 10 + Casa Hacker), com componentes compartilhados (barra lateral, cabeçalho, botões, chips, cartões e modais). A **barra de acessibilidade** fixa no topo controla tema (claro/escuro), **alto contraste (WCAG AA)** e tamanho da fonte para todas as ferramentas.
