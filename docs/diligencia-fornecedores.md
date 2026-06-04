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

As listas do Portal da Transparência são consultadas por **razão social** (obtida na Receita) e os resultados são filtrados pelo **CNPJ exato** do fornecedor — percorrendo **todas as páginas** da resposta (15 registros por página), para não perder uma sanção que esteja além da primeira página. O filtro por CNPJ da API oficial é inoperante (devolve a lista inteira), então este método de **nome + CNPJ** é o que garante precisão.

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

Clique em **Exportar PDF** para abrir o relatório auditável (documento **monocromático preto**, com os metadados da consulta) — a janela já chama a impressão do navegador; escolha *Salvar como PDF*. **Baixar dados (TXT)** exporta os mesmos dados em texto. Use **Reconsultar** para forçar uma nova consulta antes do vencimento.

> O resultado de cada fornecedor tem URL própria: `/diligencia/<cnpj>` (compartilhável). As telas Base, Histórico e "Como usar" também: `/diligencia`, `/diligencia/historico`, `/diligencia/ajuda`.

---

## Geração automática

O sistema gera as diligências **sozinho, em segundo plano**:

- **Fornecedores novos** (que aparecem ao salvar novas prestações na Auditoria/FEAC) e **diligências vencidas** (30 dias) entram numa **fila** e são consultados automaticamente.
- Tudo respeita um **limite de chamadas por minuto** às APIs oficiais (env `DILIGENCIA_RATE_PER_MIN`, padrão **100**), para não estourar a cota do Portal da Transparência. Em caso de `429`, o sistema recua e tenta de novo.
- Uma **varredura periódica** (env `DILIGENCIA_SWEEP_MS`, padrão 5 min) e uma na inicialização cuidam de novos/vencidos sem intervenção. Para desligar a automação: `DILIGENCIA_AUTO=0`.
- Na **Base de fornecedores**, o botão **"Consultar todos os não consultados"** força a fila imediatamente; uma faixa mostra o progresso (concluídas / na fila / em consulta) e as linhas indicam *na fila…* / *consultando…*.

## Validade e histórico

- Cada diligência **vale por 30 dias**. Dentro desse prazo, abrir o fornecedor mostra o resultado salvo (sem nova consulta). Após o vencimento, o status indica **"vencida"** — a automação reconsulta sozinha, ou clique em **Consultar/Reconsultar**.
- O menu **Histórico** lista todas as diligências realizadas, com veredito, data e validade. Tudo fica **persistido no servidor**.

---

## Boas práticas

- Faça a diligência **antes de contratar** e **antes de pagar** fornecedores relevantes.
- Para serviços ambientais, **sempre** verifique manualmente o IBAMA (link no relatório).
- Guarde o PDF da diligência junto à prestação de contas — ele é auditável (traz data-hora, IP e fontes).
- Um veredito "Nada consta" cobre as fontes automatizadas; complemente com as fontes manuais quando o risco exigir.
