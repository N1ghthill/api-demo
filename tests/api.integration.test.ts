import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo, Server } from "node:net";
import test, { after, before } from "node:test";
import { createApp } from "../lib/app.js";
import { closePool, query } from "../lib/db.js";

const databaseUrl =
  process.env.DATABASE_URL || "postgres://demo:demo@127.0.0.1:5432/enrollment_demo";
const internalToken = "integration-token";

let server: Server;
let baseUrl = "";
const createdLeadIds: string[] = [];

before(async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.MATRICULADOR_TOKEN = internalToken;
  process.env.PAYMENT_PROVIDER_MODE = "mock";
  process.env.NODE_ENV = "test";

  const app = createApp();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (createdLeadIds.length > 0) {
    await query("delete from payment_checkouts where lead_id = any($1::uuid[])", [createdLeadIds]);
    await query("delete from lead_enrollments where id = any($1::uuid[])", [createdLeadIds]);
  }

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  await closePool();
});

test("not found responses use the standard error envelope", async () => {
  const response = await fetch(`${baseUrl}/does-not-exist`, {
    headers: {
      Origin: "http://localhost:5500"
    }
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5500");

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "not_found");
  assert.equal(body.error, "not_found");
  assert.equal(typeof body.requestId, "string");
});

test("integration flow covers lead creation, idempotent payment and internal lookup", async () => {
  const leadPayload = {
    course_slug: "enfermagem",
    name: "Ana Integra",
    email: `ana.integration.${Date.now()}@example.com`,
    phone: "31999999999",
    cpf: "52998224725",
    birth_date: "1995-04-20",
    father_name: "Carlos Integra",
    mother_name: "Maria Integra",
    address: {
      cep: "30110000",
      street: "Rua Exemplo",
      number: "100",
      neighborhood: "Centro",
      city: "Belo Horizonte",
      state: "MG"
    },
    course_requirements_ack: {
      minimum_experience_two_years: true,
      coren_active_two_years_auxiliar: true,
      professional_link_proof: true,
      professional_link_proof_type: "ctps"
    }
  };

  const leadResponse = await fetch(`${baseUrl}/api/leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(leadPayload)
  });

  assert.equal(leadResponse.status, 200);
  const leadBody = (await leadResponse.json()) as Record<string, unknown>;
  const leadId = String(leadBody.lead_id || "");
  const leadCode = String(leadBody.lead_code || "");

  assert.match(leadId, /^[0-9a-f-]{36}$/i);
  assert.match(leadCode, /^MAT-[A-Z0-9]{8}$/);
  createdLeadIds.push(leadId);

  const paymentPayload = {
    lead_id: leadId,
    course_slug: "enfermagem",
    installments: 1,
    customer: {
      name: leadPayload.name,
      email: leadPayload.email,
      phone: leadPayload.phone,
      cpf: leadPayload.cpf
    },
    card: {
      holder_name: "ANA INTEGRA",
      number: "5448280000000007",
      exp_month: "12",
      exp_year: "2030",
      cvv: "123"
    },
    source_url: "http://localhost:5500/checkout.html"
  };

  const idempotencyKey = `integration-checkout-${Date.now()}`;
  const firstPayment = await fetch(`${baseUrl}/api/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(paymentPayload)
  });

  assert.equal(firstPayment.status, 200);
  const firstBody = (await firstPayment.json()) as Record<string, unknown>;
  assert.equal(firstBody.status, "approved");
  assert.equal(firstBody.approved, true);
  assert.equal(firstBody.idempotent_reused, false);

  const secondPayment = await fetch(`${baseUrl}/api/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(paymentPayload)
  });

  assert.equal(secondPayment.status, 200);
  const secondBody = (await secondPayment.json()) as Record<string, unknown>;
  assert.equal(secondBody.status, "approved");
  assert.equal(secondBody.idempotent_reused, true);
  assert.equal(secondBody.reference, firstBody.reference);

  const lookupResponse = await fetch(
    `${baseUrl}/api/leads?lead_code=${encodeURIComponent(leadCode)}&limit=5`,
    {
      headers: {
        "x-internal-token": internalToken
      }
    }
  );

  assert.equal(lookupResponse.status, 200);
  const lookupBody = (await lookupResponse.json()) as {
    count: number;
    leads: Array<Record<string, unknown>>;
  };

  assert.equal(lookupBody.count >= 1, true);
  const matchedLead = lookupBody.leads.find((entry) => entry.lead_id === leadId);

  assert.ok(matchedLead);
  assert.equal(matchedLead.payment_status, "approved");
  assert.equal(matchedLead.payment_reference, firstBody.reference);
});
