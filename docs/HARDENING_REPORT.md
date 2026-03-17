# Relatório de hardening

Data: 2026-03-17  
Repositório: `N1ghthill/api-demo`  
Escopo: consistência de runtime, redução de atrito para avaliação técnica e reforço do fluxo principal para portfólio.

## Resumo

Este ciclo consolidou o projeto para que o que o README promete realmente aconteça em runtime e em pipeline:

- envelope de erro padronizado também para rotas inexistentes;
- boot desacoplado de `DATABASE_URL` para preservar healthcheck e reduzir atrito local;
- correção do fluxo de erro do provider para não persistir falhas operacionais como recusa do cliente;
- CORS mais seguro em produção;
- scripts de banco alinhados com Docker **ou** `DATABASE_URL` + `psql`;
- modularização de domínio e persistência de `leads` e `payments`;
- testes de integração reais cobrindo `lead -> payment -> internal lookup`.

## Entregas principais

### 1. Consistência de runtime

- `server.ts` passou a criar a aplicação via `lib/app.ts`, facilitando testes e padronização.
- O fallback 404 agora usa o mesmo envelope `{ code, error, message, requestId, details? }`.
- O pool de banco em `lib/db.ts` foi tornado lazy, evitando falha de boot por import antecipado.

### 2. Correção de fluxo sensível

- Erros de credencial/configuração do provider deixaram de ser persistidos como `declined`.
- Falhas HTTP do provider agora são tratadas como indisponibilidade operacional, sem corromper estado de negócio.

### 3. Setup e DX

- `package.json` recebeu `engines` e `packageManager`.
- `.nvmrc` foi adicionado para alinhar local, CI e troubleshooting.
- `scripts/db-apply.sh` agora suporta:
  - `docker compose` com o container `db`;
  - `DATABASE_URL` + `psql` para banco já existente.
- `scripts/db-setup.sh` e `scripts/db-apply.sh` carregam `.env.local` ou `.env`.

### 4. Modularização

- Regras de domínio de leads foram extraídas para `lib/leadsDomain.ts`.
- Regras de domínio de pagamento foram extraídas para `lib/paymentsDomain.ts`.
- Persistência/estado operacional de pagamento foi extraída para `lib/paymentsStore.ts`.

### 5. Testes e automação

- Mantidos: `lint`, `typecheck`, testes unitários e OpenAPI lint.
- Adicionados:
  - `tests/app-startup.test.ts`
  - `tests/cors.test.ts`
  - `tests/api.integration.test.ts`
- O CI passou a executar integração com Postgres antes do smoke do app compilado.

## Verificação executada

Checks previstos neste hardening:

- `npm run lint`
- `npm run typecheck`
- `npm run check`
- `npm run docs:openapi`
- `npm run test:integration`

## Situação de dependências

- `npm audit --omit=dev`: sem vulnerabilidades em runtime.
- `npm audit`: ainda há ruído em dependências de tooling/dev, principalmente na cadeia de `@vercel/node` e documentação.

## Risco residual

- O fluxo de pagamento continua concentrado em um handler relativamente grande, embora já mais modular.
- Ainda vale evoluir a separação para camadas mais explícitas (`service` / `repository` / `serializer`) se o repo for virar base de produto.
- O ruído de tooling em `npm audit` não afeta runtime, mas pode ser reduzido em um próximo ciclo.
