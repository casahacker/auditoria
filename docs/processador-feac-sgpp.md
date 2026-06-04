# Processador de Prestação de Contas — SGPP / Fundação FEAC

Guia do usuário. O Processador FEAC transforma um conjunto de notas fiscais, comprovantes de pagamento, extrato e a planilha de fluxo de caixa em uma **prestação de contas completa**: concilia cada lançamento com seus documentos, trata os PDFs (mescla, carimbo e PDF/A-2b), gera a Declaração de Rateio e produz o Relatório de Prestação de Contas com tudo pronto para envio à FEAC.

> Acesso: `https://stack-audit.casahacker.org` → faça login com a conta `@casahacker.org` → cartão **"Processador de Prestação de Contas — SGPP / FEAC"**.

---

## Visão geral do fluxo

```
1. Entrada de documentos  →  2. Relatório preliminar (revisão)  →  3. Tratamento  →  4. Prestação de contas
```

Cada prestação fica **salva no servidor** e aparece no **Histórico** — você pode fechar o navegador e reabrir depois, na etapa em que parou.

---

## 1. Entrada de documentos

No menu lateral, clique em **Nova prestação**. Envie:

| Campo | O que enviar |
|---|---|
| **Notas fiscais** | Os PDFs das NF-e/NFS-e. Pode selecionar vários — serão mesclados automaticamente. |
| **Comprovantes de pagamento** | Os PDFs dos comprovantes (ex.: Pix). Também aceita vários. |
| **Extrato da conta corrente** | PDF do extrato do período (opcional, mas recomendado). |
| **Fluxo de caixa (planilha)** | O arquivo **.xlsx** do centro de custo (com a aba `Dados`). |

E preencha a **Identificação (conforme SGPP)**:

- **Nome do Projeto (conforme SGPP)** — obrigatório.
- **Número do Contrato FEAC (conforme SGPP)** — obrigatório.
- **Período (início / fim)** — ex.: `01/04/2026` a `30/04/2026`. Filtra os lançamentos da planilha para o mês da prestação.

> 💡 A caixa **"Carimbo aplicado na margem de cada documento"** mostra, em tempo real, exatamente o texto que será carimbado em cada PDF. Confira antes de processar.

Clique em **Processar e conciliar**. O sistema lê a planilha, extrai o texto dos PDFs (com OCR quando necessário) e concilia automaticamente.

---

## 2. Relatório preliminar (revisão)

Aqui você revisa o resultado da conciliação **antes** de gerar os documentos finais. Cada lançamento mostra uma **situação**:

| Situação | Significado |
|---|---|
| 🟢 **Conciliado** | NF + comprovante encontrados e valores conferem. |
| 🟡 **Sem NF / Sem comprovante** | Falta um dos documentos. |
| 🔴 **Sem documentos** | Nenhum documento localizado para o lançamento. |
| 🔴 **Valor divergente** | Documento localizado, mas o valor diverge da planilha. |

**O que você pode fazer nesta tela:**

- **Marcar RATEIO** (Sim/Não) em cada lançamento. Ao marcar *Sim*, abra o lançamento (clique na linha) e informe o **valor com recurso do projeto** e o **valor com recurso próprio da OSC** — esses lançamentos entram na Declaração de Rateio.
- **Abrir um lançamento** (clique na linha) para ver detalhes, conferir o **CNPJ na Receita**, baixar a NF/comprovante localizados e ler a **Observação** (nota explicativa gerada automaticamente).
- **Exportar dados** → baixa um `.json` com a prestação (mesmo ID). Você pode editar fora do sistema e **Importar dados** de volta — o ID é preservado.
- **Documentos sem lançamento**: se algum NF/comprovante não casou com nenhuma linha, ele aparece listado para você verificar.

Quando estiver tudo certo, clique em **Tratar documentos →**.

---

## 3. Tratamento de documentos

O sistema executa, para cada lançamento conciliado:

1. **Mescla** em um único PDF — **a nota fiscal primeiro, depois o comprovante**.
2. **Carimbo** na margem esquerda de **todas as páginas**, em preto e negrito, separado por linha pontilhada:
   *"AS DESPESAS CUSTEADAS NESTE DOCUMENTO FORAM PAGAS COM RECURSOS DO TERMO DE PARCERIA COM A FEAC PARA O PROJETO {projeto} – CONTRATO {contrato} – ASSOCIAÇÃO CASA HACKER"*.
3. **Conversão para PDF/A-2b** com compressão de alta qualidade (padrão de arquivamento).

Também gera a **Declaração de Rateio** (se houver lançamentos marcados) e atualiza a planilha de fluxo de caixa.

---

## 4. Relatório de Prestação de Contas

A tela final reúne tudo:

- **Campos da prestação** (projeto, contrato, competência, período, totais).
- **Tabela com as 13 colunas**: ID, Categoria, Descrição, grupo/natureza orçamentária (FEAC), Razão Social (conforme API CNPJ), CNPJ, Data de Pagamento, Data de Emissão do Documento Fiscal, Número do Documento Fiscal, Integra Rateio, Valor (+entrada/−saída) e **Observação**.
- **Downloads**:
  - **Baixar tudo (ZIP)** — todos os documentos tratados + Declaração de Rateio + fluxo atualizado.
  - **Relatório (CSV)** — as 13 colunas.
  - **Fluxo de caixa atualizado (.xlsx)** — aba "Prestação de Contas" com as 13 colunas preenchidas, preservando as abas originais.
  - **Declaração de Rateio (PDF)** — quando houver rateio.
  - **PDF por lançamento** — cada documento tratado, nomeado no padrão **`ID - Nº NF - FORNECEDOR - VALOR.pdf`**.

---

## Dúvidas frequentes

- **Posso enviar as NFs e comprovantes como arquivos separados?** Sim — selecione vários no mesmo campo; o sistema mescla.
- **Reabri a prestação e quero mudar um rateio.** Abra a prestação no Histórico → volte ao **Relatório preliminar** → ajuste → **Tratar documentos** novamente. A Observação e os documentos são regenerados.
- **O valor de um lançamento divergiu.** A situação fica "Valor divergente" e a Observação registra a diferença; confira a NF/comprovante e corrija na planilha de origem se necessário.
- **Um fornecedor veio sem CNPJ.** O sistema tenta completar o CNPJ a partir do documento casado e busca a **Razão Social oficial na API da Receita**.

---

## Recursos complementares

A ferramenta reaproveita capacidades do Stack Audit: consulta de **CNPJ na Receita** no modal do lançamento, extração via **Azure Document Intelligence** (quando configurada) e **DeepSeek** como reforço de conciliação para casos ambíguos.
