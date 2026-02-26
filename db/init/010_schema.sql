create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  price_cents int not null,
  active boolean not null default true,
  track text not null default 'regular',
  area text,
  workload_hours int,
  modality text default 'EAD',
  duration_months_min int,
  duration_months_max int,
  tcc_required boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'courses_track_check'
  ) then
    alter table public.courses
      add constraint courses_track_check
      check (track in ('regular', 'competencia_profissional'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'courses_modality_check'
  ) then
    alter table public.courses
      add constraint courses_modality_check
      check (modality in ('EAD', 'Presencial', 'Híbrido'));
  end if;
end $$;
