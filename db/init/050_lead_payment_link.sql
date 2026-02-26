-- Link lead enrollments to payment attempts and results

alter table if exists public.payment_checkouts
  add column if not exists lead_id uuid references public.lead_enrollments(id);

create index if not exists payment_checkouts_lead_id_idx on public.payment_checkouts(lead_id);

alter table if exists public.lead_enrollments
  add column if not exists payment_status text not null default 'pending',
  add column if not exists payment_reference text,
  add column if not exists payment_tid text,
  add column if not exists payment_return_code text,
  add column if not exists payment_return_message text,
  add column if not exists payment_updated_at timestamptz,
  add column if not exists paid_at timestamptz;

create index if not exists lead_enrollments_payment_status_idx on public.lead_enrollments(payment_status);
create index if not exists lead_enrollments_payment_reference_idx on public.lead_enrollments(payment_reference);
