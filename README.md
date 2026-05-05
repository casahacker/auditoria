# Stack Audit™

[![Node.js](https://img.shields.io/badge/node-22+-339933.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/react-19-61DAFB.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/typescript-5.8-3178C6.svg)](https://www.typescriptlang.org/)
[![Azure AI](https://img.shields.io/badge/Azure%20AI-Document%20Intelligence-0078D4.svg)](https://learn.microsoft.com/azure/ai-services/document-intelligence/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Casa Hacker](https://img.shields.io/badge/by-Casa%20Hacker-purple.svg)](https://casahacker.org)

**Plataforma de auditoria financeira inteligente para organizações de impacto social.**

O **Stack Audit™** extrai, classifica e reconcilia automaticamente documentos financeiros — notas fiscais, comprovantes de pagamento, boletos e recibos de aplicativos como Uber e 99 — usando **IA generativa (DeepSeek-V3)** e **Azure AI Document Intelligence**. Transforma pilhas de PDFs em um Relatório de Conciliação (RAPC) estruturado, com parecer automático e execução orçamentária por rubrica.

## Por que o Stack Audit™?

Organizações da sociedade civil lidam com grande volume de documentos financeiros para prestação de contas. A conciliação manual é lenta, propensa a erros e desvia energia de atividades-fim.

O Stack Audit™ resolve isso ao:

- **Extrair campos com precisão** de NFS-e, boletos e recibos via Azure AI Document Intelligence
- **Analisar e classificar** cada lançamento com IA generativa (DeepSeek-V3)
- **Conciliar automaticamente** pagamentos com seus documentos fiscais
- **Gerar relatórios** prontos para apresentação com parecer final (Aprovado / Com Ressalvas / Diligência)
- **Controlar a execução orçamentária** comparando planejado × executado por rubrica

## Funcionalidades

### Extração e análise
- Upload de NFS-e, boletos e comprovantes de pagamento (PDF, JPG, PNG)
- Extração de dados por Azure AI Document Intelligence
- Análise e classificação por IA (DeepSeek-V3) com contexto de contrato
- Conciliação automática por valor, data, CNPJ/CPF e número de documento

### Relatório de Conciliação (RAPC)
- Tabela interativa com busca por código/descrição e filtro por status
- Status por lançamento: Conciliado, Ressalva ou Pendente
- Parecer final automático: **Aprovado**, **Aprovado com Ressalvas** ou **Diligência**
- Dashboard de métricas: total de itens, conciliados, pendências e valor auditado

### Execução Orçamentária por Rubrica
- Gráfico Planejado × Executado por linha do orçamento
- Leitura direta do CSV de prestação de contas (coluna "Saída (-)") e orçamento aprovado (coluna "VALOR TOTAL")
- Alerta visual quando a execução excede o limite da rubrica
- Correspondência automática por normalização de texto

### Exportação
- **CSV** — tabela RAPC completa
- **XLSX** — workbook com 3 abas: RAPC, Resumo de métricas e Execução Orçamentária

### Reauditoria e anotações
- **Reauditoria seletiva** — reprocessa apenas itens Pendente/Ressalva, preservando os já Conciliados
- **Reanálise individual** — clique em qualquer lançamento e solicite nova análise à IA com contexto adicional
- **Anotações do auditor** — campo livre por lançamento com auto-save (debounce 800ms)

### Histórico e compartilhamento
- Histórico completo de auditorias salvas no servidor
- **Link público compartilhável** com código de acesso alfanumérico (6 caracteres) para consulta sem login
- Consulta CNPJ na Receita Federal integrada ao modal de lançamento
- Lançamentos relacionados por CNPJ/CPF cruzados com outras auditorias

### Autenticação
- Login com Google OAuth 2.0
- Sessões persistentes via `session-file-store`
- Cada auditoria é associada ao usuário criador

## Tecnologias

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS 4 |
| Backend | Express 4, TypeScript (tsx runtime) |
| IA | DeepSeek-V3 via OpenAI SDK |
| OCR/Extração | Azure AI Document Intelligence |
| Exportação | SheetJS (xlsx), PapaParse |
| Autenticação | Passport.js + Google OAuth 2.0 |
| Deploy | Podman + podman-compose (RHEL 10) |

## Requisitos

- **Node.js 22+**
- Conta no **Microsoft Azure** com o recurso **Azure AI Document Intelligence** criado
- Chave de API **DeepSeek** (plataforma DeepSeek)
- Credenciais **Google OAuth 2.0** (Google Cloud Console)

## Instalação

```bash
git clone https://github.com/casahacker/stack-audit.git
cd stack-audit
npm install
```

## Variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```ini
# IA
DEEPSEEK_API_KEY=sk-...

# Azure AI Document Intelligence
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://seu-endpoint.cognitiveservices.azure.com/
AZURE_DOCUMENT_INTELLIGENCE_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Google OAuth
GOOGLE_CLIENT_ID=xxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# Sessão
SESSION_SECRET=sua-chave-secreta-aqui

# Ambiente
NODE_ENV=development
```

## Executando

### Desenvolvimento

```bash
# Frontend (Vite dev server com HMR)
npm run dev

# Backend (Express + TypeScript via tsx)
npx tsx server.ts
```

### Produção (Podman)

```bash
podman build --no-cache -t stack-audit .
podman-compose down && podman-compose up -d
```

## Estrutura do projeto

```plaintext
stack-audit/
├── src/
│   ├── App.tsx                  # Interface principal (React)
│   ├── types.ts                 # Tipos TypeScript compartilhados
│   └── services/
│       └── auditService.ts      # Lógica de análise com IA
├── server.ts                    # API REST (Express)
├── public/                      # Assets estáticos
├── Dockerfile
├── docker-compose.yml
├── vite.config.ts
└── package.json
```

## Fluxo de uso

1. **Login** com conta Google
2. **Preencha os dados** do contrato (organização, número do contrato)
3. **Faça upload** dos documentos:
   - PDF de notas fiscais (NFS-e)
   - CSV da prestação de contas (PC)
   - CSV do orçamento aprovado (opcional, para execução orçamentária)
4. **Aguarde a análise** — o progresso é exibido em tempo real
5. **Revise o RAPC** — filtre, busque e clique em lançamentos para ver detalhes
6. **Exporte** em CSV ou XLSX
7. **Compartilhe** o link público com código de acesso para a organização auditada

## Exemplos de saída

### Parecer final

| Situação | Parecer |
|---------|---------|
| 100% dos itens conciliados | ✅ **Aprovado** |
| Ressalvas presentes, sem pendências | ⚠️ **Aprovado com Ressalvas** |
| Itens pendentes de documentação | 🔴 **Diligência** |

### RAPC — tabela de conciliação

| # | Descrição | Entidade | CNPJ/CPF | Valor | Status |
|---|-----------|----------|----------|-------|--------|
| 1 | Consultoria de comunicação | Agência XYZ | 12.345.678/0001-99 | R$ 4.715,00 | ✅ Conciliado |
| 2 | Transporte — reunião regional | Maria Silva | ***.494.721-** | R$ 74,82 | ⚠️ Ressalva |
| 3 | Locação de espaço — março | Coworking ABC | 98.765.432/0001-11 | R$ 2.800,00 | 🔴 Pendente |

## Contribuindo

Contribuições são muito bem-vindas! Para sugerir melhorias ou relatar bugs, abra uma [issue](https://github.com/casahacker/stack-audit/issues).

Áreas prioritárias:
- Exportação em PDF (layout para apresentação)
- Comparativo entre auditorias do mesmo contrato
- Notificação por e-mail ao finalizar auditoria
- Painel de uso e estatísticas por usuário

## Licença

Este projeto é distribuído sob a licença MIT. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

## ❤️ Agradecimentos

- **Casa Hacker** — idealizadora e mantenedora do projeto
- **DeepSeek** — modelo de linguagem para análise inteligente
- **Microsoft Azure** — pelos créditos de API e suporte técnico
- **Comunidade open source** — que torna possível ferramentas como essa
