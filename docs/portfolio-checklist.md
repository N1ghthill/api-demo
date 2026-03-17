# Checklist de avaliação técnica

Checklist curto para alguém avaliar o repositório rapidamente sem precisar descobrir o fluxo por tentativa e erro.

## 1. Validar ambiente

```bash
nvm use
npm ci
cp .env.example .env.local
```

## 2. Validar qualidade estática

```bash
npm run lint
npm run check
npm run docs:openapi
```

O que deve ser observado:
- lint limpo;
- typecheck limpo;
- testes unitários cobrindo utilitários sensíveis;
- contrato OpenAPI válido.

## 3. Validar fluxo real com banco

```bash
docker compose up -d db
npm run db:setup
DATABASE_URL=postgres://demo:demo@127.0.0.1:5432/enrollment_demo \
MATRICULADOR_TOKEN=integration-token \
PAYMENT_PROVIDER_MODE=mock \
npm run test:integration
```

O que esse teste cobre:
- criação de lead;
- pagamento aprovado em modo `mock`;
- reuso por `Idempotency-Key`;
- consulta interna autenticada de leads;
- envelope padronizado em rota inexistente.

## 4. Arquivos para leitura rápida

- `README.md`
- `docs/case.md`
- `docs/flows.md`
- `docs/examples.md`
- `api/payments.ts`
- `api/leads.ts`
- `lib/apiHandler.ts`
- `lib/paymentsDomain.ts`
- `lib/paymentsStore.ts`
- `docs/openapi.yaml`

## 5. Sinais positivos esperados

- Existe narrativa clara de problema de negócio.
- O contrato HTTP é legível sem abrir o código.
- O projeto prova idempotência, não só afirma.
- Há cuidado com logs e dados sensíveis.
- O CI faz mais do que lintar.

## 6. Perguntas que o repo já deve responder bem

- Como o sistema evita cobrança duplicada?
- O que acontece quando o provider falha?
- Como o endpoint interno é protegido?
- Como validar rapidamente o projeto localmente?
- Qual é o caminho entre documentação, código e comportamento real?
