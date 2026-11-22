-- ============================================================
-- Fix 019: live attendance
--
-- Adds meal_attendance to Supabase Realtime, so the Attendance
-- screen sees a meal the moment it is recorded (by an NFC tap or on
-- another device) without being refreshed.
--
-- Realtime applies the table's row level security, so staff only
-- receive their own school's rows, the same as when they read the
-- table.
--
-- Safe to run more than once.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'meal_attendance'
  ) then
    alter publication supabase_realtime add table public.meal_attendance;
  end if;
end;
$$;
