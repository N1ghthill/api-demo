-- Store lead enrollments (matricula)

create table if not exists public.lead_enrollments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id),
  course_slug text not null,
  course_name text not null,
  course_price_cents int,

  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,

  father_name text not null,
  mother_name text not null,

  cpf text,
  birth_date date,
  address jsonb,

  experience_credit_requested boolean not null default false,
  experience_note text,

  source_url text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists lead_enrollments_created_at_idx on public.lead_enrollments(created_at);
create index if not exists lead_enrollments_customer_email_idx on public.lead_enrollments(customer_email);
create index if not exists lead_enrollments_course_slug_idx on public.lead_enrollments(course_slug);
