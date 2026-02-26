-- SECURITY BASELINE (Supabase)
-- Goal: prevent anonymous/public access to sensitive tables when using the Supabase anon key.
--
-- Why: In Supabase, the anon key is *public* by design. Your protection is RLS + policies.
-- If RLS is disabled on tables that contain PII (lead_enrollments), anyone with the anon key
-- can read/write data via PostgREST.
--
-- This script:
-- - Enables RLS on key tables (when they exist)
-- - Revokes privileges from anon/authenticated on sensitive tables
-- - Allows public read of active courses only (optional, safe default)

do $$
begin
  if to_regclass('public.courses') is not null then
    alter table public.courses enable row level security;

    revoke all on table public.courses from anon, authenticated;
    grant select on table public.courses to anon, authenticated;

    drop policy if exists "public_read_active_courses" on public.courses;
    create policy "public_read_active_courses"
      on public.courses
      for select
      to anon, authenticated
      using (active = true);
  end if;
end
$$;

do $$
begin
  if to_regclass('public.lead_enrollments') is not null then
    alter table public.lead_enrollments enable row level security;
    revoke all on table public.lead_enrollments from anon, authenticated;
  end if;
end
$$;
