# api-demo

[![CI](https://github.com/N1ghthill/api-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/N1ghthill/api-demo/actions/workflows/ci.yml)

API de portfólio para simular um backend de matrícula com fluxo completo de checkout:
`catálogo -> lead -> pagamento -> operação interna`.

O objetivo deste repositório não é mostrar volume de código. É mostrar critérios de engenharia em um fluxo sensível: idempotência, tratamento de falha operacional, segurança de dados, documentação útil e validação automatizada.

## O que vale observar aqui

- `Idempotency-Key` em `POST /api/payments`
- persistência operacional de checkout sem expor dados sensíveis
- separação entre erro de negócio e indisponibilidade do provider
- endpoint interno autenticado para operação
- contrato OpenAPI utilizável sem abrir o código
- CI com lint, build, testes e integração com Postgres

## Arquitetura resumida

Fluxo principal:

```text
GET /api/courses
        -> catálogo

POST /api/leads
        -> valida payload
        -> persiste lead
        -> gera lead_code

POST /api/payments
        -> valida idempotência
        -> cria checkout
        -> chama provider (mock/rede)
        -> persiste estado operacional
        -> atualiza lead

GET /api/leads
        -> rota interna autenticada
        -> consulta operação por lead_code
```

Arquivos centrais para leitura:

- `api/payments.ts`
- `api/leads.ts`
- `lib/apiHandler.ts`
- `lib/paymentsDomain.ts`
- `lib/paymentsStore.ts`
- `lib/leadsDomain.ts`
- `docs/openapi.yaml`

## Stack

- Node.js + TypeScript
- Express com handlers compatíveis com Vercel
- PostgreSQL
- `pino` para logs estruturados
- provider de pagamento com modo `mock` para demonstração local e `rede` para integração real

## Endpoints

- `GET /api/health`
- `GET /api/courses`
- `POST /api/leads`
- `GET /api/leads` interno, protegido por token
- `POST /api/payments`

## Avaliação rápida para recrutadores

Se a ideia for avaliar o projeto em poucos minutos, este é o caminho mais direto:

1. Ler [docs/case.md](docs/case.md) para entender o problema técnico e as decisões.
2. Ler [docs/portfolio-checklist.md](docs/portfolio-checklist.md) para validar o repositório sem tentativa e erro.
3. Abrir [docs/openapi.yaml](docs/openapi.yaml) para ver o contrato HTTP.
4. Conferir [api/payments.ts](api/payments.ts) e [lib/paymentsStore.ts](lib/paymentsStore.ts) para o fluxo mais sensível.

## Execução local

Pré-requisitos:

- Node.js `20.20.0` ou compatível com [.nvmrc](.nvmrc) e `package.json > engines`
- npm `10+`
- PostgreSQL acessível
- `psql` instalado se você quiser aplicar migrations fora do Docker

### Com Docker

```bash
npm ci
cp .env.example .env.local
docker compose up -d db
npm run db:setup
npm run dev
```

### Sem Docker

```bash
npm ci
cp .env.example .env.local
npm run db:apply
npm run dev
```

`npm run db:apply` funciona de dois jeitos:

- usando o container `db` do `docker compose`, se ele estiver rodando
- usando `DATABASE_URL` + `psql`, se você já tiver um Postgres fora do Docker

API local: `http://localhost:3000`

## Qualidade e validação

Validação estática:

```bash
npm run lint
npm run build
npm run check
npm run docs:openapi
```

Integração com banco:

```bash
docker compose up -d db
npm run db:setup
DATABASE_URL=postgres://demo:demo@127.0.0.1:5432/enrollment_demo \
MATRICULADOR_TOKEN=integration-token \
PAYMENT_PROVIDER_MODE=mock \
npm run test:integration
```

O teste de integração cobre:

- criação de lead
- pagamento aprovado em modo `mock`
- reuso por `Idempotency-Key`
- consulta interna autenticada
- envelope padronizado para rota inexistente

## Segurança e comportamento operacional

- `X-Request-Id` em todas as respostas
- erros padronizados no formato `{ code, error, message, requestId, details? }`
- CORS restritivo em produção
- logs com redaction de `cardNumber`, `cvv`, `Authorization` e tokens internos
- `provider_response` persistido com sanitização
- falha operacional do provider é tratada como indisponibilidade, não como recusa de negócio
- inicialização da aplicação desacoplada do banco para rotas não dependentes de DB

## Modos de pagamento

No `.env.local`:

- `PAYMENT_PROVIDER_MODE=mock`
- `PAYMENT_PROVIDER_MODE=rede`

Cartões de exemplo no modo `mock`:

- aprovado: `5448280000000007`
- negado: `5448280000070000`
- requer autenticação: `5448280000011111`

## Documentação adicional

- [docs/case.md](docs/case.md)
- [docs/flows.md](docs/flows.md)
- [docs/examples.md](docs/examples.md)
- [docs/HARDENING_REPORT.md](docs/HARDENING_REPORT.md)
- [docs/portfolio-checklist.md](docs/portfolio-checklist.md)

## Escopo e trade-offs

Este repositório é uma demonstração técnica. A intenção foi priorizar:

- clareza de contrato
- comportamento confiável no fluxo sensível
- documentação executável
- legibilidade para revisão técnica

Ele não tenta cobrir tudo que existiria em um produto real, como autenticação de usuários finais, filas assíncronas, observabilidade externa ou infraestrutura completa de produção.

## Licença

MIT ([LICENSE](LICENSE))
