import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutomaticIdempotencyKey,
  getCheckoutResponseHttpStatus,
  normalizeIdempotencyKey
} from "../lib/paymentsIdempotency.js";

test("normalizeIdempotencyKey sanitizes invalid chars and enforces minimum length", () => {
  assert.equal(normalizeIdempotencyKey("abc"), null);
  assert.equal(normalizeIdempotencyKey(" key with spaces ### "), "key-with-spaces-");
  assert.equal(normalizeIdempotencyKey("order:12345678"), "order:12345678");
});

test("buildAutomaticIdempotencyKey is stable for same payload in same time bucket", () => {
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;

  try {
    const payload = {
      leadId: "lead-1",
      courseSlug: "enfermagem",
      amountCents: 159000,
      installments: 1,
      cardBin: "544828",
      cardLast4: "0007",
      expirationMonth: "12",
      expirationYear: "2030"
    };

    const first = buildAutomaticIdempotencyKey(payload);
    const second = buildAutomaticIdempotencyKey(payload);

    assert.equal(first, second);
    assert.match(first, /^auto-[0-9a-f]{48}$/);
  } finally {
    Date.now = originalNow;
  }
});

test("getCheckoutResponseHttpStatus maps operational statuses", () => {
  assert.equal(getCheckoutResponseHttpStatus("processing"), 202);
  assert.equal(getCheckoutResponseHttpStatus("provider_unavailable"), 502);
  assert.equal(getCheckoutResponseHttpStatus("approved"), 200);
});
