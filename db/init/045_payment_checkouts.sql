-- Checkout attempts and transaction results from e.Rede

create table if not exists public.payment_checkouts (
  id uuid primary key default gen_random_uuid(),

  lead_id uuid references public.lead_enrollments(id),
  course_id uuid not null references public.courses(id),
  course_slug text not null,
  course_name text not null,

  amount_cents int not null,
  installments int not null default 1,
  reference text not null,
  status text not null,

  provider_http_status int,
  provider_return_code text,
  provider_return_message text,
  provider_tid text,
  provider_authorization_code text,
  provider_three_d_secure_url text,
  provider_response jsonb not null default '{}'::jsonb,

  customer_name text,
  customer_email text,
  customer_phone text,
  customer_cpf text,

  card_holder_name text,
  card_last4 text,
  card_bin text,
  brand_name text,

  source_url text,
  created_at timestamptz not null default now()
);

create index if not exists payment_checkouts_created_at_idx on public.payment_checkouts(created_at);
create index if not exists payment_checkouts_reference_idx on public.payment_checkouts(reference);
create index if not exists payment_checkouts_provider_tid_idx on public.payment_checkouts(provider_tid);
create index if not exists payment_checkouts_customer_email_idx on public.payment_checkouts(customer_email);
create index if not exists payment_checkouts_lead_id_idx on public.payment_checkouts(lead_id);
