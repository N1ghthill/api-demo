import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sendApiError } from "./apiErrors.js";

const DEFAULT_FRONTEND_BASE_URL =
  "http://localhost:5500,http://127.0.0.1:5500";

function isProduction(): boolean {
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  return vercelEnv === "production" || nodeEnv === "production";
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

function parseOriginList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
}

function getAllowedOrigins(): string[] {
  const configured = process.env.FRONTEND_ALLOWED_ORIGINS
    ? parseOriginList(process.env.FRONTEND_ALLOWED_ORIGINS)
    : process.env.FRONTEND_BASE_URL
      ? parseOriginList(process.env.FRONTEND_BASE_URL)
      : [];

  const defaults = parseOriginList(DEFAULT_FRONTEND_BASE_URL);

  const extras = isProduction()
    ? []
    : [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:8080",
        "http://localhost:5500",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:5500"
      ].map(normalizeOrigin);

  return Array.from(new Set([...configured, ...defaults, ...extras]));
}

export function cors(req: VercelRequest, res: VercelResponse, requestId = "unknown"): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const allowedOrigins = getAllowedOrigins();
  const normalizedOrigin = origin ? normalizeOrigin(origin) : "";
  res.setHeader("Vary", "Origin");

  if (origin && allowedOrigins.length && !allowedOrigins.includes(normalizedOrigin)) {
    sendApiError(res, 403, {
      code: "forbidden_origin",
      message: "Origin is not allowed by CORS policy.",
      requestId
    });
    return true;
  }

  if (origin && allowedOrigins.length && allowedOrigins.includes(normalizedOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Matriculator-Token, X-Internal-Token, Idempotency-Key"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  return false;
}
