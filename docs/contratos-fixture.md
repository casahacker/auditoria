# Fixture E2E — Contratos (DoD da Fase 1, #136)

Fixture real da Seção 17: **TR "Assistente de Comunicação e Conteúdo"**.

O `.docx` da fixture fica em `referencia/contratos/` (não versionado — `.gitignore`).
O teste E2E roda com `npm run test:contratos:e2e` e valida o pipeline ponta a ponta
(extração → gate → minuta) contra o gabarito abaixo. Como a chamada ao DeepSeek ao vivo
exige `DEEPSEEK_API_KEY` (produção), o teste injeta o gabarito como `aiClient` mock e
valida a **plumbing**: zod, lacunas, checagem estrutural, validações determinísticas e o
contrato gerado. A acurácia do modelo ao vivo é exercida em produção com a chave real.

## Gabarito da extração

| Campo | Valor esperado |
|---|---|
| `objeto` | comunicação / produção de conteúdo |
| `vigencia.duracaoMeses` | **6** |
| `vigencia.prorrogavel` | **true** (até **12** meses) |
| `vigencia.dataInicio` / `dataFim` | **null** (lacuna) |
| `valorTotalCentavos` | **1 800 000** (R$ 18.000,00) |
| `parcelas` | **6 × R$ 3.000,00**, vencimentos propostos (regra "5º dia útil do mês subsequente"), editáveis |
| `condicoesPagamento` | NF conforme CNAEs + Relatório Mensal + validação da Diretoria |
| `equipamentosFornecidosPelaContratante` | laptop/celular corporativos + acessos |
| `lacunas` | dados da contratada, data de início, issue JUR, nº da OC |
| `alertas` | estruturais: "é um TR, não um contrato assinado"; "sem identificação da contratada"; "sem datas — apenas duração" |

**Checagem estrutural** ("o que não pode faltar" no TR) — a extração lista em `lacunas` os
elementos mínimos ausentes (objeto, valor total, parcelas, vigência/prazo, identificação da
CONTRATADA, nº da OC, condições de pagamento) e registra observações em `alertas`. O **radar
trabalhista** (anti-pejotização) foi **removido** (#145).

## Gabarito do contrato (render)

- **Cláusula 3ª** — "R$ 18.000,00 (dezoito mil reais)".
- **Cláusula 4ª** — 6 parcelas de "R$ 3.000,00".
- **Cláusula 5ª** — referencia os T&C **versão 2026-05**.

## Gate (16.2)

Fornecedor **sem KYS assinado** ou **sem diligência válida** → `POST /api/contratos/:id/extrair`
responde **422** (não chega ao passo 3 do wizard). O gate é avaliado **no servidor**.
