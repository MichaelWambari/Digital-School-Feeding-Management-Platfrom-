-- ============================================================
-- FRESH START -- PERMANENTLY DELETES DATA. CANNOT BE UNDONE.
--
-- Removes every school and everything that belongs to one:
-- students, NFC readers and scan logs, attendance and nutrition
-- records, stock, deliveries, food used, timetables, dishes and
-- servings, staff permissions, reports and the audit log; the old
-- central store's history; and EVERY LOGIN (Supabase Auth users).
--
-- Kept: the shared food list and its nutrition values (the old
-- central store's stock is set to zero).
--
-- Afterwards a headteacher creates an account in the app and
-- names their school. Run it once, BEFORE fix 013, in Supabase:
-- SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- Removing the last headteacher of a school is normally blocked.
alter table public.users disable trigger keep_a_headteacher;

delete from public.attendance_nutrition;
delete from public.meal_attendance;
delete from public.nfc_tag_logs;
delete from public.inventory_transactions;
delete from public.food_consumption;
delete from public.inventory_items;
delete from public.central_transactions;
delete from public.food_distribution;
delete from public.meal_ingredients;
delete from public.meal_schedules;
delete from public.meals;
delete from public.food_nutrition where school_id is not null;
delete from public.school_role_permissions;
delete from public.beneficiaries;
delete from public.nfc_devices;
delete from public.reports;

-- Every login (and with it each users profile and sign-in code).
delete from auth.users;
delete from public.users;
delete from public.schools;
delete from public.audit_logs;

update public.food_items set quantity_available = 0, reorder_level = 0;

alter table public.users enable trigger keep_a_headteacher;

commit;

-- What's left (shown in the results panel): all zeros except foods.
select (select count(*) from public.schools) as schools,
       (select count(*) from auth.users) as logins,
       (select count(*) from public.beneficiaries) as students,
       (select count(*) from public.meal_attendance) as attendance,
       (select count(*) from public.food_items) as foods_kept;
