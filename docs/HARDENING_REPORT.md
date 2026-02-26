# Hardening Report

Date: 2026-02-26
Repository: `N1ghthill/api-demo`
Scope: production hardening + portfolio polish on backend API.

## Summary

This hardening cycle focused on production-readiness and demonstrable engineering quality without breaking endpoint behavior:

- standardized middleware and error envelopes;
- added structured, redacted logging;
- introduced reusable validation layer;
- added scalable (optional) Redis rate-limit backend with memory fallback;
- upgraded build/runtime flow to `dist/` for production use;
- formalized contract and operational docs (OpenAPI + security policy + CI + Dependabot).

## Delivered Areas

1. Build and runtime hardening
- `npm run build` now emits compiled output to `dist/`.
- `npm start` now runs `node dist/server.js`.
- Dockerfile migrated to multi-stage build for smaller, cleaner runtime image.

2. Middleware and API consistency
- Security headers + request-id + CORS + method checks + rate-limit are centralized in `lib/apiHandler.ts`.
- Duplicate header application in handlers removed.
- Error response envelope standardized to:
  - `{ code, error, message, requestId, details? }`
- Backward compatibility retained through `error` field and existing business error codes.

3. Observability and sensitive-data safety
- Added `pino` structured logger with explicit redaction list.
- Removed direct `console.*` logging from handlers.
- Provider persistence (`provider_response`) now stores sanitized/whitelisted fields only.
- Sensitive fields explicitly protected: `cardNumber`, `cvv`, `authorization`, internal tokens.

4. Validation consistency
- Created shared validator module: `lib/validators.ts`.
- Consolidated email/phone/UF/CPF/sanitize usage across `api/leads.ts` and `api/payments.ts`.
- Added dedicated tests for validator behavior.

5. Rate-limit scalability (optional)
- Default behavior remains in-memory limiter.
- If `REDIS_URL` is set, limiter uses Redis (`INCR + PTTL`) with same external behavior.
- If Redis fails/unavailable, fallback to memory store without breaking requests.

6. Contract, docs and automation
- OpenAPI contract added: `docs/openapi.yaml` covering:
  - `GET /api/health`
  - `GET /api/courses`
  - `POST /api/leads`
  - `GET /api/leads` (internal token)
  - `POST /api/payments` (idempotency)
- Added script: `npm run docs:openapi`.
- CI expanded: install, lint, build, check, OpenAPI lint.
- Added:
  - `.github/dependabot.yml`
  - `SECURITY.md`
  - `.github/CODEOWNERS`

## Verification Executed

Local checks executed successfully:

- `npm ci`
- `npm run lint`
- `npm run build`
- `npm run check`
- `npm run docs:openapi`

Runtime smoke check executed against compiled app:

- `DATABASE_URL=... PORT=3005 node dist/server.js`
- `GET /api/health` -> `{ "ok": true }`

GitHub Actions result:

- CI run `22464875388` passed after hardening push.

## Residual Risks / Follow-ups

1. OpenAPI warnings (non-blocking)
- Current lint has warnings for local/example server URLs and missing tag descriptions.
- Contract is valid and accepted; warnings are documentation quality improvements only.

2. Dependency vulnerability noise
- `npm audit` currently reports transitive vulnerabilities in ecosystem dependencies.
- Recommended follow-up: controlled dependency update cycle with compatibility testing.

3. Redis operational setup
- Redis mode is optional and resilient by design.
- For production enablement, recommend managed Redis with auth/TLS and observability.

## Acceptance Mapping

- `npm ci && npm run check`: ✅
- CI on push/PR: ✅
- OpenAPI valid and covering required routes/headers: ✅
- Memory limiter default + Redis optional: ✅
- Request-id + safe structured logs + redaction: ✅
- README/docs updated for local/docker/tests/openapi/redis: ✅

## Notes

The hardening preserves endpoint paths and core usage semantics while making runtime behavior and maintenance significantly more production-grade.
