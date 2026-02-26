# Enrollment API - Public Demo

Backend demo (Node.js + TypeScript + PostgreSQL + Vercel Functions) for an enrollment flow with:
- course catalog,
- lead capture,
- card checkout,
- idempotency protection,
- internal lead lookup endpoint.

This repo is a **public-safe and sanitized** version of a real production architecture, prepared for technical portfolio and recruiter review.

## What this demonstrates

- Production-minded API design (validation, CORS, rate limit, security headers)
- Payment checkout with idempotency and retry-safe behavior
- Schema fallback strategy for rolling migrations
- Clear separation between public endpoints and internal token-protected queries
- Automated checks in CI (typecheck + tests)

## Stack

- Node.js 20+
- TypeScript
- Express (local adapter) + Vercel serverless handlers
- PostgreSQL
- Optional real provider integration (`e.Rede`)

## Quickstart

```bash
npm install
cp .env.example .env.local
docker compose up -d db
npm run db:setup
npm run dev
```

API base URL: `http://localhost:3000`

## Payment modes

Set `PAYMENT_PROVIDER_MODE` in `.env.local`:

- `mock` (default): deterministic fake gateway for demos.
- `rede`: real e.Rede gateway (requires `REDE_*` vars).

### Mock card scenarios

- Approved: card ending with anything except below examples.
- Declined: card ending with `0000`.
- 3DS required: card ending with `1111`.

Examples of valid numbers for demo:
- `5448280000000007` -> approved
- `5448280000070000` -> declined
- `5448280000011111` -> pending authentication

## Endpoints

- `GET /api/health`
- `GET /api/courses`
- `POST /api/leads`
- `POST /api/payments`
- `GET /api/leads` (internal lookup; requires token)

## Documentation

- Case summary: `docs/case.md`
- Flow diagrams: `docs/flows.md`
- API examples (cURL): `docs/examples.md`

## Security notes

- Keep `DATABASE_URL`, `REDE_TOKEN`, and internal tokens only in backend env.
- Use `MATRICULADOR_TOKEN_SHA256` instead of plain token whenever possible.
- In production, set explicit `FRONTEND_ALLOWED_ORIGINS`.

## Local quality checks

```bash
npm run check
```

## Recruiter context

This project highlights practical backend decisions for real transaction pipelines:
- anti-duplicate payment strategy,
- resilient DB writes,
- provider failure handling,
- operational observability via structured checkout records.
