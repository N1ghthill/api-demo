import { createHash, timingSafeEqual } from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors } from "../lib/cors.js";
import { query } from "../lib/db.js";
import { applySecurityHeaders } from "../lib/http.js";
import { rateLimit } from "../lib/rateLimit.js";

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

function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D+/g, "");
}

function sanitizeString(value: unknown, maxLen = 240): string | null {
  const str = String(value ?? "").trim();
  if (!str) return null;
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

function isValidPhone(value: unknown): boolean {
  const digits = onlyDigits(value);
  return digits.length >= 10 && digits.length <= 13;
}

function isValidCpf(value: unknown): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpf)) return false;

  const calc = (base: string, factor: number): number => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) {
      sum += Number(base[i]) * (factor - i);
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const d1 = calc(cpf.slice(0, 9), 10);
  const d2 = calc(cpf.slice(0, 10), 11);
  return cpf.endsWith(String(d1) + String(d2));
}

function isValidBirthDate(value: unknown): boolean {
  const str = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  if (date > now) return false;
  return true;
}

function normalizeAddress(address: any): Address | null {
  if (!address || typeof address !== "object") return null;

  const cepDigits = onlyDigits(address.cep);
  const cep = cepDigits ? (cepDigits.length === 8 ? cepDigits : null) : null;

  const state = sanitizeString(address.state, 2);
  const normalizedState = state ? state.toUpperCase() : null;
  if (normalizedState && !/^[A-Z]{2}$/.test(normalizedState)) {
    return null;
  }

  const out: Address = {
    cep: cep || undefined,
    street: sanitizeString(address.street, 160) || undefined,
    number: sanitizeString(address.number, 40) || undefined,
    complement: sanitizeString(address.complement, 120) || undefined,
    neighborhood: sanitizeString(address.neighborhood, 120) || undefined,
    city: sanitizeString(address.city, 120) || undefined,
    state: normalizedState || undefined
  };

  const hasAny = Object.values(out).some((v) => Boolean(v));
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

function normalizeExperienceCredit(value: any): { requested: boolean; note: string | null } {
  if (!value || typeof value !== "object") return { requested: false, note: null };
  const requested = Boolean(value.requested);
  const note = sanitizeString(value.note, 1200);
  return { requested, note: requested ? note : null };
}

function normalizeCourseRequirementsAck(value: any): CourseRequirementsAck {
  if (!value || typeof value !== "object") {
    return {
      minimum_experience_two_years: false,
      coren_active_two_years_auxiliar: false,
      professional_link_proof: false,
      professional_link_proof_type: null
    };
  }

  const proofTypeRaw = sanitizeString(
    value.professional_link_proof_type ?? value.professionalLinkProofType ?? value.proof_type,
    40
  );
  const proofTypeNormalized = proofTypeRaw ? proofTypeRaw.toLowerCase() : null;
  const proofType =
    proofTypeNormalized && PROFESSIONAL_LINK_PROOF_TYPES.has(proofTypeNormalized)
      ? (proofTypeNormalized as "ctps" | "contrato_publico")
      : null;

  return {
    minimum_experience_two_years: Boolean(
      value.minimum_experience_two_years ?? value.minimumExperienceTwoYears ?? value.minimum_years_ack
    ),
    coren_active_two_years_auxiliar: Boolean(
      value.coren_active_two_years_auxiliar ?? value.corenActiveTwoYearsAuxiliar ?? value.coren_ack
    ),
    professional_link_proof: Boolean(
      value.professional_link_proof ?? value.professionalLinkProof ?? value.formal_proof_ack
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

function getTokenFromRequest(req: VercelRequest): string | null {
  const explicit = sanitizeString(req.headers["x-matriculator-token"], 240);
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

function isAuthorizedMatriculatorToken(providedToken: string | null): boolean {
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

async function handleLeadLookup(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (rateLimit(req, res, { keyPrefix: "matriculator-leads", windowMs: 60_000, max: 120 })) return;

  const hasPlainToken = Boolean(String(process.env.MATRICULADOR_TOKEN || "").trim());
  const configuredTokenHash = String(process.env.MATRICULADOR_TOKEN_SHA256 || "")
    .trim()
    .toLowerCase();
  const hasHashedToken = Boolean(configuredTokenHash);

  if (!hasPlainToken && !hasHashedToken) {
    res.status(500).json({ error: "matriculator_token_not_configured" });
    return;
  }

  if (hasHashedToken && !isValidSha256Hex(configuredTokenHash)) {
    res.status(500).json({ error: "matriculator_token_hash_invalid" });
    return;
  }

  const providedToken = getTokenFromRequest(req);
  if (!isAuthorizedMatriculatorToken(providedToken)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const leadCodePrefix = normalizeLeadCodePrefix(req.query?.lead_code);
  const paymentStatus = normalizePaymentStatus(req.query?.payment_status);
  const limit = parseLimit(req.query?.limit);

  if (!leadCodePrefix && !paymentStatus) {
    res.status(400).json({ error: "missing_filter", detail: "Use lead_code or payment_status." });
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
      const undefinedPaymentColumns = errorCode === "42703";
      if (!undefinedPaymentColumns) throw queryError;

      if (paymentStatus) {
        res.status(500).json({
          error: "payment_status_filter_unavailable",
          detail: "Apply migration db/init/050_lead_payment_link.sql to enable this filter."
        });
        return;
      }

      // Backward-compatible path while migration 050 is not applied yet.
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
    console.error("Failed to load leads for matriculator", error);
    res.status(500).json({ error: "lead_lookup_failed" });
  }
}

function getCourseSlug(body: any): string | null {
  return (
    sanitizeString(body?.course_slug, 120) ||
    sanitizeString(body?.curso_slug, 120) ||
    sanitizeString(body?.courseSlug, 120)
  );
}

function getAddress(body: any): Address | null {
  if (body?.address && typeof body.address === "object") {
    return normalizeAddress(body.address);
  }

  const fallback = {
    cep: body?.cep,
    street: body?.endereco,
    number: body?.numero,
    complement: body?.complemento,
    neighborhood: body?.bairro,
    city: body?.cidade,
    state: body?.estado
  };
  return normalizeAddress(fallback);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applySecurityHeaders(req, res);
  if (cors(req, res)) return;

  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    await handleLeadLookup(req, res);
    return;
  }

  if (req.method !== "POST") return res.status(405).end();

  if (rateLimit(req, res, { keyPrefix: "leads", windowMs: 60_000, max: 60 })) return;

  const body = req.body ?? {};

  const courseSlug = getCourseSlug(body);
  if (!courseSlug) return res.status(400).json({ error: "invalid_course" });

  const name = sanitizeString(body?.name ?? body?.nome, 160);
  const email = sanitizeString(body?.email, 180);
  const phone = sanitizeString(body?.phone ?? body?.telefone, 40);
  const fatherName = sanitizeString(body?.father_name ?? body?.nome_pai ?? body?.nomePai, 160);
  const motherName = sanitizeString(body?.mother_name ?? body?.nome_mae ?? body?.nomeMae, 160);
  const cpf = body?.cpf ? onlyDigits(body.cpf) : null;
  const birthDate = sanitizeString(body?.birth_date ?? body?.nascimento, 10);

  if (!name) return res.status(400).json({ error: "invalid_name" });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "invalid_email" });
  if (!phone || !isValidPhone(phone)) return res.status(400).json({ error: "invalid_phone" });
  if (!fatherName) return res.status(400).json({ error: "missing_father_name" });
  if (!motherName) return res.status(400).json({ error: "missing_mother_name" });
  if (!cpf || !isValidCpf(cpf)) return res.status(400).json({ error: "invalid_cpf" });
  if (!birthDate || !isValidBirthDate(birthDate)) return res.status(400).json({ error: "invalid_birth_date" });

  const address = getAddress(body);
  if (!address || !hasRequiredAddressFields(address)) {
    return res.status(400).json({ error: "invalid_address" });
  }

  const experience = normalizeExperienceCredit(body?.experience_credit);
  if (experience.requested && !experience.note) {
    return res.status(400).json({ error: "invalid_experience_note" });
  }

  const courseRequirementsAck = normalizeCourseRequirementsAck(
    body?.course_requirements_ack ?? body?.courseRequirementsAck ?? body?.experience_credit?.requirements_ack
  );
  const requirementsError = validateCourseRequirements(courseSlug, courseRequirementsAck);
  if (requirementsError) {
    return res.status(400).json({ error: requirementsError });
  }

  let course: { id: string; slug: string; name: string; price_cents: number } | null = null;
  try {
    const { rows } = await query<{ id: string; slug: string; name: string; price_cents: number }>(
      "select id, slug, name, price_cents from courses where slug = $1 and active = true",
      [courseSlug]
    );
    course = rows?.[0] || null;
  } catch (error) {
    console.error("Failed to fetch course", error);
    return res.status(500).json({ error: "courses_fetch_failed" });
  }

  if (!course) return res.status(400).json({ error: "unknown_course" });

  const sourceUrl = sanitizeString(body?.source_url ?? body?.origem, 500);

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
    const leadCode = buildLeadCode(leadId);
    return res.status(200).json({ ok: true, lead_id: leadId, lead_code: leadCode });
  } catch (error) {
    console.error("Failed to create lead enrollment", error);
    return res.status(500).json({ error: "lead_create_failed" });
  }
}
