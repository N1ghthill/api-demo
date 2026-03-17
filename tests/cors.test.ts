import assert from "node:assert/strict";
import test from "node:test";
import { cors } from "../lib/cors.js";

type MockResponse = {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  ended: boolean;
  setHeader: (name: string, value: string) => void;
  status: (statusCode: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
  end: () => MockResponse;
};

function createMockResponse(): MockResponse {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    ended: false,
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
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

test("cors blocks localhost origins in production unless explicitly configured", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigins = process.env.FRONTEND_ALLOWED_ORIGINS;
  const originalFrontendBaseUrl = process.env.FRONTEND_BASE_URL;

  try {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_ALLOWED_ORIGINS = "https://app.example.com";
    delete process.env.FRONTEND_BASE_URL;

    const req = {
      headers: {
        origin: "http://localhost:5500"
      },
      method: "GET"
    };
    const res = createMockResponse();

    const handled = cors(req as any, res as any, "req-cors-prod");
    const body = res.body as Record<string, unknown>;

    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    assert.equal(body.code, "forbidden_origin");
    assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalAllowedOrigins === undefined) delete process.env.FRONTEND_ALLOWED_ORIGINS;
    else process.env.FRONTEND_ALLOWED_ORIGINS = originalAllowedOrigins;

    if (originalFrontendBaseUrl === undefined) delete process.env.FRONTEND_BASE_URL;
    else process.env.FRONTEND_BASE_URL = originalFrontendBaseUrl;
  }
});

test("cors still allows localhost origins during local development", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigins = process.env.FRONTEND_ALLOWED_ORIGINS;
  const originalFrontendBaseUrl = process.env.FRONTEND_BASE_URL;

  try {
    process.env.NODE_ENV = "development";
    delete process.env.FRONTEND_ALLOWED_ORIGINS;
    delete process.env.FRONTEND_BASE_URL;

    const req = {
      headers: {
        origin: "http://localhost:5500"
      },
      method: "GET"
    };
    const res = createMockResponse();

    const handled = cors(req as any, res as any, "req-cors-dev");

    assert.equal(handled, false);
    assert.equal(res.headers["Access-Control-Allow-Origin"], "http://localhost:5500");
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalAllowedOrigins === undefined) delete process.env.FRONTEND_ALLOWED_ORIGINS;
    else process.env.FRONTEND_ALLOWED_ORIGINS = originalAllowedOrigins;

    if (originalFrontendBaseUrl === undefined) delete process.env.FRONTEND_BASE_URL;
    else process.env.FRONTEND_BASE_URL = originalFrontendBaseUrl;
  }
});
