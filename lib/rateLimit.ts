import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "crypto";
import { createClient } from "redis";
import { sendApiError } from "./apiErrors.js";
import { logger, sanitizeError } from "./logger.js";

export type RateLimitOptions = {
  keyPrefix: string;
  windowMs: number;
  max: number;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

type RateLimitStore = {
  increment: (key: string, windowMs: number, now: number) => Promise<RateLimitState>;
};

type Bucket = {
  resetAt: number;
  count: number;
};

class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private lastCleanupAt = 0;

  private cleanupExpired(now: number): void {
    if (now - this.lastCleanupAt < 60_000) return;
    this.lastCleanupAt = now;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  async increment(key: string, windowMs: number, now: number): Promise<RateLimitState> {
    this.cleanupExpired(now);

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const state: RateLimitState = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, { count: state.count, resetAt: state.resetAt });
      return state;
    }

    existing.count += 1;
    this.buckets.set(key, existing);
    return { count: existing.count, resetAt: existing.resetAt };
  }
}

class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly client: ReturnType<typeof createClient>) {}

  async increment(key: string, windowMs: number, now: number): Promise<RateLimitState> {
    const countRaw = await this.client.incr(key);
    const count = Number(countRaw);

    if (count === 1) {
      await this.client.pExpire(key, windowMs);
    }

    let ttlMs = Number(await this.client.pTTL(key));
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      await this.client.pExpire(key, windowMs);
      ttlMs = windowMs;
    }

    return {
      count,
      resetAt: now + ttlMs
    };
  }
}

const memoryStore = new MemoryRateLimitStore();
let redisStorePromise: Promise<RateLimitStore | null> | null = null;
let warnedRedisFailure = false;

function nowMs(): number {
  return Date.now();
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

  return req.socket?.remoteAddress || "unknown";
}

function stableKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

async function createRedisStore(): Promise<RateLimitStore | null> {
  const redisUrl = String(process.env.REDIS_URL || "").trim();
  if (!redisUrl) return null;

  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 1_500,
      reconnectStrategy: false
    }
  });

  client.on("error", (error) => {
    if (warnedRedisFailure) return;
    warnedRedisFailure = true;
    logger.warn({ error: sanitizeError(error) }, "Redis rate-limit client emitted error");
  });

  try {
    await client.connect();
    logger.info("Redis-backed rate limit enabled");
    return new RedisRateLimitStore(client);
  } catch (error) {
    if (!warnedRedisFailure) {
      warnedRedisFailure = true;
      logger.warn(
        { error: sanitizeError(error) },
        "Failed to connect Redis for rate limit. Falling back to memory store."
      );
    }

    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }

    return null;
  }
}

async function getRateLimitStore(): Promise<RateLimitStore> {
  if (!redisStorePromise) {
    redisStorePromise = createRedisStore();
  }

  const redisStore = await redisStorePromise;
  return redisStore || memoryStore;
}

export async function rateLimit(
  req: VercelRequest,
  res: VercelResponse,
  opts: RateLimitOptions,
  requestId = "unknown"
): Promise<boolean> {
  const now = nowMs();
  const ip = getClientIp(req);
  const key = `${opts.keyPrefix}:${stableKey(ip)}`;

  let state: RateLimitState;
  try {
    const store = await getRateLimitStore();
    state = await store.increment(key, opts.windowMs, now);
  } catch (error) {
    logger.warn(
      {
        requestId,
        error: sanitizeError(error)
      },
      "Rate-limit store failed. Retrying with in-memory store."
    );
    state = await memoryStore.increment(key, opts.windowMs, now);
  }

  const remaining = Math.max(0, opts.max - state.count);
  const resetAtSeconds = Math.ceil(state.resetAt / 1000);

  res.setHeader("X-RateLimit-Limit", String(opts.max));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(resetAtSeconds));

  if (state.count <= opts.max) return false;

  const retryAfterSeconds = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  sendApiError(res, 429, {
    code: "rate_limited",
    message: "Too many requests. Please retry later.",
    details: { retryAfterSeconds },
    requestId
  });
  return true;
}
