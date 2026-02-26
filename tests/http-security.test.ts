import assert from "node:assert/strict";
import test from "node:test";
import { applySecurityHeaders } from "../lib/http.js";

type MockResponse = {
  headers: Record<string, string>;
  setHeader: (name: string, value: string) => void;
};

function createMockResponse(): MockResponse {
  return {
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name] = String(value);
    }
  };
}

test("applySecurityHeaders preserves incoming request id and sets HSTS on https", () => {
  const req = {
    headers: {
      "x-request-id": "req-123",
      "x-forwarded-proto": "https"
    },
    socket: {}
  };

  const res = createMockResponse();
  const requestId = applySecurityHeaders(req as any, res as any);

  assert.equal(requestId, "req-123");
  assert.equal(res.headers["X-Request-Id"], "req-123");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Strict-Transport-Security"], "max-age=31536000; includeSubDomains; preload");
});

test("applySecurityHeaders generates request id and does not set HSTS on http", () => {
  const req = {
    headers: {
      "x-forwarded-proto": "http"
    },
    socket: {}
  };

  const res = createMockResponse();
  const requestId = applySecurityHeaders(req as any, res as any);

  assert.match(requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(res.headers["X-Request-Id"], requestId);
  assert.equal(res.headers["Strict-Transport-Security"], undefined);
});
