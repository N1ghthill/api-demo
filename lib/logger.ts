import type { VercelRequest } from "@vercel/node";
import pino, { type Logger } from "pino";

const SENSITIVE_KEYS = [
  "authorization",
  "token",
  "password",
  "secret",
  "cvv",
  "securityCode",
  "cardNumber",
  "x-matriculator-token",
  "x-internal-token"
];

const REDACTION_PATHS = [
  "authorization",
  "headers.authorization",
  "headers.x-matriculator-token",
  "headers.x-internal-token",
  "token",
  "password",
  "secret",
  "securityCode",
  "cvv",
  "cardNumber",
  "card.number",
  "card.cvv",
  "customer.cardNumber",
  "customer.cvv"
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEYS.some((entry) => normalized.includes(entry.toLowerCase()));
}

function sanitizeObject(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
      continue;
    }

    out[key] = sanitizeObject(item, depth + 1);
  }

  return out;
}

export function sanitizeError(error: unknown): Record<string, unknown> {
  const input = error as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };
  const result: Record<string, unknown> = {
    name: String(input?.name || "Error"),
    message: String(input?.message || "Unknown error")
  };

  if (input?.code !== undefined) result.code = String(input.code);

  if (process.env.NODE_ENV !== "production" && input?.stack) {
    result.stack = String(input.stack);
  }

  return sanitizeObject(result) as Record<string, unknown>;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: REDACTION_PATHS,
    censor: "[redacted]"
  }
});

export function createRequestLogger(req: VercelRequest, requestId: string): Logger {
  return logger.child({
    requestId,
    method: String(req.method || ""),
    path: String(req.url || "")
  });
}

export function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(meta) as Record<string, unknown>;
}
