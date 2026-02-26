import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Logger } from "pino";
import { sendApiError } from "./apiErrors.js";
import { cors } from "./cors.js";
import { applySecurityHeaders } from "./http.js";
import { createRequestLogger, sanitizeError, sanitizeMeta } from "./logger.js";
import { rateLimit, type RateLimitOptions } from "./rateLimit.js";

export type ApiHandlerContext = {
  req: VercelRequest;
  res: VercelResponse;
  requestId: string;
  log: Logger;
  fail: (statusCode: number, code: string, message: string, details?: unknown) => VercelResponse;
};

export type ApiHandlerOptions = {
  methods?: string[];
  rateLimit?: RateLimitOptions | ((req: VercelRequest) => RateLimitOptions | null);
  cacheControl?: string;
};

function normalizeMethod(value: string): string {
  return String(value || "").trim().toUpperCase();
}

export function withApiHandler(
  handler: (ctx: ApiHandlerContext) => Promise<void> | void,
  options: ApiHandlerOptions = {}
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  const allowedMethods = Array.isArray(options.methods)
    ? options.methods.map(normalizeMethod).filter(Boolean)
    : null;

  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    const requestId = applySecurityHeaders(req, res);
    const log = createRequestLogger(req, requestId);

    const fail = (statusCode: number, code: string, message: string, details?: unknown): VercelResponse =>
      sendApiError(res, statusCode, { code, message, details, requestId });

    const startedAt = Date.now();
    res.once("finish", () => {
      const meta: Record<string, unknown> = {
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        method: req.method,
        path: req.url
      };
      log.info(sanitizeMeta(meta), "request_completed");
    });

    if (cors(req, res, requestId)) return;

    const method = normalizeMethod(req.method || "");
    if (allowedMethods && !allowedMethods.includes(method)) {
      res.setHeader("Allow", allowedMethods.join(", "));
      fail(405, "method_not_allowed", `Method ${method || "UNKNOWN"} is not allowed.`);
      return;
    }

    if (options.cacheControl) {
      res.setHeader("Cache-Control", options.cacheControl);
    }

    const rateLimitOptions =
      typeof options.rateLimit === "function" ? options.rateLimit(req) : options.rateLimit || null;

    if (rateLimitOptions) {
      const limited = await rateLimit(req, res, rateLimitOptions, requestId);
      if (limited) return;
    }

    try {
      await handler({ req, res, requestId, log, fail });
    } catch (error) {
      log.error({ error: sanitizeError(error) }, "unhandled_handler_error");
      if (!res.headersSent) {
        fail(500, "internal_error", "Unexpected internal error.");
      }
    }
  };
}
