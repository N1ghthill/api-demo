import assert from "node:assert/strict";
import test from "node:test";
import { rateLimit } from "../lib/rateLimit.js";

type MockResponse = {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  setHeader: (name: string, value: string) => void;
  status: (statusCode: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function createMockResponse(): MockResponse {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name: string, value: string) {
      this.headers[name] = String(value);
    },
    status(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

test("rateLimit allows within threshold and blocks above limit", async () => {
  const req = {
    headers: {
      "x-forwarded-for": "203.0.113.10"
    },
    socket: {}
  };

  const first = createMockResponse();
  const second = createMockResponse();

  const allowed = await rateLimit(req as any, first as any, {
    keyPrefix: "test-rate-limit",
    windowMs: 30_000,
    max: 1
  }, "req-test-1");

  const blocked = await rateLimit(req as any, second as any, {
    keyPrefix: "test-rate-limit",
    windowMs: 30_000,
    max: 1
  }, "req-test-2");

  assert.equal(allowed, false);
  assert.equal(blocked, true);
  assert.equal(second.statusCode, 429);
  assert.equal(typeof second.headers["Retry-After"], "string");

  const errorBody = second.body as Record<string, unknown>;
  assert.equal(errorBody.code, "rate_limited");
  assert.equal(errorBody.requestId, "req-test-2");
});
