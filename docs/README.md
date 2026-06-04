# Stack Audit™ — Documentação

Plataforma de auditoria e prestação de contas da Associação Casa Hacker. Acesse em
`https://stack-audit.casahacker.org` (login Google `@casahacker.org`). A tela inicial é
um **launcher** com três ferramentas:

| Ferramenta | Para que serve | Guia |
|---|---|---|
| **Auditoria de Prestação de Contas** | Conciliação de NF, comprovantes e orçamento por rubrica, com IA (RAPC). | *(no app: seção "Documentação")* |
| **Processador de Prestação de Contas — SGPP / FEAC** | Concilia, trata documentos (mescla + carimbo + PDF/A-2b), Declaração de Rateio e relatório FEAC. | [processador-feac-sgpp.md](processador-feac-sgpp.md) |
| **Diligência de Fornecedores** | Consulta CNPJ na Receita + listas de restrição (CEIS/CNEP/CEPIM/Leniência), relatório auditável. | [diligencia-fornecedores.md](diligencia-fornecedores.md) |

Cada ferramenta também tem uma seção **"Como usar"** dentro do próprio app.

## URLs

Cada página tem um caminho próprio no navegador (compartilhável):

- `/` — launcher
- `/auditoria` — Auditoria de Prestação de Contas
- `/feac` — Processador FEAC (e `/feac/<id>` abre uma prestação específica)
- `/diligencia` — Diligência (e `/diligencia/<cnpj>` abre a diligência de um fornecedor)
