# API Examples (cURL)

Assuming local API at `http://localhost:3000`.

## Health

```bash
curl -sS http://localhost:3000/api/health
```

## List courses

```bash
curl -sS http://localhost:3000/api/courses
```

## Create lead

```bash
curl -sS -X POST http://localhost:3000/api/leads \
  -H 'Content-Type: application/json' \
  -d '{
    "course_slug": "enfermagem",
    "name": "Ana Silva",
    "email": "ana@example.com",
    "phone": "31999999999",
    "cpf": "52998224725",
    "birth_date": "1995-04-20",
    "father_name": "Carlos Silva",
    "mother_name": "Maria Silva",
    "address": {
      "cep": "30110000",
      "street": "Rua Exemplo",
      "number": "100",
      "neighborhood": "Centro",
      "city": "Belo Horizonte",
      "state": "MG"
    },
    "course_requirements_ack": {
      "minimum_experience_two_years": true,
      "coren_active_two_years_auxiliar": true,
      "professional_link_proof": true,
      "professional_link_proof_type": "ctps"
    }
  }'
```

## Create payment (idempotent)

Replace `<LEAD_ID>` with the previous response value.

```bash
curl -sS -X POST http://localhost:3000/api/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: checkout-demo-001' \
  -d '{
    "lead_id": "<LEAD_ID>",
    "course_slug": "enfermagem",
    "installments": 1,
    "customer": {
      "name": "Ana Silva",
      "email": "ana@example.com",
      "phone": "31999999999",
      "cpf": "52998224725"
    },
    "card": {
      "holder_name": "ANA SILVA",
      "number": "5448280000000007",
      "exp_month": "12",
      "exp_year": "2030",
      "cvv": "123"
    },
    "source_url": "http://localhost:5500/checkout.html"
  }'
```

Run the same request again with the same key to confirm `idempotent_reused: true`.

## Internal lead lookup

```bash
curl -sS "http://localhost:3000/api/leads?payment_status=declined&limit=20" \
  -H "x-matriculator-token: YOUR_INTERNAL_TOKEN"
```
