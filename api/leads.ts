import { createHash, timingSafeEqual } from "crypto";
import { withApiHandler, type ApiHandlerContext } from "../lib/apiHandler.js";
import { query } from "../lib/db.js";
import { sanitizeError } from "../lib/logger.js";
import {
  isValidCpf,
  isValidEmail,
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeUf,
  onlyDigits,
  sanitizeString
} from "../lib/validators.js";

type Address = {
  cep?: string;
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
};

type CourseRequirementsAck = {
  minimum_experience_two_years: boolean;
  coren_active_two_years_auxiliar: boolean;
  professional_link_proof: boolean;
  professional_link_proof_type: "ctps" | "contrato_publico" | null;
};

type LeadLookupRow = {
  id: string;
  course_slug: string;
  course_name: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  cpf: string | null;
  birth_date: string | null;
  father_name: string;
  mother_name: string;
  address: Record<string, unknown> | null;
  payment_status: string | null;
  payment_reference: string | null;
  payment_tid: string | null;
  payment_return_code: string | null;
  payment_return_message: string | null;
  created_at: string;
  payment_updated_at: string | null;
  paid_at: string | null;
};

const ALLOWED_PAYMENT_STATUS = new Set([
  "pending",
  "processing",
  "approved",
  "pending_authentication",
  "declined",
  "provider_unavailable"
]);
const PROFESSIONAL_LINK_PROOF_TYPES = new Set(["ctps", "contrato_publico"]);
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

function isValidBirthDate(value: unknown): boolean {
  const str = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;

  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return false;

  return date <= new Date();
}

function normalizeAddress(address: unknown): Address | null {
  if (!address || typeof address !== "object") return null;
  const source = address as Record<string, unknown>;

  const cepDigits = onlyDigits(source.cep);
  const cep = cepDigits ? (cepDigits.length === 8 ? cepDigits : null) : null;
  const state = normalizeUf(source.state);

  if (source.state && !state) {
    return null;
  }

  const out: Address = {
    cep: cep || undefined,
    street: sanitizeString(source.street, 160) || undefined,
    number: sanitizeString(source.number, 40) || undefined,
    complement: sanitizeString(source.complement, 120) || undefined,
    neighborhood: sanitizeString(source.neighborhood, 120) || undefined,
    city: sanitizeString(source.city, 120) || undefined,
    state: state || undefined
  };

  const hasAny = Object.values(out).some((value) => Boolean(value));
  return hasAny ? out : null;
}

function hasRequiredAddressFields(address: Address | null): boolean {
  if (!address) return false;
  return Boolean(
    address.cep &&
      address.street &&
      address.number &&
      address.neighborhood &&
      address.city &&
      address.state
  );
}

function normalizeExperienceCredit(value: unknown): { requested: boolean; note: string | null } {
  if (!value || typeof value !== "object") return { requested: false, note: null };

  const source = value as Record<string, unknown>;
  const requested = Boolean(source.requested);
  const note = sanitizeString(source.note, 1200);
  return { requested, note: requested ? note : null };
}

function normalizeCourseRequirementsAck(value: unknown): CourseRequirementsAck {
  if (!value || typeof value !== "object") {
    return {
      minimum_experience_two_years: false,
      coren_active_two_years_auxiliar: false,
      professional_link_proof: false,
      professional_link_proof_type: null
    };
  }

  const source = value as Record<string, unknown>;
  const proofTypeRaw = sanitizeString(
    source.professional_link_proof_type ?? source.professionalLinkProofType ?? source.proof_type,
    40
  );
  const proofTypeNormalized = proofTypeRaw ? proofTypeRaw.toLowerCase() : null;
  const proofType =
    proofTypeNormalized && PROFESSIONAL_LINK_PROOF_TYPES.has(proofTypeNormalized)
      ? (proofTypeNormalized as "ctps" | "contrato_publico")
      : null;

  return {
    minimum_experience_two_years: Boolean(
      source.minimum_experience_two_years ?? source.minimumExperienceTwoYears ?? source.minimum_years_ack
    ),
    coren_active_two_years_auxiliar: Boolean(
      source.coren_active_two_years_auxiliar ?? source.corenActiveTwoYearsAuxiliar ?? source.coren_ack
    ),
    professional_link_proof: Boolean(
      source.professional_link_proof ?? source.professionalLinkProof ?? source.formal_proof_ack
    ),
    professional_link_proof_type: proofType
  };
}

function validateCourseRequirements(courseSlug: string, ack: CourseRequirementsAck): string | null {
  const slug = String(courseSlug || "")
    .trim()
    .toLowerCase();

  if (slug !== "enfermagem" && slug !== "saude-bucal") return null;
  if (!ack.minimum_experience_two_years) return "missing_minimum_experience_ack";

  if (slug === "saude-bucal") return null;

  if (!ack.coren_active_two_years_auxiliar) return "missing_coren_ack";
  if (!ack.professional_link_proof) return "missing_professional_link_proof_ack";
  if (!ack.professional_link_proof_type) return "invalid_professional_link_proof_type";
  return null;
}

function buildLeadCode(leadId: string | null | undefined): string {
  if (!leadId) return "";

  const normalized = String(leadId).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) return "";

  return `MAT-${normalized.slice(0, 8)}`;
}

function getTokenFromRequest(req: ApiHandlerContext["req"]): string | null {
  const explicit = sanitizeString(req.headers["x-internal-token"] ?? req.headers["x-matriculator-token"], 240);
  if (explicit) return explicit;

  const authorization = sanitizeString(req.headers.authorization, 260);
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return null;

  return sanitizeString(match[1], 240);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidSha256Hex(value: string): boolean {
  return SHA256_HEX_REGEX.test(value);
}

function isAuthorizedInternalToken(providedToken: string | null): boolean {
  if (!providedToken) return false;

  const configuredToken = String(process.env.MATRICULADOR_TOKEN || "").trim();
  const configuredTokenHash = String(process.env.MATRICULADOR_TOKEN_SHA256 || "")
    .trim()
    .toLowerCase();

  if (configuredTokenHash) {
    if (!isValidSha256Hex(configuredTokenHash)) return false;
    const providedHash = sha256Hex(providedToken);
    return secureCompare(providedHash, configuredTokenHash);
  }

  if (!configuredToken) return false;
  return secureCompare(providedToken, configuredToken);
}

function normalizeLeadCodePrefix(value: unknown): string | null {
  const raw = String(value ?? "").toUpperCase().trim();
  if (!raw) return null;

  const withoutPrefix = raw.startsWith("MAT-") ? raw.slice(4) : raw;
  const normalized = withoutPrefix.replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (normalized.length < 6) return null;

  return normalized;
}

function normalizePaymentStatus(value: unknown): string | null {
  const status = String(value ?? "")
    .trim()
    .toLowerCase();

  if (!status) return null;
  if (!ALLOWED_PAYMENT_STATUS.has(status)) return null;
  return status;
}

function parseLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;

  const parsed = Math.trunc(num);
  if (parsed < 1) return 1;
  if (parsed > 200) return 200;
  return parsed;
}

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

  const providedToken = getTokenFromRequest(req);
  if (!isAuthorizedInternalToken(providedToken)) {
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

function getCourseSlug(body: Record<string, unknown>): string | null {
  return (
    sanitizeString(body.course_slug, 120) ||
    sanitizeString(body.curso_slug, 120) ||
    sanitizeString(body.courseSlug, 120)
  );
}

function getAddress(body: Record<string, unknown>): Address | null {
  if (body.address && typeof body.address === "object") {
    return normalizeAddress(body.address);
  }

  const fallback = {
    cep: body.cep,
    street: body.endereco,
    number: body.numero,
    complement: body.complemento,
    neighborhood: body.bairro,
    city: body.cidade,
    state: body.estado
  };

  return normalizeAddress(fallback);
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

  let course: { id: string; slug: string; name: string; price_cents: number } | null = null;
  try {
    const { rows } = await query<{ id: string; slug: string; name: string; price_cents: number }>(
      "select id, slug, name, price_cents from courses where slug = $1 and active = true",
      [courseSlug]
    );
    course = rows?.[0] || null;
  } catch (error) {
    log.error({ error: sanitizeError(error) }, "courses_fetch_failed");
    fail(500, "courses_fetch_failed", "Failed to load selected course.");
    return;
  }

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
