import { createHash } from "crypto";

export function normalizeIdempotencyKey(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/[^a-zA-Z0-9._:-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

  if (normalized.length < 8) return null;
  return normalized;
}

export function buildAutomaticIdempotencyKey(input: {
  leadId: string;
  courseSlug: string;
  amountCents: number;
  installments: number;
  cardBin: string;
  cardLast4: string;
  expirationMonth: string;
  expirationYear: string;
}): string {
  const bucket = Math.floor(Date.now() / 600_000);
  const fingerprint = [
    input.leadId,
    input.courseSlug,
    String(input.amountCents),
    String(input.installments),
    input.cardBin,
    input.cardLast4,
    input.expirationMonth,
    input.expirationYear,
    String(bucket)
  ].join("|");

  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 48);
  return `auto-${digest}`;
}

export function getCheckoutResponseHttpStatus(status: string): number {
  if (status === "processing") return 202;
  if (status === "provider_unavailable") return 502;
  return 200;
}

