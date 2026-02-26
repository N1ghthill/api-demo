# api-demo

[![CI](https://github.com/N1ghthill/api-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/N1ghthill/api-demo/actions/workflows/ci.yml)

API de demonstração para portfólio backend com fluxo completo de matrícula:
`catálogo -> lead -> checkout -> operação interna`.

## Stack

- Node.js + TypeScript
- Express (adapter local) + handlers compatíveis com Vercel
- PostgreSQL
- Pagamento com modo `mock` (padrão) e `rede` (real)
- Logs estruturados com `pino`

## O que este projeto demonstra

- Idempotência de pagamentos (`Idempotency-Key`)
- Tratamento resiliente de schema/migrations
- Validações reutilizáveis (email, telefone, UF, CPF)
- Rate limit com fallback em memória e suporte opcional a Redis
- Erros padronizados: `{ code, message, details?, requestId }`
- Contrato OpenAPI completo em `docs/openapi.yaml`

## Endpoints

- `GET /api/health`
- `GET /api/courses`
- `POST /api/leads`
- `GET /api/leads` (interno, exige token)
- `POST /api/payments`

## Execução local (sem Docker)

Pré-requisitos:
- Node.js 20+
- PostgreSQL rodando e acessível

```bash
npm ci
cp .env.example .env.local
npm run db:apply   # se estiver usando banco já disponível
npm run dev
```

API local: `http://localhost:3000`

## Execução local com Docker (Postgres)

```bash
npm ci
cp .env.example .env.local
docker compose up -d db
npm run db:setup
npm run dev
```

## Build de produção

```bash
npm run build
npm start
```

- `npm run build` gera saída em `dist/`
- `npm start` executa `node dist/server.js`

## Qualidade e checks

```bash
npm run lint
npm run check
```

`npm run check` executa typecheck + testes.

## OpenAPI

Contrato em `docs/openapi.yaml`.

Validar contrato:

```bash
npm run docs:openapi
```

Headers importantes documentados:
- `Idempotency-Key` em `POST /api/payments`
- `x-internal-token` (ou `x-matriculator-token`) em `GET /api/leads`

## Rate limit com Redis (opcional)

Por padrão, o rate-limit usa memória local.

Para habilitar Redis:

```env
REDIS_URL=redis://localhost:6379
```

Se `REDIS_URL` estiver ausente ou indisponível, a API faz fallback automático para memória.

## Pagamento: modos disponíveis

No `.env.local`:

- `PAYMENT_PROVIDER_MODE=mock` (padrão para demo)
- `PAYMENT_PROVIDER_MODE=rede` (integração real, exige `REDE_*`)

Exemplos mock:
- aprovado: `5448280000000007`
- negado: `5448280000070000`
- requer autenticação: `5448280000011111`

## Observabilidade e segurança

- `X-Request-Id` em todas as respostas
- logs estruturados sem exposição de `cardNumber`, `cvv`, `Authorization` e tokens internos
- `provider_response` persistido com whitelist/sanitização de campos

## Arquivos-chave para avaliação técnica

- `api/payments.ts`
- `api/leads.ts`
- `lib/apiHandler.ts`
- `lib/rateLimit.ts`
- `lib/validators.ts`
- `docs/openapi.yaml`

## Licença

MIT (`LICENSE`)
