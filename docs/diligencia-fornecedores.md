# Diligência de Fornecedores

Guia do usuário. A Diligência verifica, a partir de um **CNPJ**, a situação cadastral na **Receita Federal** e a presença do fornecedor em **listas de restrição** oficiais, gerando um **relatório auditável e exportável (PDF)**. Cada consulta é registrada (data-hora, IP, solicitante, APIs) e tem **validade de 30 dias**.

> Acesso: `https://stack-audit.casahacker.org` → login `@casahacker.org` → cartão **"Diligência de Fornecedores"**.

---

## O que é verificado

| Fonte | O que verifica | Como |
|---|---|---|
| **Receita Federal** (BrasilAPI) | Situação cadastral (Ativa/Baixada/Inapta/Suspensa), natureza, porte, CNAE, quadro societário (QSA) | Tempo real, por CNPJ |
| **CEIS** (CGU) | Empresas inidôneas e suspensas | Portal da Transparência |
| **CNEP** (CGU) | Empresas punidas (Lei Anticorrupção) | Portal da Transparência |
| **CEPIM** (CGU) | Entidades sem fins lucrativos impedidas | Portal da Transparência |
| **Acordos de Leniência** (CGU) | Acordos firmados | Portal da Transparência |

As listas do Portal da Transparência são consultadas por **razão social** e os resultados são filtrados pelo **CNPJ exato** do fornecedor (a API oficial não filtra por CNPJ de forma confiável; este método garante precisão).

**Fontes complementares** (Lista Suja do Trabalho Escravo / MTE, IBAMA — autuações e embargos, TCU — consulta consolidada de PJ) são listadas no relatório com **link para verificação manual**, pois o download automatizado é bloqueado pelos órgãos.

---

## Como consultar

1. No menu lateral, **Base de fornecedores** lista todos os fornecedores (com CNPJ) extraídos das prestações de contas já realizadas (Auditoria + FEAC), com o status da última diligência.
2. Para um fornecedor da base, clique em **Consultar** (ou **Ver** se já houver diligência válida).
3. Para um **CNPJ novo**, digite no campo **"CNPJ a consultar"** no topo e clique em **Consultar**.

O sistema busca a Receita e as listas e mostra o resultado em segundos.

---

## Lendo o resultado

No topo, o **veredito**:

| Veredito | Significado |
|---|---|
| 🟢 **Nada consta** | Cadastro ativo e sem registros nas listas automatizadas. |
| 🔴 **Alerta** | Há sanção/registro em alguma lista **ou** o cadastro não está Ativo. |
| 🟡 **Pendente** | Não foi possível concluir todas as verificações. |

Em seguida:

- **Dados da consulta (auditável)**: data-hora, validade, solicitante e IP.
- **Receita Federal**: situação cadastral e dados do CNPJ.
- **Listas de restrição**: status de cada lista; quando "Consta", exibe tipo de sanção, órgão, vigência, processo e fundamentação. Há link para a consulta pública oficial.
- **Fontes complementares**: links para verificação manual.

Clique em **Baixar relatório (PDF)** para o documento auditável (inclui os metadados da consulta). Use **Reconsultar** para forçar uma nova consulta antes do vencimento.

---

## Validade e histórico

- Cada diligência **vale por 30 dias**. Dentro desse prazo, abrir o fornecedor mostra o resultado salvo (sem nova consulta). Após o vencimento, o status indica **"vencida"** — clique em **Consultar/Reconsultar** para atualizar.
- O menu **Histórico** lista todas as diligências realizadas, com veredito, data e validade. Tudo fica **persistido no servidor**.

---

## Boas práticas

- Faça a diligência **antes de contratar** e **antes de pagar** fornecedores relevantes.
- Para serviços ambientais, **sempre** verifique manualmente o IBAMA (link no relatório).
- Guarde o PDF da diligência junto à prestação de contas — ele é auditável (traz data-hora, IP e fontes).
- Um veredito "Nada consta" cobre as fontes automatizadas; complemente com as fontes manuais quando o risco exigir.
