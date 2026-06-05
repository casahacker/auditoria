# Diligência de Fornecedores

Guia do usuário. A Diligência verifica, a partir de um **CNPJ**, a situação cadastral na **Receita Federal** e a presença do fornecedor em **listas de restrição** oficiais, gerando um **relatório auditável e exportável (PDF)**. Cada consulta é registrada (data-hora, IP, solicitante, APIs) e tem **validade de 30 dias**.

> Acesso: `https://auditoria.casahacker.org` → login `@casahacker.org` → cartão **"Diligência de Fornecedores"**.

---

## O que é verificado

| Fonte | O que verifica | Como |
|---|---|---|
| **Receita Federal** (BrasilAPI) | Situação cadastral (Ativa/Baixada/Inapta/Suspensa), natureza, porte, CNAE, quadro societário (QSA) | Tempo real, por CNPJ |
| **CEIS** (CGU) | Empresas inidôneas e suspensas | Portal da Transparência · por CNPJ |
| **CNEP** (CGU) | Empresas punidas (Lei Anticorrupção) | Portal da Transparência · por CNPJ |
| **CEPIM** (CGU) | Entidades sem fins lucrativos impedidas | Portal da Transparência · por CNPJ |
| **Acordos de Leniência** (CGU) | Acordos firmados | Portal da Transparência · por CNPJ |
| **Cadastro de Empregadores / "Lista Suja"** (MTE) | Trabalho análogo ao de escravo | CSV oficial · por CNPJ/CPF |
| **TCU — Licitantes Inidôneos** | Inidoneidade para licitar (art. 46, Lei 8.443/92) | Webservice público · por CNPJ |
| **PEP** (CGU) | Pessoas Expostas Politicamente (sócios do QSA) | Portal da Transparência · por nome |
| **OFAC SDN** (Tesouro/EUA) | Sanções dos EUA | Lista oficial · por nome |
| **OFAC Consolidated** (Tesouro/EUA) | Sanções setoriais não-SDN | Lista oficial · por nome |
| **UN Security Council** | Sanções da ONU | Lista consolidada · por nome |
| **EU CFSP/FSF** (UE) | Sanções financeiras da União Europeia | Lista consolidada · por nome |
| **UK Sanctions** (FCDO) | Sanções do Reino Unido | Lista oficial · por nome |
| **IDB / BID** | Sancionados pelo Banco Interamericano | Lista oficial · por nome |

São **13 listas de restrição automatizadas**. As listas do **Portal da Transparência (CGU)** são consultadas por **razão social** (obtida na Receita) e filtradas pelo **CNPJ exato**, percorrendo **todas as páginas** da resposta (o filtro por CNPJ da API oficial é inoperante, devolve a lista inteira).

- **Correspondência por CNPJ/CPF exato** (CEIS, CNEP, CEPIM, Leniência, Lista Suja, TCU): quando consta, é **definitivo** → eleva o veredito para **Alerta**.
- **Correspondência por nome** (OFAC, ONU, UE, Reino Unido, BID e PEP): casa razão social + sócios de forma **conservadora** → gera **"Atenção"** (possível homônimo; **confirme a identidade** antes de decidir), sem reprovar automaticamente.

> A consulta ambiental do **IBAMA** segue **manual** (link no relatório) — o órgão bloqueia o download automatizado.

---

## Como consultar

1. No menu lateral, **Base de fornecedores** lista todos os fornecedores (com CNPJ) extraídos das prestações de contas já realizadas (Auditoria + FEAC), com o status da última diligência.
2. Para um fornecedor da base, clique em **Consultar** (ou **Ver** se já houver diligência válida).
3. Para um **CNPJ novo**, digite no campo **"CNPJ a consultar"** no topo e clique em **Consultar**.
4. Para **vários de uma vez**, use **"Importar CNPJs"** na Base: cole uma lista (um por linha) ou envie um `.csv`/`.txt`. Os CNPJs entram na base e na fila de diligência (e passam a ser renovados automaticamente).

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
- **Listas de restrição**: status de cada lista (**Nada consta** / **Consta** / **Atenção** — correspondência por nome a confirmar). Quando "Consta", exibe tipo de sanção, órgão, vigência, processo e fundamentação, com link para a consulta pública oficial.
- **Notas jurídicas**: a base legal de cada lista consultada (lei/ato, órgão e efeito).
- **Memória do processo (proveniência técnica)**: tabela auditável de cada fonte — origem, data-hora, nº de registros processados, resultado e tipo de correspondência (CNPJ exato / nome). Permite a um terceiro reproduzir a verificação.

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
- Um veredito "Nada consta" cobre as **13 listas automatizadas**; complemente com o IBAMA (manual) quando o risco ambiental exigir.
