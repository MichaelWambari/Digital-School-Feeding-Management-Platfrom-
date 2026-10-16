-- ============================================================
-- DSFMP demo data
--
-- Loads three demo schools alongside Jasiri School, each with
-- test students (with NFC card IDs), a registered NFC reader,
-- opening food stock, and a week of past attendance and lunch
-- distributions so Reports has something to show. Jasiri School
-- also gets a reader; its existing data is left as it is.
--
--   Tumaini School (Nakuru)  boarding: breakfast, lunch, supper, every day
--   Upendo School (Kisumu)   day school: lunch only, weekdays
--   Baraka School (Mombasa)  day school: breakfast and lunch, weekdays
--
-- All names and card IDs are made up. Safe to run on a live
-- database and safe to run again: it only adds rows that are
-- missing and never changes or deletes existing data.
-- Run after schema.sql (or fixes 001-003), in Supabase:
-- SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- Deliveries, attendance and distributions are recorded as the first
-- active network admin (or admin), so records say who entered them.
create temp table seed_user on commit drop as
  select user_id from public.users
  where status = 'active' and role in ('network_admin', 'admin')
  order by role desc -- 'network_admin' sorts before 'admin'
  limit 1;

-- ------------------------------------------------------------
-- Schools
-- ------------------------------------------------------------
insert into schools (name, location,
                     breakfast_start, breakfast_end,
                     lunch_start, lunch_end,
                     supper_start, supper_end)
values
  ('Jasiri School',  null,      '06:00', '07:00', '12:00', '14:00', '18:00', '20:00'),
  ('Tumaini School', 'Nakuru',  '05:30', '06:30', '12:30', '14:00', '18:00', '19:30'),
  ('Upendo School',  'Kisumu',  null,    null,    '12:00', '13:30', null,    null),
  ('Baraka School',  'Mombasa', '07:00', '08:00', '12:30', '14:00', null,    null)
on conflict (name) do nothing;

-- ------------------------------------------------------------
-- NFC readers, one per school
-- ------------------------------------------------------------
insert into nfc_devices (device_id, school_id, device_name, location)
select v.device_id, s.school_id, v.device_name, v.location
from (values
  ('reader-jasiri-01',  'Jasiri School',  'Dining hall reader', 'Dining hall'),
  ('reader-tumaini-01', 'Tumaini School', 'Dining hall reader', 'Dining hall'),
  ('reader-upendo-01',  'Upendo School',  'Kitchen reader',     'Kitchen serving point'),
  ('reader-baraka-01',  'Baraka School',  'Dining hall reader', 'Dining hall')
) as v(device_id, school, device_name, location)
join schools s on s.name = v.school
on conflict (device_id) do nothing;

-- ------------------------------------------------------------
-- Students (one inactive per school, to show they are excluded)
-- ------------------------------------------------------------
insert into beneficiaries (school_id, full_name, age, admission_no, nfc_tag_id, status)
select s.school_id, v.full_name, v.age, v.admission_no, v.nfc_tag_id, v.status
from (values
  ('Tumaini School', 'Brian Otieno',     12, 'TUM-001', 'A1000001', 'active'),
  ('Tumaini School', 'Faith Wanjiru',    11, 'TUM-002', 'A1000002', 'active'),
  ('Tumaini School', 'Kevin Mutua',      13, 'TUM-003', 'A1000003', 'active'),
  ('Tumaini School', 'Mercy Achieng',    10, 'TUM-004', 'A1000004', 'active'),
  ('Tumaini School', 'Dennis Kiprono',   14, 'TUM-005', 'A1000005', 'active'),
  ('Tumaini School', 'Joy Nyambura',     12, 'TUM-006', 'A1000006', 'inactive'),
  ('Upendo School',  'Collins Omondi',    9, 'UPE-001', 'B2000001', 'active'),
  ('Upendo School',  'Sharon Atieno',     8, 'UPE-002', 'B2000002', 'active'),
  ('Upendo School',  'Ian Kamau',        10, 'UPE-003', 'B2000003', 'active'),
  ('Upendo School',  'Grace Wambui',      7, 'UPE-004', 'B2000004', 'active'),
  ('Upendo School',  'Victor Ouma',       9, 'UPE-005', 'B2000005', 'active'),
  ('Upendo School',  'Lydia Chebet',      8, 'UPE-006', 'B2000006', 'inactive'),
  ('Baraka School',  'Hassan Mwinyi',    11, 'BAR-001', 'C3000001', 'active'),
  ('Baraka School',  'Amina Juma',       10, 'BAR-002', 'C3000002', 'active'),
  ('Baraka School',  'Omar Bakari',      12, 'BAR-003', 'C3000003', 'active'),
  ('Baraka School',  'Zawadi Mwangi',     9, 'BAR-004', 'C3000004', 'active'),
  ('Baraka School',  'Rehema Salim',     11, 'BAR-005', 'C3000005', 'active'),
  ('Baraka School',  'Juma Rashid',      13, 'BAR-006', 'C3000006', 'inactive')
) as v(school, full_name, age, admission_no, nfc_tag_id, status)
join schools s on s.name = v.school
on conflict do nothing; -- skips students whose admission no. or card ID already exists

-- ------------------------------------------------------------
-- Food items and opening stock. Stock only changes through
-- transactions, so each new item gets an opening delivery.
-- Baraka's beans start below the reorder level to show a warning.
-- ------------------------------------------------------------
create temp table seed_items on commit drop as
select * from (values
  ('Tumaini School', 'Rice',        'kg',     10, 50),
  ('Tumaini School', 'Maize flour', 'kg',     15, 60),
  ('Tumaini School', 'Beans',       'kg',      8, 30),
  ('Tumaini School', 'Cooking oil', 'litres',  2, 10),
  ('Upendo School',  'Maize flour', 'kg',     15, 40),
  ('Upendo School',  'Beans',       'kg',      8, 25),
  ('Upendo School',  'Cooking oil', 'litres',  2,  8),
  ('Baraka School',  'Rice',        'kg',     10, 45),
  ('Baraka School',  'Beans',       'kg',      8,  5),
  ('Baraka School',  'Cooking oil', 'litres',  2,  6)
) as v(school, item_name, unit, reorder_level, opening_stock);

insert into inventory_items (school_id, item_name, unit, reorder_level)
select s.school_id, v.item_name, v.unit, v.reorder_level
from seed_items v
join schools s on s.name = v.school
where not exists (select 1 from inventory_items i
                  where i.school_id = s.school_id and i.item_name = v.item_name);

insert into inventory_transactions (item_id, transaction_type, quantity, recorded_by)
select i.item_id, 'received', v.opening_stock, (select user_id from seed_user)
from seed_items v
join schools s on s.name = v.school
join inventory_items i on i.school_id = s.school_id and i.item_name = v.item_name
where not exists (select 1 from inventory_transactions t where t.item_id = i.item_id);

-- ------------------------------------------------------------
-- Last 7 days of attendance for the demo schools' active students:
-- only meals each school serves, weekdays only for day schools,
-- and about 85% turnout. The pattern is fixed (hash, not random),
-- so running the script again adds nothing new.
-- ------------------------------------------------------------
insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status, recorded_by)
select b.beneficiary_id, m.meal_type, d.day, 'present', (select user_id from seed_user)
from beneficiaries b
join schools s on s.school_id = b.school_id
cross join lateral (
  select g::date as day
  from generate_series((now() at time zone 'Africa/Nairobi')::date - 7,
                       (now() at time zone 'Africa/Nairobi')::date - 1,
                       interval '1 day') g
) d
cross join lateral (values
  ('breakfast', s.breakfast_start),
  ('lunch', s.lunch_start),
  ('supper', s.supper_start)
) as m(meal_type, starts_at)
where s.name in ('Tumaini School', 'Upendo School', 'Baraka School')
  and b.status = 'active'
  and m.starts_at is not null
  and (s.name = 'Tumaini School' or extract(isodow from d.day) < 6)
  and abs(hashtext(b.beneficiary_id::text || d.day::text || m.meal_type)) % 100 < 85
on conflict do nothing;

-- ------------------------------------------------------------
-- A 0.25 kg lunch portion of each school's staple for every
-- student who attended lunch. Each one deducts stock as usual.
-- ------------------------------------------------------------
insert into food_distribution (beneficiary_id, item_id, quantity_issued, distribution_date, recorded_by)
select a.beneficiary_id, i.item_id, 0.25, a.attendance_date, (select user_id from seed_user)
from meal_attendance a
join schools s on s.school_id = a.school_id
join (values
  ('Tumaini School', 'Rice'),
  ('Upendo School',  'Maize flour'),
  ('Baraka School',  'Rice')
) as staple(school, item_name) on staple.school = s.name
join inventory_items i on i.school_id = s.school_id and i.item_name = staple.item_name
where a.meal_type = 'lunch'
  and not exists (select 1 from food_distribution f
                  where f.beneficiary_id = a.beneficiary_id
                    and f.item_id = i.item_id
                    and f.distribution_date = a.attendance_date);

commit;
