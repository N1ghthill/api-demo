-- Add track/area/workload fields to courses

alter table public.courses
  add column if not exists track text default 'regular',
  add column if not exists area text,
  add column if not exists workload_hours int;

alter table public.courses
  alter column track set not null;

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
