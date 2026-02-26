import { randomBytes } from "crypto";
import { env } from "./env.js";

const REDE_PRODUCTION_URL = "https://api.userede.com.br/erede/v1/transactions";
const REDE_SANDBOX_URL = "https://api.userede.com.br/desenvolvedores/v1/transactions";

export type RedeEnvironmentName = "production" | "sandbox";
export type PaymentProviderMode = "mock" | "rede";

export type RedeConfig = {
  pv: string;
  token: string;
  environment: RedeEnvironmentName;
  endpoint: string;
  timeoutMs: number;
  softDescriptor?: string;
};

export type RedeCreditTransactionRequest = {
  amount: number;
  reference: string;
  installments: number;
  cardHolderName: string;
  cardNumber: string;
  expirationMonth: string;
  expirationYear: string;
  securityCode: string;
  kind: "credit";
  capture: boolean;
  softDescriptor?: string;
};

export type RedeTransactionResponse = {
  tid?: string;
  reference?: string;
  returnCode?: string;
  returnMessage?: string;
  authorizationCode?: string;
  brand?: {
    name?: string;
  } | string;
  threeDSecure?: {
    url?: string;
  };
  [key: string]: unknown;
};

export type RedeProviderResult = {
  ok: boolean;
  httpStatus: number;
  data: RedeTransactionResponse;
};

function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D+/g, "");
}

function maskCard(value: string): string {
  const digits = onlyDigits(value);
  if (!digits) return "";
  const head = digits.slice(0, 6);
  const tail = digits.slice(-4);
  return `${head}******${tail}`;
}

function inferBrand(cardNumber: string): string {
  const digits = onlyDigits(cardNumber);
  if (/^4/.test(digits)) return "Visa";
  if (/^5[1-5]/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "Amex";
  if (/^6/.test(digits)) return "Discover";
  return "Unknown";
}

export function normalizeEnvValue(raw: unknown): string {
  const base = String(raw ?? "").trim();
  const withoutEscapedNewline = base.replace(/\\n/g, "").replace(/\\r/g, "");
  const unquoted = withoutEscapedNewline.replace(/^['"]|['"]$/g, "");
  return unquoted.trim();
}

export function normalizeEnvironment(raw: string): RedeEnvironmentName {
  const value = normalizeEnvValue(raw).toLowerCase();

  if (value === "production" || value === "prod") return "production";
  if (value === "sandbox" || value === "sdb" || value === "hml") return "sandbox";

  throw new Error("Invalid REDE_ENV. Use 'sandbox' or 'production'.");
}

export function normalizePaymentProviderMode(raw: string): PaymentProviderMode {
  const value = normalizeEnvValue(raw).toLowerCase();

  if (value === "" || value === "mock") return "mock";
  if (value === "rede" || value === "real") return "rede";

  throw new Error("Invalid PAYMENT_PROVIDER_MODE. Use 'mock' or 'rede'.");
}

export function getPaymentProviderMode(): PaymentProviderMode {
  return normalizePaymentProviderMode(env("PAYMENT_PROVIDER_MODE", "mock"));
}

function parseTimeoutMs(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return 15_000;
  if (parsed > 60_000) return 60_000;
  return Math.trunc(parsed);
}

function sanitizeSoftDescriptor(value: string | undefined): string | undefined {
  const normalized = String(value || "").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 22);
}

export function getRedeConfig(): RedeConfig {
  const pv = onlyDigits(normalizeEnvValue(env("REDE_PV")));
  const token = normalizeEnvValue(env("REDE_TOKEN"));

  if (!pv) throw new Error("Missing or invalid REDE_PV.");
  if (!token) throw new Error("Missing REDE_TOKEN.");

  const environment = normalizeEnvironment(env("REDE_ENV", "sandbox"));
  const endpoint = environment === "production" ? REDE_PRODUCTION_URL : REDE_SANDBOX_URL;
  const timeoutMs = parseTimeoutMs(normalizeEnvValue(env("REDE_TIMEOUT_MS", "15000")));
  const softDescriptor = sanitizeSoftDescriptor(normalizeEnvValue(process.env.REDE_SOFT_DESCRIPTOR));

  return { pv, token, environment, endpoint, timeoutMs, softDescriptor };
}

function safeJsonParse(raw: string): RedeTransactionResponse {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as RedeTransactionResponse) : {};
  } catch {
    return {};
  }
}

export function buildCheckoutReference(courseSlug: string): string {
  const slug =
    String(courseSlug || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 18) || "course";

  const now = Date.now().toString(36);
  const rand = randomBytes(3).toString("hex");
  return `chk-${slug}-${now}-${rand}`;
}

export async function createRedeCreditTransaction(
  config: RedeConfig,
  payload: RedeCreditTransactionRequest
): Promise<RedeProviderResult> {
  const authorization = Buffer.from(`${config.pv}:${config.token}`).toString("base64");

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/json; charset=utf-8",
      "Transaction-Response": "brand-return-opened"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  const raw = await response.text();
  const data = safeJsonParse(raw);

  return {
    ok: response.ok,
    httpStatus: response.status,
    data
  };
}

export async function createMockCreditTransaction(
  payload: RedeCreditTransactionRequest
): Promise<RedeProviderResult> {
  const digits = onlyDigits(payload.cardNumber);
  const suffix = digits.slice(-4);
  const tid = `MOCK${Date.now().toString(36).toUpperCase()}${randomBytes(2)
    .toString("hex")
    .toUpperCase()}`;
  const brand = inferBrand(digits);

  if (!digits || digits.length < 13) {
    return {
      ok: false,
      httpStatus: 422,
      data: {
        tid,
        reference: payload.reference,
        returnCode: "14",
        returnMessage: "Invalid card number",
        brand,
        mock: true,
        mockMaskedCard: maskCard(payload.cardNumber)
      }
    };
  }

  if (suffix === "0000") {
    return {
      ok: true,
      httpStatus: 200,
      data: {
        tid,
        reference: payload.reference,
        returnCode: "05",
        returnMessage: "Transaction denied (mock)",
        authorizationCode: "",
        brand,
        mock: true,
        mockMaskedCard: maskCard(payload.cardNumber)
      }
    };
  }

  if (suffix === "1111") {
    return {
      ok: true,
      httpStatus: 200,
      data: {
        tid,
        reference: payload.reference,
        returnCode: "220",
        returnMessage: "Authentication required (mock)",
        authorizationCode: "",
        brand,
        threeDSecure: {
          url: `https://mock-gateway.local/3ds/${payload.reference}`
        },
        mock: true,
        mockMaskedCard: maskCard(payload.cardNumber)
      }
    };
  }

  return {
    ok: true,
    httpStatus: 200,
    data: {
      tid,
      reference: payload.reference,
      returnCode: "00",
      returnMessage: "Approved (mock)",
      authorizationCode: randomBytes(3).toString("hex").toUpperCase(),
      brand,
      mock: true,
      mockMaskedCard: maskCard(payload.cardNumber)
    }
  };
}
