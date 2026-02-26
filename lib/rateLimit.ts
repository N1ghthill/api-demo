import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "crypto";

type RateLimitOptions = {
  keyPrefix: string;
  windowMs: number;
  max: number;
};

type Bucket = {
  resetAt: number;
  count: number;
};

const buckets = new Map<string, Bucket>();
let lastCleanupAt = 0;

function nowMs(): number {
  return Date.now();
}

function cleanupExpired(now: number) {
  if (now - lastCleanupAt < 60_000) return;
  lastCleanupAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function getHeader(req: VercelRequest, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join(", ");
  return "";
}

function getClientIp(req: VercelRequest): string {
  const forwarded = getHeader(req, "x-forwarded-for");
  const first = forwarded.split(",")[0]?.trim();
  if (first) return first;
  const realIp = getHeader(req, "x-real-ip").trim();
  if (realIp) return realIp;
  const remote = req.socket?.remoteAddress;
  return remote || "unknown";
}

function stableKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export function rateLimit(req: VercelRequest, res: VercelResponse, opts: RateLimitOptions): boolean {
  const now = nowMs();
  cleanupExpired(now);

  const ip = getClientIp(req);
  const key = `${opts.keyPrefix}:${stableKey(ip)}`;

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { resetAt: now + opts.windowMs, count: 1 });
    return false;
  }

  existing.count += 1;
  buckets.set(key, existing);

  if (existing.count <= opts.max) return false;

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: "rate_limited", retry_after_seconds: retryAfterSeconds });
  return true;
}

