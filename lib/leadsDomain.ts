import { createHash, timingSafeEqual } from "crypto";
import type { VercelRequest } from "@vercel/node";
import { normalizeUf, onlyDigits, sanitizeString } from "./validators.js";

export type Address = {
  cep?: string;
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
};

export type CourseRequirementsAck = {
  minimum_experience_two_years: boolean;
  coren_active_two_years_auxiliar: boolean;
  professional_link_proof: boolean;
  professional_link_proof_type: "ctps" | "contrato_publico" | null;
};

export type LeadLookupRow = {
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

export function isValidBirthDate(value: unknown): boolean {
  const str = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;

  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return false;

  return date <= new Date();
}

export function normalizeAddress(address: unknown): Address | null {
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

export function hasRequiredAddressFields(address: Address | null): boolean {
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

export function normalizeExperienceCredit(value: unknown): { requested: boolean; note: string | null } {
  if (!value || typeof value !== "object") return { requested: false, note: null };

  const source = value as Record<string, unknown>;
  const requested = Boolean(source.requested);
  const note = sanitizeString(source.note, 1200);
  return { requested, note: requested ? note : null };
}

export function normalizeCourseRequirementsAck(value: unknown): CourseRequirementsAck {
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

export function validateCourseRequirements(courseSlug: string, ack: CourseRequirementsAck): string | null {
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

export function buildLeadCode(leadId: string | null | undefined): string {
  if (!leadId) return "";

  const normalized = String(leadId).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) return "";

  return `MAT-${normalized.slice(0, 8)}`;
}

function getTokenFromRequest(req: VercelRequest): string | null {
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

export function isValidSha256Hex(value: string): boolean {
  return SHA256_HEX_REGEX.test(value);
}

export function isAuthorizedInternalToken(providedToken: string | null, req: VercelRequest): boolean {
  if (!providedToken) {
    providedToken = getTokenFromRequest(req);
  }

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

export function normalizeLeadCodePrefix(value: unknown): string | null {
  const raw = String(value ?? "").toUpperCase().trim();
  if (!raw) return null;

  const withoutPrefix = raw.startsWith("MAT-") ? raw.slice(4) : raw;
  const normalized = withoutPrefix.replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (normalized.length < 6) return null;

  return normalized;
}

export function normalizePaymentStatus(value: unknown): string | null {
  const status = String(value ?? "")
    .trim()
    .toLowerCase();

  if (!status) return null;
  if (!ALLOWED_PAYMENT_STATUS.has(status)) return null;
  return status;
}

export function parseLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 50;

  const parsed = Math.trunc(num);
  if (parsed < 1) return 1;
  if (parsed > 200) return 200;
  return parsed;
}

export function getCourseSlug(body: Record<string, unknown>): string | null {
  const raw =
    sanitizeString(body.course_slug, 120) ||
    sanitizeString(body.curso_slug, 120) ||
    sanitizeString(body.courseSlug, 120);

  return raw ? raw.toLowerCase() : null;
}

export function getAddress(body: Record<string, unknown>): Address | null {
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
