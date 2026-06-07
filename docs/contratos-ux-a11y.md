# Contratos (Tool E) — estudo de UI/UX e acessibilidade (#149)

Auditoria de UI/UX e acessibilidade do app de Contratos (`src/contratos/ContratosApp.tsx`:
lista, wizard de 5 passos, ficha/detalhe, wizard de aditivo e ajuda) e registro das
melhorias aplicadas. Mantém o design system **IBM Carbon** (`src/ui/kit.tsx`): cantos retos,
Sentence case, escala 12/14/16/20/28/32, movimento 110ms.

> **Validação:** o host RHEL não roda navegador e o repositório não tem CI de a11y. As
> mudanças abaixo foram revisadas no código e por `tsc`/build; a validação visual/axe/
> Lighthouse/teclado é feita pelo Geraldo no navegador (ver checklist no fim). Nada foi
> "fechado às cegas".

## Método

- Heurísticas de Nielsen + diretrizes **WCAG 2.1 AA** (foco visível, nome/rótulo, contraste,
  status programático, navegação por teclado).
- Base já conforme herdada do kit: `Btn`/`IconBtn` com `focus-visible:ring`, `Modal` com
  `role="dialog"`/`aria-modal` e focus-trap, `SkipLink`, `Select`/`Combobox` rotulados,
  `SidebarItem` com `aria-current`.

## Achados e correções aplicadas

### Acessibilidade (WCAG AA)

| # | Achado | Correção |
|---|---|---|
| A1 | Troca de passo não movia o foco — leitor de tela não anunciava a nova etapa | Foco programático no `<h2>` do passo a cada transição (`tabIndex={-1}` + `useEffect([step])`) |
| A2 | Stepper era um `<ol>` sem semântica de progresso | Virou `<nav aria-label>` com `aria-current="step"` e texto `sr-only` (atual/concluída/pendente); ícones `aria-hidden` |
| A3 | Resultados assíncronos (elegibilidade, validação do Jira, validações da minuta) não eram anunciados | Regiões `aria-live="polite"` (elegibilidade, Jira, avisos) e `role="alert"` (pendências bloqueantes) |
| A4 | Checkboxes de "ciência" tinham o texto fora do rótulo (alvo de clique e leitura quebrados) | `<label>` envolvendo `checkbox` + texto; grupo com `role="group"` + `aria-label` |
| A5 | Segmentos "Tipo do documento" e "Unidade do prazo" eram botões sem estado semântico | `role="radiogroup"`/`role="radio"` + `aria-checked` |
| A6 | Pré-visualização da minuta (scroll) não era acessível por teclado | `role="region"` + `aria-label` + `tabIndex={0}` + anel de foco |
| A7 | Linha da lista só abria por clique do mouse | ID vira `<button>` focável (`aria-label="Abrir contrato …"`), além do clique na linha |
| A8 | Campos sem rótulo programático (busca da lista; quantidade/datas do passo 3) | `aria-label` na busca e nos inputs de prazo/vencimento |
| A9 | Botões assíncronos não sinalizavam carregamento para AT | `aria-busy` nos botões de ação (avaliar, extrair, gerar minuta, salvar); spinners `aria-hidden` |
| A10 | Anéis de foco ausentes em vários inputs | `focus-visible:ring-2 focus-visible:ring-primary` nos campos do wizard |

### UX

| # | Achado | Correção |
|---|---|---|
| U1 | Minuta saía com `[XX/XX/XXXX]`/`[DATA FINAL]` (vigência e parcelas) | Vigência por **duração** (dias/meses) + datas estimadas pré-preenchidas e editáveis (#146) |
| U2 | "Enviar para assinatura" (Documenso, dispara e-mails) sem confirmação | `window.confirm` antes do envio (alinhado ao "Aprovar (HITL)" que já confirmava) |
| U3 | Cancelar o wizard podia descartar edições da conferência sem aviso | `window.confirm` ao cancelar a partir do passo 3 (o rascunho em si permanece salvo no servidor) |
| U4 | CNPJ exigia clicar no botão | Enter no campo de CNPJ dispara "Avaliar elegibilidade" |
| U5 | Preservar trabalho ao navegar entre passos | Estado do wizard vive no componente `Wizard`: **Voltar** entre passos não perde dados |

### Hierarquia, microcopy e identificador

- O identificador exibido passou a ser a **issue Jira (JUR-…)**; `CH-CT-…` é só chave interna
  (#148) — menos ruído cognitivo na lista, na ficha e no rodapé do PDF.
- Conferência reorganizada: Objeto/Valor, bloco **Vigência** (`<fieldset>`/`<legend>`) e bloco
  **Parcelas** — agrupamento por tema, com textos de apoio objetivos (estimativas marcadas).
- Radar trabalhista removido da conferência (#145): foco em **completude estrutural do TR**.

### Responsividade

- Grids `sm:grid-cols-2`, toolbars e botões rápidos com `flex-wrap`; larguras com `w-full`
  no mobile e fixas no desktop (`sm:w-[220px]`) — sem overflow horizontal.

## Itens já conformes (sem mudança)

- Modais (kit) com focus-trap e Esc; `SkipLink` para o conteúdo; barra lateral com
  `aria-current`; tokens de cor com contraste AA (`--color-warning` ajustado em fix anterior).

## Pendências / próximos passos

- Avaliar foco-trap e setas ←/→ nos `radiogroup` (hoje navegáveis por Tab; setas seriam um
  plus de conformidade total ao padrão APG).
- Tornar os **valores** das parcelas editáveis no passo 3 (hoje só os vencimentos) — fora do
  escopo de #146/#149; abrir issue se necessário.

## Checklist de validação manual (Geraldo, no navegador)

- [ ] **Teclado:** percorrer lista → wizard (1→5) → ficha só com Tab/Shift+Tab/Enter/Espaço;
      foco sempre visível; ao avançar de passo o foco vai para o título.
- [ ] **axe DevTools / Lighthouse:** 0 violações sérias/críticas em lista, wizard e ficha.
- [ ] **Leitor de tela (NVDA/VoiceOver):** elegibilidade, validação do Jira e pendências da
      minuta são anunciadas; checkboxes de ciência leem o texto do alerta.
- [ ] **Minuta:** sem `[XX/XX/XXXX]`; vigência relativa à assinatura; parcelas com datas
      estimadas; rodapé com o JUR (sem CH-CT).
- [ ] **Responsivo:** 360px e 1280px sem overflow; botões rápidos quebram linha.
