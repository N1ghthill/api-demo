import { createHash } from "crypto";
import type { VercelRequest } from "@vercel/node";
import { withApiHandler, type ApiHandlerContext } from "../lib/apiHandler.js";
import { query } from "../lib/db.js";
import { sanitizeError } from "../lib/logger.js";
import {
  buildAutomaticIdempotencyKey,
  getCheckoutResponseHttpStatus,
  normalizeIdempotencyKey
} from "../lib/paymentsIdempotency.js";
import {
  createMockCreditTransaction,
  createRedeCreditTransaction,
  getPaymentProviderMode,
  getRedeConfig,
  type PaymentProviderMode,
  type RedeConfig,
  type RedeTransactionResponse
} from "../lib/rede.js";
import {
  isValidCpf,
  isValidEmail,
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  onlyDigits,
  sanitizeString
} from "../lib/validators.js";

type CourseRow = {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
};

type LeadRow = {
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

type CheckoutStateRow = {
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

type CheckoutInsertInput = {
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

type CheckoutInsertOutcome = {
  checkoutId: string | null;
  reusedCheckout: CheckoutStateRow | null;
  idempotencyPersisted: boolean;
};

let idempotencySchemaState: "unknown" | "ready" | "unavailable" = "unknown";
let idempotencySchemaAttemptPromise: Promise<boolean> | null = null;
let idempotencySchemaLastAttemptAt = 0;

function getHeaderValue(req: VercelRequest, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return raw[0]?.trim() || "";
  return "";
}

function getPgErrorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code || "");
}

function isUuid(value: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function luhnCheck(cardNumber: string): boolean {
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

function normalizeMonth(value: unknown): string | null {
  const digits = onlyDigits(value);
  if (!digits) return null;
  const month = Number(digits);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return String(month).padStart(2, "0");
}

function normalizeYear(value: unknown): string | null {
  const digits = onlyDigits(value);
  if (digits.length === 2) {
    const year = Number(digits);
    return String(year + 2000);
  }

  if (digits.length === 4) return digits;
  return null;
}

function isCardExpired(month: string, year: string): boolean {
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

function parseInstallments(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  const num = Math.trunc(parsed);
  if (num < 1) return 1;
  if (num > 12) return 12;
  return num;
}


function getReturnCode(data: RedeTransactionResponse): string {
  return String(data.returnCode || "").trim();
}

function getReturnMessage(data: RedeTransactionResponse): string {
  return String(data.returnMessage || "").trim();
}

function getThreeDSecureUrl(data: RedeTransactionResponse): string | null {
  return sanitizeString(data?.threeDSecure?.url, 500);
}

function getBrandName(data: RedeTransactionResponse): string | null {
  const brandRaw = data.brand;

  if (typeof brandRaw === "string") return sanitizeString(brandRaw, 80);
  if (brandRaw && typeof brandRaw === "object") {
    return sanitizeString((brandRaw as { name?: unknown }).name, 80);
  }

  return null;
}

function sanitizeProviderResponse(data: RedeTransactionResponse): Record<string, unknown> {
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

function buildLeadCode(leadId: string | null | undefined): string {
  if (!leadId) return "";
  const normalized = String(leadId).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) return "";
  return `MAT-${normalized.slice(0, 8)}`;
}

function buildReferenceFromIdempotencyKey(courseSlug: string, idempotencyKey: string): string {
  const normalizedCourseSlug =
    String(courseSlug || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16) || "course";

  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 14);
  return `chk-${normalizedCourseSlug}-${digest}`;
}

function isProductionRuntime(): boolean {
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  return vercelEnv === "production" || nodeEnv === "production";
}

function buildPaymentResponse(input: {
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

async function loadLeadById(leadId: string): Promise<LeadRow | null> {
  try {
    const { rows } = await query<LeadRow>(
      `select
          id,
          course_id,
          course_slug,
          course_name,
          course_price_cents,
          customer_name,
          customer_email,
          customer_phone,
          cpf,
          nullif(trim(coalesce(address ->> 'city', '')), '') as city,
          nullif(trim(coalesce(address ->> 'state', '')), '') as state,
          payment_status,
          payment_reference,
          payment_tid,
          payment_return_code,
          payment_return_message
        from lead_enrollments
        where id = $1
        limit 1`,
      [leadId]
    );
    return rows?.[0] ?? null;
  } catch (error) {
    if (getPgErrorCode(error) !== "42703") throw error;

    const { rows } = await query<LeadRow>(
      `select
          id,
          course_id,
          course_slug,
          course_name,
          course_price_cents,
          customer_name,
          customer_email,
          customer_phone,
          cpf,
          nullif(trim(coalesce(address ->> 'city', '')), '') as city,
          nullif(trim(coalesce(address ->> 'state', '')), '') as state,
          null::text as payment_status,
          null::text as payment_reference,
          null::text as payment_tid,
          null::text as payment_return_code,
          null::text as payment_return_message
        from lead_enrollments
        where id = $1
        limit 1`,
      [leadId]
    );
    return rows?.[0] ?? null;
  }
}

async function loadCheckoutByIdempotencyKey(
  idempotencyKey: string
): Promise<{ available: boolean; checkout: CheckoutStateRow | null }> {
  try {
    const { rows } = await query<CheckoutStateRow>(
      `select
          id,
          lead_id,
          reference,
          status,
          amount_cents,
          installments,
          provider_tid,
          provider_return_code,
          provider_return_message,
          provider_authorization_code,
          provider_three_d_secure_url
        from payment_checkouts
        where idempotency_key = $1
        order by created_at desc
        limit 1`,
      [idempotencyKey]
    );

    return {
      available: true,
      checkout: rows?.[0] ?? null
    };
  } catch (error) {
    if (getPgErrorCode(error) === "42703") {
      return { available: false, checkout: null };
    }

    throw error;
  }
}

async function loadCheckoutByReference(
  reference: string,
  leadId: string
): Promise<CheckoutStateRow | null> {
  try {
    const { rows } = await query<CheckoutStateRow>(
      `select
          id,
          lead_id,
          reference,
          status,
          amount_cents,
          installments,
          provider_tid,
          provider_return_code,
          provider_return_message,
          provider_authorization_code,
          provider_three_d_secure_url
        from payment_checkouts
        where reference = $1
          and lead_id = $2
        order by created_at desc
        limit 1`,
      [reference, leadId]
    );
    return rows?.[0] ?? null;
  } catch (error) {
    if (getPgErrorCode(error) !== "42703") throw error;

    const { rows } = await query<CheckoutStateRow>(
      `select
          id,
          null::uuid as lead_id,
          reference,
          status,
          amount_cents,
          installments,
          provider_tid,
          provider_return_code,
          provider_return_message,
          provider_authorization_code,
          provider_three_d_secure_url
        from payment_checkouts
        where reference = $1
        order by created_at desc
        limit 1`,
      [reference]
    );
    return rows?.[0] ?? null;
  }
}

async function ensureIdempotencySchemaReady(ctx: ApiHandlerContext): Promise<boolean> {
  if (idempotencySchemaState === "ready") return true;

  const now = Date.now();
  if (
    idempotencySchemaState === "unavailable" &&
    now - idempotencySchemaLastAttemptAt < 300_000
  ) {
    return false;
  }

  if (idempotencySchemaAttemptPromise) {
    return idempotencySchemaAttemptPromise;
  }

  idempotencySchemaAttemptPromise = (async () => {
    idempotencySchemaLastAttemptAt = Date.now();

    try {
      const checkResult = await query<{ exists: boolean }>(
        `select exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'payment_checkouts'
              and column_name = 'idempotency_key'
          ) as exists`
      );

      const columnExists = Boolean(checkResult.rows?.[0]?.exists);
      if (!columnExists) {
        await query(
          `alter table if exists public.payment_checkouts
             add column if not exists idempotency_key text`
        );
      }

      await query(
        `create unique index if not exists payment_checkouts_idempotency_key_uidx
           on public.payment_checkouts (idempotency_key)
           where idempotency_key is not null`
      );

      await query(
        `create index if not exists payment_checkouts_status_idx
           on public.payment_checkouts (status)`
      );

      idempotencySchemaState = "ready";
      return true;
    } catch (error) {
      idempotencySchemaState = "unavailable";
      ctx.log.error({ error: sanitizeError(error) }, "payment_idempotency_schema_ensure_failed");
      return false;
    } finally {
      idempotencySchemaAttemptPromise = null;
    }
  })();

  return idempotencySchemaAttemptPromise;
}

function buildCheckoutInsertSql(
  input: CheckoutInsertInput,
  options: { includeLeadId: boolean; includeIdempotency: boolean }
): { sql: string; params: unknown[] } {
  const columns: string[] = [];
  const params: unknown[] = [];

  if (options.includeLeadId) {
    columns.push("lead_id");
    params.push(input.leadId);
  }

  columns.push(
    "course_id",
    "course_slug",
    "course_name",
    "amount_cents",
    "installments",
    "reference",
    "status",
    "customer_name",
    "customer_email",
    "customer_phone",
    "customer_cpf",
    "card_holder_name",
    "card_last4",
    "card_bin"
  );

  params.push(
    input.course.id,
    input.course.slug,
    input.course.name,
    input.amountCents,
    input.installments,
    input.reference,
    "processing",
    input.customerName,
    input.customerEmail,
    input.customerPhone,
    input.customerCpf,
    input.cardHolderName,
    input.cardLast4,
    input.cardBin
  );

  if (options.includeIdempotency) {
    columns.push("idempotency_key");
    params.push(input.idempotencyKey);
  }

  columns.push("source_url", "provider_response");
  params.push(input.sourceUrl);
  params.push(JSON.stringify({ stage: "initiated", lead_id: input.leadId }));

  const placeholders = columns.map((_, index) => `$${index + 1}`);
  placeholders[placeholders.length - 1] = `${placeholders[placeholders.length - 1]}::jsonb`;

  const sql = `
    insert into payment_checkouts (
      ${columns.join(",\n      ")}
    ) values (
      ${placeholders.join(",")}
    )
    returning id
  `;

  return { sql, params };
}

async function insertProcessingCheckout(
  input: CheckoutInsertInput,
  idempotencyAvailable: boolean
): Promise<CheckoutInsertOutcome> {
  const attempts = [
    { includeLeadId: true, includeIdempotency: idempotencyAvailable },
    { includeLeadId: true, includeIdempotency: false },
    { includeLeadId: false, includeIdempotency: false }
  ].filter((attempt, index, all) => {
    return (
      index ===
      all.findIndex(
        (item) =>
          item.includeLeadId === attempt.includeLeadId &&
          item.includeIdempotency === attempt.includeIdempotency
      )
    );
  });

  for (const attempt of attempts) {
    try {
      const { sql, params } = buildCheckoutInsertSql(input, attempt);
      const { rows } = await query<{ id: string }>(sql, params);

      return {
        checkoutId: rows?.[0]?.id ?? null,
        reusedCheckout: null,
        idempotencyPersisted: attempt.includeIdempotency
      };
    } catch (error) {
      const errorCode = getPgErrorCode(error);

      if (errorCode === "23505" && attempt.includeIdempotency) {
        const lookup = await loadCheckoutByIdempotencyKey(input.idempotencyKey);
        if (lookup.checkout) {
          return {
            checkoutId: lookup.checkout.id,
            reusedCheckout: lookup.checkout,
            idempotencyPersisted: true
          };
        }
      }

      if (errorCode === "42703") {
        continue;
      }

      throw error;
    }
  }

  throw new Error("payment_checkout_schema_incompatible");
}

async function paymentsHandler(ctx: ApiHandlerContext): Promise<void> {
  const { req, res, fail, log, requestId } = ctx;
  const body = (req.body ?? {}) as Record<string, unknown>;

  let providerMode: PaymentProviderMode;
  try {
    providerMode = getPaymentProviderMode();
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "payment_provider_mode_invalid");
    fail(500, "payment_provider_mode_invalid", "Invalid payment provider mode configuration.");
    return;
  }

  const courseSlug = sanitizeString(body.course_slug ?? body.courseSlug ?? body.course, 120);
  if (!courseSlug) {
    fail(400, "invalid_course", "Invalid or missing course.");
    return;
  }

  const leadId = sanitizeString(body.lead_id ?? body.leadId ?? body.lead, 80);
  if (!leadId) {
    fail(400, "missing_lead_id", "Missing lead identifier.");
    return;
  }

  if (!isUuid(leadId)) {
    fail(400, "invalid_lead_id", "Invalid lead identifier.");
    return;
  }

  let lead: LeadRow | null = null;
  try {
    lead = await loadLeadById(leadId);
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "lead_fetch_failed");
    fail(500, "lead_fetch_failed", "Failed to load lead for payment.");
    return;
  }

  if (!lead) {
    fail(400, "invalid_lead", "Lead not found.");
    return;
  }

  if (lead.course_slug !== courseSlug) {
    fail(400, "lead_course_mismatch", "Lead does not match selected course.");
    return;
  }

  if (lead.payment_status === "approved") {
    const paidAmount = Math.max(0, Number(lead.course_price_cents || 0));
    res.status(200).json(
      buildPaymentResponse({
        status: "approved",
        checkoutId: null,
        lead,
        course: { slug: lead.course_slug, name: lead.course_name },
        amountCents: Number.isFinite(paidAmount) ? paidAmount : 0,
        installments: 1,
        reference: lead.payment_reference || null,
        tid: lead.payment_tid || null,
        authorizationCode: null,
        returnCode: lead.payment_return_code || null,
        returnMessage: lead.payment_return_message || null,
        redirectUrl: null,
        customerName: lead.customer_name,
        customerEmail: lead.customer_email,
        customerPhone: lead.customer_phone,
        idempotencyKey: "lead-already-paid",
        idempotentReused: true,
        idempotencyPersisted: true,
        providerMode,
        leadAlreadyPaid: true
      })
    );
    return;
  }

  if (lead.payment_status === "processing" || lead.payment_status === "pending_authentication") {
    res.status(409).json({
      code: "payment_in_progress",
      error: "payment_in_progress",
      message: "A payment is already in progress for this lead.",
      requestId,
      status: lead.payment_status,
      reference: lead.payment_reference || null,
      tid: lead.payment_tid || null
    });
    return;
  }

  const customerName =
    sanitizeString((body.customer as Record<string, unknown> | undefined)?.name ?? body.name, 160) ||
    sanitizeString(lead.customer_name, 160);
  const customerEmail =
    normalizeEmail((body.customer as Record<string, unknown> | undefined)?.email ?? body.email, 180) ||
    normalizeEmail(lead.customer_email, 180);
  const customerPhone =
    normalizePhone((body.customer as Record<string, unknown> | undefined)?.phone ?? body.phone ?? body.telefone) ||
    normalizePhone(lead.customer_phone);
  const customerCpf = normalizeCpf(
    (body.customer as Record<string, unknown> | undefined)?.cpf ?? body.cpf ?? lead.cpf
  );

  if (!customerName) {
    fail(400, "invalid_customer_name", "Invalid customer name.");
    return;
  }

  if (!customerEmail || !isValidEmail(customerEmail)) {
    fail(400, "invalid_customer_email", "Invalid customer email.");
    return;
  }

  if (!customerPhone) {
    fail(400, "invalid_customer_phone", "Invalid customer phone.");
    return;
  }

  if (customerCpf && !isValidCpf(customerCpf)) {
    fail(400, "invalid_customer_cpf", "Invalid customer CPF.");
    return;
  }

  const cardInput = (body.card ?? {}) as Record<string, unknown>;
  const cardHolderName = sanitizeString(
    cardInput.holder_name ?? body.card_holder_name ?? body.cardHolderName,
    160
  );
  const cardNumber = onlyDigits(cardInput.number ?? body.card_number ?? body.cardNumber);
  const securityCode = onlyDigits(cardInput.cvv ?? body.card_cvv ?? body.cardCvv);
  const expirationMonth = normalizeMonth(
    cardInput.exp_month ?? body.card_expiration_month ?? body.expirationMonth
  );
  const expirationYear = normalizeYear(cardInput.exp_year ?? body.card_expiration_year ?? body.expirationYear);
  const installments = parseInstallments(body.installments);

  if (!cardHolderName) {
    fail(400, "invalid_card_holder_name", "Invalid card holder name.");
    return;
  }

  if (cardNumber.length < 13 || cardNumber.length > 19 || !luhnCheck(cardNumber)) {
    fail(400, "invalid_card_number", "Invalid card number.");
    return;
  }

  if (securityCode.length < 3 || securityCode.length > 4) {
    fail(400, "invalid_card_cvv", "Invalid card CVV.");
    return;
  }

  if (!expirationMonth || !expirationYear) {
    fail(400, "invalid_card_expiration", "Invalid card expiration.");
    return;
  }

  if (isCardExpired(expirationMonth, expirationYear)) {
    fail(400, "expired_card", "Card is expired.");
    return;
  }

  let course: CourseRow | null = null;
  try {
    const { rows } = await query<CourseRow>(
      `select id, slug, name, price_cents
         from courses
        where id = $1
          and slug = $2
        limit 1`,
      [lead.course_id, courseSlug]
    );
    course = rows?.[0] ?? null;
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "courses_fetch_failed");
    fail(500, "courses_fetch_failed", "Failed to load course for payment.");
    return;
  }

  if (!course) {
    fail(400, "unknown_course", "Unknown course.");
    return;
  }

  const amountCents = Math.max(0, Number(course.price_cents || 0));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    fail(400, "invalid_course_amount", "Invalid course amount.");
    return;
  }

  const rawIdempotencyKey =
    getHeaderValue(req, "idempotency-key") ||
    sanitizeString(body.idempotency_key ?? body.idempotencyKey, 120) ||
    "";
  const hasExplicitIdempotencyKey = Boolean(rawIdempotencyKey);
  const explicitIdempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);

  if (hasExplicitIdempotencyKey && !explicitIdempotencyKey) {
    fail(400, "invalid_idempotency_key", "Invalid idempotency key.");
    return;
  }

  const idempotencyKey =
    explicitIdempotencyKey ||
    buildAutomaticIdempotencyKey({
      leadId: lead.id,
      courseSlug: course.slug,
      amountCents,
      installments,
      cardBin: cardNumber.slice(0, 6),
      cardLast4: cardNumber.slice(-4),
      expirationMonth,
      expirationYear
    });

  res.setHeader("Idempotency-Key", idempotencyKey);
  const explicitReference = sanitizeString(body.reference, 80);
  const reference = explicitReference || buildReferenceFromIdempotencyKey(course.slug, idempotencyKey);
  const sourceUrl = sanitizeString(body.source_url ?? body.sourceUrl ?? req.headers.referer, 500);

  let idempotencyPersisted = true;
  try {
    let idempotencyLookup = await loadCheckoutByIdempotencyKey(idempotencyKey);
    idempotencyPersisted = idempotencyLookup.available;
    if (idempotencyLookup.available) idempotencySchemaState = "ready";

    let existingCheckout = idempotencyLookup.checkout;

    if (!idempotencyLookup.available) {
      const schemaReady = await ensureIdempotencySchemaReady(ctx);
      if (schemaReady) {
        idempotencyLookup = await loadCheckoutByIdempotencyKey(idempotencyKey);
        idempotencyPersisted = idempotencyLookup.available;
        if (idempotencyLookup.available) idempotencySchemaState = "ready";
        existingCheckout = idempotencyLookup.checkout;
      }
    }

    if (!existingCheckout && !idempotencyPersisted) {
      existingCheckout = await loadCheckoutByReference(reference, lead.id);
    }

    if (existingCheckout) {
      if (existingCheckout.lead_id && existingCheckout.lead_id !== lead.id) {
        fail(409, "idempotency_key_conflict", "Idempotency key is already bound to another lead.");
        return;
      }

      res.status(getCheckoutResponseHttpStatus(existingCheckout.status)).json(
        buildPaymentResponse({
          status: existingCheckout.status,
          checkoutId: existingCheckout.id,
          lead,
          course,
          amountCents: Number(existingCheckout.amount_cents || amountCents),
          installments: Number(existingCheckout.installments || installments),
          reference: existingCheckout.reference || null,
          tid: existingCheckout.provider_tid,
          authorizationCode: existingCheckout.provider_authorization_code,
          returnCode: existingCheckout.provider_return_code,
          returnMessage: existingCheckout.provider_return_message,
          redirectUrl: existingCheckout.provider_three_d_secure_url,
          customerName,
          customerEmail,
          customerPhone,
          idempotencyKey,
          idempotentReused: true,
          idempotencyPersisted,
          providerMode
        })
      );
      return;
    }
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "payment_idempotency_lookup_failed");
    fail(500, "payment_idempotency_lookup_failed", "Failed to perform idempotency lookup.");
    return;
  }

  let redeConfig: RedeConfig | null = null;
  if (providerMode === "rede") {
    try {
      redeConfig = getRedeConfig();
    } catch (error) {
      log.error({ error: sanitizeError(error) }, "payment_provider_not_configured");
      fail(500, "payment_provider_not_configured", "Payment provider is not configured.");
      return;
    }

    if (isProductionRuntime() && redeConfig.environment !== "production") {
      res.status(500).json({
        code: "payment_provider_environment_mismatch",
        error: "payment_provider_environment_mismatch",
        message: "Payment provider environment mismatch.",
        requestId,
        expected_env: "production",
        current_env: redeConfig.environment
      });
      return;
    }
  }

  let checkoutId: string | null = null;
  try {
    const insertOutcome = await insertProcessingCheckout(
      {
        leadId: lead.id,
        course,
        amountCents,
        installments,
        reference,
        customerName,
        customerEmail,
        customerPhone,
        customerCpf: customerCpf || null,
        cardHolderName,
        cardLast4: cardNumber.slice(-4),
        cardBin: cardNumber.slice(0, 6),
        sourceUrl,
        idempotencyKey
      },
      idempotencyPersisted
    );

    idempotencyPersisted = insertOutcome.idempotencyPersisted;

    if (insertOutcome.reusedCheckout) {
      res
        .status(getCheckoutResponseHttpStatus(insertOutcome.reusedCheckout.status))
        .json(
          buildPaymentResponse({
            status: insertOutcome.reusedCheckout.status,
            checkoutId: insertOutcome.reusedCheckout.id,
            lead,
            course,
            amountCents: Number(insertOutcome.reusedCheckout.amount_cents || amountCents),
            installments: Number(insertOutcome.reusedCheckout.installments || installments),
            reference: insertOutcome.reusedCheckout.reference || null,
            tid: insertOutcome.reusedCheckout.provider_tid,
            authorizationCode: insertOutcome.reusedCheckout.provider_authorization_code,
            returnCode: insertOutcome.reusedCheckout.provider_return_code,
            returnMessage: insertOutcome.reusedCheckout.provider_return_message,
            redirectUrl: insertOutcome.reusedCheckout.provider_three_d_secure_url,
            customerName,
            customerEmail,
            customerPhone,
            idempotencyKey,
            idempotentReused: true,
            idempotencyPersisted,
            providerMode
          })
        );
      return;
    }

    checkoutId = insertOutcome.checkoutId;
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "payment_log_unavailable");
    fail(500, "payment_log_unavailable", "Failed to initialize payment checkout log.");
    return;
  }

  let providerResult: Awaited<ReturnType<typeof createRedeCreditTransaction>> | null = null;
  try {
    const providerPayload = {
      amount: amountCents,
      reference,
      installments,
      cardHolderName,
      cardNumber,
      expirationMonth,
      expirationYear,
      securityCode,
      kind: "credit" as const,
      capture: true,
      softDescriptor: redeConfig?.softDescriptor
    };

    providerResult =
      providerMode === "rede"
        ? await createRedeCreditTransaction(redeConfig as RedeConfig, providerPayload)
        : await createMockCreditTransaction(providerPayload);
  } catch (error) {
    const providerFailureMessage = `Provider request failed (${providerMode})`;
    log.error({ error: sanitizeError(error), providerMode }, "payment_provider_unavailable");

    if (checkoutId) {
      try {
        await query(
          `update payment_checkouts
              set status = $2,
                  provider_return_message = $3,
                  provider_response = $4::jsonb
            where id = $1`,
          [
            checkoutId,
            "provider_unavailable",
            providerFailureMessage,
            JSON.stringify({ error: "provider_unavailable" })
          ]
        );
      } catch (updateError) {
        log.error({ error: sanitizeError(updateError) }, "payment_checkout_update_after_provider_failure_failed");
      }
    }

    try {
      await query(
        `update lead_enrollments
            set payment_status = $2,
                payment_reference = $3,
                payment_tid = null,
                payment_return_code = null,
                payment_return_message = $4,
                payment_updated_at = now()
          where id = $1`,
        [lead.id, "provider_unavailable", reference, providerFailureMessage]
      );
    } catch (leadUpdateError) {
      log.error({ error: sanitizeError(leadUpdateError) }, "lead_update_after_provider_failure_failed");
    }

    res.status(502).json({
      code: "payment_provider_unavailable",
      error: "payment_provider_unavailable",
      message: "Payment provider unavailable.",
      requestId,
      idempotency_key: idempotencyKey,
      idempotency_persisted: idempotencyPersisted,
      provider_mode: providerMode
    });
    return;
  }

  const providerData = providerResult.data || {};
  const returnCode = getReturnCode(providerData);
  const returnMessage = getReturnMessage(providerData);
  const tid = sanitizeString(providerData.tid, 120);
  const authorizationCode = sanitizeString(providerData.authorizationCode, 40);
  const threeDSecureUrl = getThreeDSecureUrl(providerData);
  const brandName = getBrandName(providerData);
  const sanitizedProviderData = sanitizeProviderResponse(providerData);

  const approved = returnCode === "00";
  const requiresAction = Boolean(threeDSecureUrl);
  const status = approved ? "approved" : requiresAction ? "pending_authentication" : "declined";

  const authError = returnCode === "25" || returnCode === "26";
  const credentialsError =
    providerMode === "rede" && !providerResult.ok && (authError || providerResult.httpStatus === 401);

  if (checkoutId) {
    try {
      await query(
        `update payment_checkouts
            set status = $2,
                provider_http_status = $3,
                provider_return_code = $4,
                provider_return_message = $5,
                provider_tid = $6,
                provider_authorization_code = $7,
                provider_three_d_secure_url = $8,
                brand_name = $9,
                provider_response = $10::jsonb
          where id = $1`,
        [
          checkoutId,
          status,
          providerResult.httpStatus,
          returnCode || null,
          returnMessage || null,
          tid,
          authorizationCode,
          threeDSecureUrl,
          brandName,
          JSON.stringify(sanitizedProviderData)
        ]
      );
    } catch (error) {
      log.error({ error: sanitizeError(error) }, "payment_checkout_update_failed");
    }
  }

  try {
    await query(
      `update lead_enrollments
          set payment_status = $2,
              payment_reference = $3,
              payment_tid = $4,
              payment_return_code = $5,
              payment_return_message = $6,
              payment_updated_at = now(),
              paid_at = case when $2 = 'approved' then coalesce(paid_at, now()) else paid_at end
        where id = $1`,
      [lead.id, status, reference, tid, returnCode || null, returnMessage || null]
    );
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "lead_payment_status_update_failed");
  }

  if (credentialsError) {
    res.status(500).json({
      code: "payment_provider_credentials_invalid",
      error: "payment_provider_credentials_invalid",
      message: "Invalid payment provider credentials.",
      requestId,
      return_code: returnCode || null,
      idempotency_key: idempotencyKey,
      idempotency_persisted: idempotencyPersisted,
      provider_mode: providerMode
    });
    return;
  }

  res.status(200).json(
    buildPaymentResponse({
      status,
      checkoutId,
      lead,
      course,
      amountCents,
      installments,
      reference,
      tid,
      authorizationCode,
      returnCode: returnCode || null,
      returnMessage: returnMessage || null,
      redirectUrl: requiresAction ? threeDSecureUrl : null,
      customerName,
      customerEmail,
      customerPhone,
      idempotencyKey,
      idempotentReused: false,
      idempotencyPersisted,
      providerMode
    })
  );
}

export default withApiHandler(paymentsHandler, {
  methods: ["POST"],
  cacheControl: "no-store",
  rateLimit: { keyPrefix: "payments", windowMs: 60_000, max: 25 }
});
