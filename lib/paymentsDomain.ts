import { createHash } from "crypto";
import type { PaymentProviderMode, RedeTransactionResponse } from "./rede.js";
import { sanitizeString } from "./validators.js";

export type CourseRow = {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
};

export type LeadRow = {
  id: string;
  course_id: string;
  course_slug: string;
  course_name: string;
  course_price_cents: number;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  cpf: string | null;
  city: string | null;
  state: string | null;
  payment_status: string | null;
  payment_reference: string | null;
  payment_tid: string | null;
  payment_return_code: string | null;
  payment_return_message: string | null;
};

export type CheckoutStateRow = {
  id: string;
  lead_id: string | null;
  reference: string;
  status: string;
  amount_cents: number;
  installments: number;
  provider_tid: string | null;
  provider_return_code: string | null;
  provider_return_message: string | null;
  provider_authorization_code: string | null;
  provider_three_d_secure_url: string | null;
};

export type CheckoutInsertInput = {
  leadId: string;
  course: CourseRow;
  amountCents: number;
  installments: number;
  reference: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerCpf: string | null;
  cardHolderName: string;
  cardLast4: string;
  cardBin: string;
  sourceUrl: string | null;
  idempotencyKey: string;
};

export type CheckoutInsertOutcome = {
  checkoutId: string | null;
  reusedCheckout: CheckoutStateRow | null;
  idempotencyPersisted: boolean;
};

export function getPgErrorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code || "");
}

export function isUuid(value: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function luhnCheck(cardNumber: string): boolean {
  let sum = 0;
  let shouldDouble = false;

  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = Number(cardNumber[i]);
    if (Number.isNaN(digit)) return false;

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

export function normalizeMonth(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  const month = Number(digits);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return String(month).padStart(2, "0");
}

export function normalizeYear(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (digits.length === 2) {
    const year = Number(digits);
    return String(year + 2000);
  }

  if (digits.length === 4) return digits;
  return null;
}

export function isCardExpired(month: string, year: string): boolean {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || !Number.isInteger(y)) return true;

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  if (y < currentYear) return true;
  if (y === currentYear && m < currentMonth) return true;
  return false;
}

export function parseInstallments(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  const num = Math.trunc(parsed);
  if (num < 1) return 1;
  if (num > 12) return 12;
  return num;
}

export function getReturnCode(data: RedeTransactionResponse): string {
  return String(data.returnCode || "").trim();
}

export function getReturnMessage(data: RedeTransactionResponse): string {
  return String(data.returnMessage || "").trim();
}

export function getThreeDSecureUrl(data: RedeTransactionResponse): string | null {
  return sanitizeString(data?.threeDSecure?.url, 500);
}

export function getBrandName(data: RedeTransactionResponse): string | null {
  const brandRaw = data.brand;

  if (typeof brandRaw === "string") return sanitizeString(brandRaw, 80);
  if (brandRaw && typeof brandRaw === "object") {
    return sanitizeString((brandRaw as { name?: unknown }).name, 80);
  }

  return null;
}

export function sanitizeProviderResponse(data: RedeTransactionResponse): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  const tid = sanitizeString(data.tid, 120);
  if (tid) sanitized.tid = tid;

  const reference = sanitizeString(data.reference, 120);
  if (reference) sanitized.reference = reference;

  const returnCode = sanitizeString(data.returnCode, 20);
  if (returnCode) sanitized.returnCode = returnCode;

  const returnMessage = sanitizeString(data.returnMessage, 160);
  if (returnMessage) sanitized.returnMessage = returnMessage;

  const authorizationCode = sanitizeString(data.authorizationCode, 40);
  if (authorizationCode) sanitized.authorizationCode = authorizationCode;

  const brand = getBrandName(data);
  if (brand) sanitized.brand = brand;

  const threeDSecureUrl = getThreeDSecureUrl(data);
  if (threeDSecureUrl) {
    sanitized.threeDSecure = { url: threeDSecureUrl };
  }

  if (typeof data.mock === "boolean") sanitized.mock = data.mock;
  if (typeof data.mockMaskedCard === "string") sanitized.mockMaskedCard = data.mockMaskedCard;

  return sanitized;
}

export function buildLeadCode(leadId: string | null | undefined): string {
  if (!leadId) return "";
  const normalized = String(leadId).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) return "";
  return `MAT-${normalized.slice(0, 8)}`;
}

export function buildReferenceFromIdempotencyKey(courseSlug: string, idempotencyKey: string): string {
  const normalizedCourseSlug =
    String(courseSlug || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16) || "course";

  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 14);
  return `chk-${normalizedCourseSlug}-${digest}`;
}

export function isProductionRuntime(): boolean {
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  return vercelEnv === "production" || nodeEnv === "production";
}

export function buildPaymentResponse(input: {
  status: string;
  checkoutId: string | null;
  lead: LeadRow;
  course: { slug: string; name: string };
  amountCents: number;
  installments: number;
  reference: string | null;
  tid: string | null;
  authorizationCode: string | null;
  returnCode: string | null;
  returnMessage: string | null;
  redirectUrl: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  idempotencyKey: string;
  idempotentReused: boolean;
  idempotencyPersisted: boolean;
  providerMode: PaymentProviderMode;
  leadAlreadyPaid?: boolean;
}) {
  const approved = input.status === "approved";
  const requiresAction = input.status === "pending_authentication";

  return {
    ok: approved,
    approved,
    status: input.status,
    checkout_id: input.checkoutId,
    lead_id: input.lead.id,
    lead_code: buildLeadCode(input.lead.id),
    lead_already_paid: Boolean(input.leadAlreadyPaid),
    reference: input.reference,
    tid: input.tid,
    authorization_code: input.authorizationCode,
    return_code: input.returnCode,
    return_message: input.returnMessage,
    amount_cents: input.amountCents,
    installments: input.installments,
    requires_action: requiresAction,
    redirect_url: input.redirectUrl,
    idempotency_key: input.idempotencyKey,
    idempotent_reused: input.idempotentReused,
    idempotency_persisted: input.idempotencyPersisted,
    provider_mode: input.providerMode,
    customer: {
      name: input.customerName,
      email: input.customerEmail,
      phone: input.customerPhone
    },
    lead: {
      id: input.lead.id,
      code: buildLeadCode(input.lead.id),
      city: input.lead.city || null,
      state: input.lead.state || null
    },
    course: {
      slug: input.course.slug,
      name: input.course.name,
      price_cents: input.amountCents
    }
  };
}
