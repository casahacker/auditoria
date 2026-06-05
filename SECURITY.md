# Política de Segurança

O **Auditoria** é uma plataforma interna da **Associação Casa Hacker** que lida com dados
cadastrais e de conformidade de fornecedores (CNPJ/CPF, documentos, listas de restrição).
Levamos relatos de segurança a sério.

## Como reportar uma vulnerabilidade

**Não abra uma _issue_ pública** para relatar vulnerabilidades de segurança.

Envie os detalhes em **privado** para **operacoes@casahacker.org**. Inclua, se possível:

- uma descrição do problema e do impacto;
- passos para reproduzir (PoC, requisições, _logs_);
- a versão/_commit_ afetado (o rodapé dos relatórios mostra o `APP_COMMIT`).

Faremos o possível para confirmar o recebimento e manter você informado sobre a correção.

## Escopo

- O acesso em produção (`https://auditoria.casahacker.org`) é restrito ao domínio
  `@casahacker.org` via Google OAuth.
- As páginas **públicas** `/kys` e `/kyg` (wizard de conformidade) são acessíveis sem
  login, com _rate limiting_ por IP e validação de entrada — relatos sobre elas são
  especialmente bem-vindos.

## Boas práticas adotadas

- Cabeçalhos de segurança aplicados no **nginx**; container com `no-new-privileges`.
- Nenhum segredo do Documenso/IA é exposto ao cliente.
- Relatórios públicos do wizard são protegidos por _token_ de acesso de uso único.
- Segredos ficam em `.env` (`root:root`, fora do versionamento).

> Se encontrar um segredo commitado por engano no histórico, **reporte em privado** —
> não o publique numa _issue_.
