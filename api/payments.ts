import type { VercelRequest } from "@vercel/node";
import { withApiHandler, type ApiHandlerContext } from "../lib/apiHandler.js";
import { query } from "../lib/db.js";
import { sanitizeError } from "../lib/logger.js";
import {
  buildPaymentResponse,
  buildReferenceFromIdempotencyKey,
  getBrandName,
  getReturnCode,
  getReturnMessage,
  getThreeDSecureUrl,
  isCardExpired,
  isProductionRuntime,
  isUuid,
  luhnCheck,
  normalizeMonth,
  normalizeYear,
  parseInstallments,
  sanitizeProviderResponse,
  type CourseRow
} from "../lib/paymentsDomain.js";
import {
  ensureIdempotencySchemaReady,
  insertProcessingCheckout,
  loadCheckoutByIdempotencyKey,
  loadCheckoutByReference,
  loadLeadById,
  markProviderUnavailable
} from "../lib/paymentsStore.js";
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
  type RedeConfig
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

function getHeaderValue(req: VercelRequest, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return raw[0]?.trim() || "";
  return "";
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

  const leadLookup = await (async () => {
    try {
      return { failed: false as const, lead: await loadLeadById(leadId) };
    } catch (error) {
      log.error({ error: sanitizeError(error) }, "lead_fetch_failed");
      fail(500, "lead_fetch_failed", "Failed to load lead for payment.");
      return { failed: true as const, lead: null };
    }
  })();

  if (leadLookup.failed) return;

  const lead = leadLookup.lead;
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

  const courseLookup = await (async () => {
    try {
      const { rows } = await query<CourseRow>(
        `select id, slug, name, price_cents
           from courses
          where id = $1
            and slug = $2
          limit 1`,
        [lead.course_id, courseSlug]
      );
      return { failed: false as const, course: rows?.[0] ?? null };
    } catch (error) {
      log.error({ error: sanitizeError(error) }, "courses_fetch_failed");
      fail(500, "courses_fetch_failed", "Failed to load course for payment.");
      return { failed: true as const, course: null };
    }
  })();

  if (courseLookup.failed) return;

  const course = courseLookup.course;
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

  let idempotencyPersisted: boolean;
  try {
    let idempotencyLookup = await loadCheckoutByIdempotencyKey(idempotencyKey);
    idempotencyPersisted = idempotencyLookup.available;

    let existingCheckout = idempotencyLookup.checkout;

    if (!idempotencyLookup.available) {
      const schemaReady = await ensureIdempotencySchemaReady(log);
      if (schemaReady) {
        idempotencyLookup = await loadCheckoutByIdempotencyKey(idempotencyKey);
        idempotencyPersisted = idempotencyLookup.available;
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

  let checkoutId: string | null;
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

  let providerResult: Awaited<ReturnType<typeof createRedeCreditTransaction>>;
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

    await markProviderUnavailable({
      leadId: lead.id,
      checkoutId,
      reference,
      message: providerFailureMessage,
      providerResponse: { error: "provider_unavailable" },
      log
    });

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
  const authError = returnCode === "25" || returnCode === "26";
  const credentialsError =
    providerMode === "rede" && !providerResult.ok && (authError || providerResult.httpStatus === 401);
  const providerHttpFailure = providerMode === "rede" && !providerResult.ok && !credentialsError;

  if (credentialsError) {
    const providerFailureMessage = returnMessage || "Invalid payment provider credentials.";

    await markProviderUnavailable({
      leadId: lead.id,
      checkoutId,
      reference,
      providerHttpStatus: providerResult.httpStatus,
      returnCode: returnCode || null,
      message: providerFailureMessage,
      providerResponse: sanitizedProviderData,
      log
    });

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

  if (providerHttpFailure) {
    const providerFailureMessage = returnMessage || `Provider request failed (${providerMode})`;

    await markProviderUnavailable({
      leadId: lead.id,
      checkoutId,
      reference,
      providerHttpStatus: providerResult.httpStatus,
      returnCode: returnCode || null,
      message: providerFailureMessage,
      providerResponse: sanitizedProviderData,
      log
    });

    res.status(502).json({
      code: "payment_provider_unavailable",
      error: "payment_provider_unavailable",
      message: "Payment provider unavailable.",
      requestId,
      return_code: returnCode || null,
      idempotency_key: idempotencyKey,
      idempotency_persisted: idempotencyPersisted,
      provider_mode: providerMode
    });
    return;
  }

  const approved = returnCode === "00";
  const requiresAction = Boolean(threeDSecureUrl);
  const status = approved ? "approved" : requiresAction ? "pending_authentication" : "declined";

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
