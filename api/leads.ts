import { withApiHandler, type ApiHandlerContext } from "../lib/apiHandler.js";
import { query } from "../lib/db.js";
import {
  buildLeadCode,
  getAddress,
  getCourseSlug,
  hasRequiredAddressFields,
  isAuthorizedInternalToken,
  isValidSha256Hex,
  isValidBirthDate,
  normalizeCourseRequirementsAck,
  normalizeExperienceCredit,
  normalizeLeadCodePrefix,
  normalizePaymentStatus,
  parseLimit,
  type LeadLookupRow,
  validateCourseRequirements
} from "../lib/leadsDomain.js";
import { sanitizeError } from "../lib/logger.js";
import {
  isValidCpf,
  isValidEmail,
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  sanitizeString
} from "../lib/validators.js";

async function handleLeadLookup(ctx: ApiHandlerContext): Promise<void> {
  const { req, res, fail, log } = ctx;

  const hasPlainToken = Boolean(String(process.env.MATRICULADOR_TOKEN || "").trim());
  const configuredTokenHash = String(process.env.MATRICULADOR_TOKEN_SHA256 || "")
    .trim()
    .toLowerCase();
  const hasHashedToken = Boolean(configuredTokenHash);

  if (!hasPlainToken && !hasHashedToken) {
    fail(500, "matriculator_token_not_configured", "Internal lookup token is not configured.");
    return;
  }

  if (hasHashedToken && !isValidSha256Hex(configuredTokenHash)) {
    fail(500, "matriculator_token_hash_invalid", "Configured internal token hash is invalid.");
    return;
  }

  if (!isAuthorizedInternalToken(null, req)) {
    fail(401, "unauthorized", "Unauthorized internal lookup.");
    return;
  }

  const leadCodePrefix = normalizeLeadCodePrefix(req.query?.lead_code);
  const paymentStatus = normalizePaymentStatus(req.query?.payment_status);
  const limit = parseLimit(req.query?.limit);

  if (!leadCodePrefix && !paymentStatus) {
    fail(400, "missing_filter", "Use lead_code or payment_status.", {
      requiredFilters: ["lead_code", "payment_status"]
    });
    return;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (leadCodePrefix) {
    params.push(leadCodePrefix);
    conditions.push(`upper(replace(id::text, '-', '')) like $${params.length} || '%'`);
  }

  if (paymentStatus) {
    params.push(paymentStatus);
    conditions.push(`payment_status = $${params.length}`);
  }

  params.push(limit);
  const whereSql = conditions.length ? `where ${conditions.join(" and ")}` : "";

  try {
    let rows: LeadLookupRow[] = [];

    try {
      const fullResult = await query<LeadLookupRow>(
        `select
            id,
            course_slug,
            course_name,
            customer_name,
            customer_email,
            customer_phone,
            cpf,
            birth_date::text as birth_date,
            father_name,
            mother_name,
            address,
            payment_status,
            payment_reference,
            payment_tid,
            payment_return_code,
            payment_return_message,
            created_at::text as created_at,
            payment_updated_at::text as payment_updated_at,
            paid_at::text as paid_at
          from lead_enrollments
          ${whereSql}
          order by created_at desc
          limit $${params.length}`,
        params
      );
      rows = fullResult.rows;
    } catch (queryError) {
      const errorCode = String((queryError as { code?: unknown })?.code || "");
      if (errorCode !== "42703") throw queryError;

      if (paymentStatus) {
        fail(500, "payment_status_filter_unavailable", "Payment status filter unavailable before migration.", {
          migration: "db/init/050_lead_payment_link.sql"
        });
        return;
      }

      const legacyResult = await query<LeadLookupRow>(
        `select
            id,
            course_slug,
            course_name,
            customer_name,
            customer_email,
            customer_phone,
            cpf,
            birth_date::text as birth_date,
            father_name,
            mother_name,
            address,
            null::text as payment_status,
            null::text as payment_reference,
            null::text as payment_tid,
            null::text as payment_return_code,
            null::text as payment_return_message,
            created_at::text as created_at,
            null::text as payment_updated_at,
            null::text as paid_at
          from lead_enrollments
          ${whereSql}
          order by created_at desc
          limit $${params.length}`,
        params
      );
      rows = legacyResult.rows;
    }

    res.status(200).json({
      ok: true,
      count: rows.length,
      leads: rows.map((lead) => ({
        lead_id: lead.id,
        lead_code: buildLeadCode(lead.id),
        course_slug: lead.course_slug,
        course_name: lead.course_name,
        customer_name: lead.customer_name,
        customer_email: lead.customer_email,
        customer_phone: lead.customer_phone,
        cpf: lead.cpf,
        birth_date: lead.birth_date,
        father_name: lead.father_name,
        mother_name: lead.mother_name,
        address: lead.address || {},
        payment_status: lead.payment_status || "pending",
        payment_reference: lead.payment_reference,
        payment_tid: lead.payment_tid,
        payment_return_code: lead.payment_return_code,
        payment_return_message: lead.payment_return_message,
        created_at: lead.created_at,
        payment_updated_at: lead.payment_updated_at,
        paid_at: lead.paid_at
      }))
    });
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "lead_lookup_failed");
    fail(500, "lead_lookup_failed", "Failed to fetch leads.");
  }
}

async function leadsHandler(ctx: ApiHandlerContext): Promise<void> {
  const { req, res, fail, log } = ctx;

  if (req.method === "GET") {
    await handleLeadLookup(ctx);
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const courseSlug = getCourseSlug(body);
  if (!courseSlug) {
    fail(400, "invalid_course", "Invalid or missing course slug.");
    return;
  }

  const name = sanitizeString(body.name ?? body.nome, 160);
  const email = normalizeEmail(body.email, 180);
  const phone = normalizePhone(body.phone ?? body.telefone);
  const fatherName = sanitizeString(body.father_name ?? body.nome_pai ?? body.nomePai, 160);
  const motherName = sanitizeString(body.mother_name ?? body.nome_mae ?? body.nomeMae, 160);
  const cpf = normalizeCpf(body.cpf);
  const birthDate = sanitizeString(body.birth_date ?? body.nascimento, 10);

  if (!name) {
    fail(400, "invalid_name", "Invalid or missing name.");
    return;
  }

  if (!email || !isValidEmail(email)) {
    fail(400, "invalid_email", "Invalid email.");
    return;
  }

  if (!phone) {
    fail(400, "invalid_phone", "Invalid phone number.");
    return;
  }

  if (!fatherName) {
    fail(400, "missing_father_name", "Missing father name.");
    return;
  }

  if (!motherName) {
    fail(400, "missing_mother_name", "Missing mother name.");
    return;
  }

  if (!cpf || !isValidCpf(cpf)) {
    fail(400, "invalid_cpf", "Invalid CPF.");
    return;
  }

  if (!birthDate || !isValidBirthDate(birthDate)) {
    fail(400, "invalid_birth_date", "Invalid birth date.");
    return;
  }

  const address = getAddress(body);
  if (!address || !hasRequiredAddressFields(address)) {
    fail(400, "invalid_address", "Invalid address.");
    return;
  }

  const experience = normalizeExperienceCredit(body.experience_credit);
  if (experience.requested && !experience.note) {
    fail(400, "invalid_experience_note", "Experience note is required when experience credit is requested.");
    return;
  }

  const courseRequirementsAck = normalizeCourseRequirementsAck(
    body.course_requirements_ack ?? body.courseRequirementsAck ??
      (body.experience_credit as Record<string, unknown> | undefined)?.requirements_ack
  );
  const requirementsError = validateCourseRequirements(courseSlug, courseRequirementsAck);
  if (requirementsError) {
    fail(400, requirementsError, "Course requirements acknowledgements are incomplete.");
    return;
  }

  const courseLookup = await (async () => {
    try {
      const { rows } = await query<{ id: string; slug: string; name: string; price_cents: number }>(
        "select id, slug, name, price_cents from courses where slug = $1 and active = true",
        [courseSlug]
      );
      return { failed: false as const, course: rows?.[0] || null };
    } catch (error) {
      log.error({ error: sanitizeError(error) }, "courses_fetch_failed");
      fail(500, "courses_fetch_failed", "Failed to load selected course.");
      return { failed: true as const, course: null };
    }
  })();

  if (courseLookup.failed) return;

  const course = courseLookup.course;
  if (!course) {
    fail(400, "unknown_course", "Course does not exist or is inactive.");
    return;
  }

  const sourceUrl = sanitizeString(body.source_url ?? body.origem, 500);

  const payload = {
    course: {
      id: course.id,
      slug: course.slug,
      name: course.name,
      price_cents: course.price_cents
    },
    customer: {
      name,
      email,
      phone,
      father_name: fatherName,
      mother_name: motherName,
      cpf,
      birth_date: birthDate,
      address,
      experience_credit: experience.requested ? { requested: true, note: experience.note } : { requested: false }
    },
    course_requirements_ack: courseRequirementsAck,
    source_url: sourceUrl || undefined,
    created_via: "lead_form"
  };

  try {
    const { rows } = await query<{ id: string }>(
      `insert into lead_enrollments (
          course_id,
          course_slug,
          course_name,
          course_price_cents,
          customer_name,
          customer_email,
          customer_phone,
          father_name,
          mother_name,
          cpf,
          birth_date,
          address,
          experience_credit_requested,
          experience_note,
          source_url,
          payload
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        returning id`,
      [
        course.id,
        course.slug,
        course.name,
        Number(course.price_cents || 0),
        name,
        email,
        phone,
        fatherName,
        motherName,
        cpf,
        birthDate,
        address,
        Boolean(experience.requested),
        experience.note,
        sourceUrl,
        payload
      ]
    );

    const leadId = rows?.[0]?.id || "";
    res.status(200).json({ ok: true, lead_id: leadId, lead_code: buildLeadCode(leadId) });
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "lead_create_failed");
    fail(500, "lead_create_failed", "Failed to create lead enrollment.");
  }
}

export default withApiHandler(leadsHandler, {
  methods: ["GET", "POST"],
  cacheControl: "no-store",
  rateLimit: (req) => {
    if (req.method === "GET") {
      return { keyPrefix: "matriculator-leads", windowMs: 60_000, max: 120 };
    }

    if (req.method === "POST") {
      return { keyPrefix: "leads", windowMs: 60_000, max: 60 };
    }

    return null;
  }
});
