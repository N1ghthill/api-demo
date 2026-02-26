-- Prevent duplicated checkout charges caused by retries/network timeouts.

alter table if exists public.payment_checkouts
  add column if not exists idempotency_key text;

create unique index if not exists payment_checkouts_idempotency_key_uidx
  on public.payment_checkouts (idempotency_key)
  where idempotency_key is not null;

create index if not exists payment_checkouts_status_idx
  on public.payment_checkouts (status);

