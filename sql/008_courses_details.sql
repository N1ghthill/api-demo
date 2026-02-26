-- Add course delivery and academic details

alter table public.courses
  add column if not exists modality text default 'EAD',
  add column if not exists duration_months_min int,
  add column if not exists duration_months_max int,
  add column if not exists tcc_required boolean default true;

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
