# api-demo

API de demonstração para portfólio backend: fluxo completo de **catálogo -> lead -> checkout -> operação interna**, com foco em qualidade de produção.

Resumo rápido (para recrutadores):
- Stack: Node.js, TypeScript, PostgreSQL, Vercel Functions.
- Escopo: endpoint público de cursos/leads/pagamentos + endpoint interno protegido.
- Engenharia: idempotência de pagamento, validações fortes, fallback de schema, rate limit, headers de segurança, testes automatizados.

## O que este projeto demonstra

- Design de API orientado a operação real.
- Evita cobrança duplicada com `Idempotency-Key`.
- Persistência resiliente de tentativas de checkout.
- Separação clara entre tráfego público e consulta interna autenticada.
- Integração de pagamento desacoplada por modo (`mock` / `rede`).

## Arquitetura

- `api/health.ts`: healthcheck.
- `api/courses.ts`: catálogo de cursos ativos.
- `api/leads.ts`: criação e busca interna de leads com token/hash.
- `api/payments.ts`: checkout com idempotência e atualização de status.
- `lib/rede.ts`: gateway de pagamento (mock e e.Rede).
- `db/init/*.sql`: schema, seeds e tabelas de checkout/idempotência.

## Fluxo principal

1. Frontend cria lead em `POST /api/leads`.
2. Frontend inicia pagamento em `POST /api/payments` com `Idempotency-Key`.
3. API registra checkout em `processing`, consulta provider e persiste resultado.
4. Repetição com mesma chave retorna o mesmo resultado sem nova cobrança.
5. Equipe interna consulta `GET /api/leads` com token seguro.

Diagramas completos em `docs/flows.md`.

## Como rodar localmente

Pré-requisitos:
- Node.js 20+
- Docker + Docker Compose

```bash
npm install
cp .env.example .env.local
docker compose up -d db
npm run db:setup
npm run dev
```

Base URL local: `http://localhost:3000`

## Modo de pagamento

No `.env.local`:

- `PAYMENT_PROVIDER_MODE=mock` (padrão para demo)
- `PAYMENT_PROVIDER_MODE=rede` (integração real, exige `REDE_*`)

Cenários mock:
- aprovado: cartão válido (ex: `5448280000000007`)
- negado: final `0000` (ex: `5448280000070000`)
- exige autenticação: final `1111` (ex: `5448280000011111`)

## Documentação complementar

- `docs/case.md`: contexto e decisões de engenharia.
- `docs/flows.md`: diagramas de sequência.
- `docs/examples.md`: exemplos cURL ponta a ponta.

## Qualidade e segurança

- Input validation de payload e campos críticos.
- CORS controlado + allowlist de origens.
- Rate limit por endpoint.
- Headers de segurança e request-id.
- Tokens internos com comparação segura e suporte a hash SHA-256.
- Testes + typecheck:

```bash
npm run check
```

## Pontos de avaliação técnica

Se você estiver avaliando este repositório para vaga backend, os pontos principais estão em:
- `api/payments.ts`: idempotência, tratamento de erro de provider e consistência de status.
- `api/leads.ts`: autenticação de endpoint interno e normalização/validação de dados.
- `lib/rede.ts`: estratégia de provider mockável para demo e testes.
- `db/init/060_payment_idempotency.sql`: base SQL para prevenção de duplicidade.

## Licença

MIT (`LICENSE`).
