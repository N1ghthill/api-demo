import type { Logger } from "pino";
import { query } from "./db.js";
import { sanitizeError } from "./logger.js";
import type {
  CheckoutInsertInput,
  CheckoutInsertOutcome,
  CheckoutStateRow,
  LeadRow
} from "./paymentsDomain.js";
import { getPgErrorCode } from "./paymentsDomain.js";

let idempotencySchemaState: "unknown" | "ready" | "unavailable" = "unknown";
let idempotencySchemaAttemptPromise: Promise<boolean> | null = null;
let idempotencySchemaLastAttemptAt = 0;

export async function loadLeadById(leadId: string): Promise<LeadRow | null> {
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

export async function loadCheckoutByIdempotencyKey(
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

export async function loadCheckoutByReference(
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

export async function ensureIdempotencySchemaReady(log: Logger): Promise<boolean> {
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
      log.error({ error: sanitizeError(error) }, "payment_idempotency_schema_ensure_failed");
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

export async function insertProcessingCheckout(
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

export async function markProviderUnavailable(args: {
  leadId: string;
  checkoutId: string | null;
  reference: string;
  providerHttpStatus?: number | null;
  returnCode?: string | null;
  message: string;
  providerResponse: Record<string, unknown>;
  log: Logger;
}): Promise<void> {
  if (args.checkoutId) {
    try {
      await query(
        `update payment_checkouts
            set status = $2,
                provider_http_status = $3,
                provider_return_code = $4,
                provider_return_message = $5,
                provider_response = $6::jsonb
          where id = $1`,
        [
          args.checkoutId,
          "provider_unavailable",
          args.providerHttpStatus ?? null,
          args.returnCode ?? null,
          args.message,
          JSON.stringify(args.providerResponse)
        ]
      );
    } catch (error) {
      args.log.error({ error: sanitizeError(error) }, "payment_checkout_update_after_provider_failure_failed");
    }
  }

  try {
    await query(
      `update lead_enrollments
          set payment_status = $2,
              payment_reference = $3,
              payment_tid = null,
              payment_return_code = $4,
              payment_return_message = $5,
              payment_updated_at = now()
        where id = $1`,
      [args.leadId, "provider_unavailable", args.reference, args.returnCode ?? null, args.message]
    );
  } catch (error) {
    args.log.error({ error: sanitizeError(error) }, "lead_update_after_provider_failure_failed");
  }
}
