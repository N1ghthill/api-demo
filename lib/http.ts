import { randomUUID } from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

function getHeader(req: VercelRequest, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return raw[0]?.trim() || "";
  return "";
}

function isHttpsRequest(req: VercelRequest): boolean {
  const proto = getHeader(req, "x-forwarded-proto").toLowerCase();
  if (proto.includes("https")) return true;

  const encryptedSocket = (req.socket as { encrypted?: boolean } | undefined)?.encrypted;
  return Boolean(encryptedSocket);
}

export function getRequestId(req: VercelRequest, res: VercelResponse): string {
  const incoming = getHeader(req, "x-request-id");
  const requestId = incoming || randomUUID();
  res.setHeader("X-Request-Id", requestId);
  return requestId;
}

export function applySecurityHeaders(req: VercelRequest, res: VercelResponse): string {
  const requestId = getRequestId(req, res);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

  if (isHttpsRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  return requestId;
}
