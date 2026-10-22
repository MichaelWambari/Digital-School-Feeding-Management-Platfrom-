-- ============================================================
-- DSFMP demo data
--
-- Loads three demo schools alongside Jasiri School, each with
-- test students (with NFC card IDs), a registered NFC reader,
-- food received from the central store, and a week of past
-- attendance and food used at meals so Reports has something to
-- show. Jasiri School also gets a reader; its existing data is
-- left as it is.
--
--   Tumaini School (Nakuru)  boarding: breakfast, lunch, supper, every day
--   Upendo School (Kisumu)   day school: lunch only, weekdays
--   Baraka School (Mombasa)  day school: breakfast and lunch, weekdays
--
-- The central store gets a delivery of each food. Each school's
-- opening stock is a dispatch from the store that the school has
-- confirmed (Baraka's beans arrived 2 kg short), and Tumaini has
-- one more rice dispatch still in transit, ready to confirm.
--
-- All names and card IDs are made up. Safe to run on a live
-- database and safe to run again: it only adds rows that are
-- missing and never changes or deletes existing data.
-- Run after schema.sql (or fixes 001-004), in Supabase:
-- SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- Deliveries, attendance and food used are recorded as the first
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
-- The food list and a delivery of each food into the central
-- store. Stock only changes through transactions, so a food
-- with no store history gets one delivery.
-- ------------------------------------------------------------
insert into food_items (item_name, unit, reorder_level)
values
  ('Rice',        'kg',     200),
  ('Maize flour', 'kg',     200),
  ('Beans',       'kg',     100),
  ('Cooking oil', 'litres',  20)
on conflict do nothing;

insert into central_transactions (food_id, transaction_type, quantity, transaction_date, recorded_by)
select f.food_id, 'received', v.quantity, (now() at time zone 'Africa/Nairobi')::date - 10,
       (select user_id from seed_user)
from (values
  ('Rice',        1000),
  ('Maize flour', 1000),
  ('Beans',        500),
  ('Cooking oil',  100)
) as v(item_name, quantity)
join food_items f on lower(f.item_name) = lower(v.item_name)
where not exists (select 1 from central_transactions t where t.food_id = f.food_id);

-- ------------------------------------------------------------
-- Opening stock: one dispatch per school and food, sent 8 days
-- ago and confirmed by the school the next day. Only added for
-- foods the school doesn't stock yet.
-- ------------------------------------------------------------
create temp table seed_dispatches on commit drop as
select s.school_id, f.food_id, v.sent, v.received, v.reorder_level
from (values
  ('Tumaini School', 'Rice',        50, 50, 10),
  ('Tumaini School', 'Maize flour', 60, 60, 15),
  ('Tumaini School', 'Beans',       30, 30,  8),
  ('Tumaini School', 'Cooking oil', 10, 10,  2),
  ('Upendo School',  'Maize flour', 40, 40, 15),
  ('Upendo School',  'Beans',       25, 25,  8),
  ('Upendo School',  'Cooking oil',  8,  8,  2),
  ('Baraka School',  'Rice',        45, 45, 10),
  ('Baraka School',  'Beans',        8,  6,  8),
  ('Baraka School',  'Cooking oil',  6,  6,  2)
) as v(school, item_name, sent, received, reorder_level)
join schools s on s.name = v.school
join food_items f on lower(f.item_name) = lower(v.item_name)
where not exists (select 1 from inventory_items i
                  where i.school_id = s.school_id and i.food_id = f.food_id);

-- Inserting a dispatch takes the food out of the central store.
insert into food_distribution (school_id, food_id, quantity_dispatched, dispatch_date, dispatched_by)
select school_id, food_id, sent, (now() at time zone 'Africa/Nairobi')::date - 8,
       (select user_id from seed_user)
from seed_dispatches;

-- Confirm them, as receive_distribution() would.
insert into inventory_items (school_id, food_id, reorder_level)
select school_id, food_id, reorder_level from seed_dispatches
on conflict (school_id, food_id) do nothing;

update food_distribution d
set status = 'received', quantity_received = sd.received,
    received_date = d.dispatch_date + 1, received_by = d.dispatched_by
from seed_dispatches sd
where d.school_id = sd.school_id and d.food_id = sd.food_id and d.status = 'in_transit';

insert into inventory_transactions
    (item_id, transaction_type, quantity, transaction_date, distribution_id, recorded_by)
select i.item_id, 'received', d.quantity_received, d.received_date, d.distribution_id, d.received_by
from food_distribution d
join seed_dispatches sd on sd.school_id = d.school_id and sd.food_id = d.food_id
join inventory_items i on i.school_id = d.school_id and i.food_id = d.food_id;

-- A second rice dispatch to Tumaini, still in transit.
insert into food_distribution (school_id, food_id, quantity_dispatched, dispatch_date, dispatched_by)
select s.school_id, f.food_id, 40, (now() at time zone 'Africa/Nairobi')::date,
       (select user_id from seed_user)
from schools s
join food_items f on f.item_name = 'Rice'
where s.name = 'Tumaini School'
  and not exists (select 1 from food_distribution d
                  where d.school_id = s.school_id and d.food_id = f.food_id
                    and d.status = 'in_transit');

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
-- Food used at each of those meals: a fixed portion per student
-- who attended, recorded as one total per meal and food. Each
-- one deducts stock as usual.
-- ------------------------------------------------------------
insert into food_consumption (item_id, meal_type, consumption_date, quantity, recorded_by)
select i.item_id, a.meal_type, a.attendance_date, count(*) * p.portion, (select user_id from seed_user)
from meal_attendance a
join schools s on s.school_id = a.school_id
join (values
  ('Tumaini School', 'breakfast', 'Maize flour', 0.10),
  ('Tumaini School', 'lunch',     'Rice',        0.25),
  ('Tumaini School', 'lunch',     'Beans',       0.10),
  ('Tumaini School', 'supper',    'Maize flour', 0.25),
  ('Tumaini School', 'supper',    'Beans',       0.10),
  ('Upendo School',  'lunch',     'Maize flour', 0.25),
  ('Upendo School',  'lunch',     'Beans',       0.10),
  ('Baraka School',  'breakfast', 'Rice',        0.10),
  ('Baraka School',  'lunch',     'Rice',        0.25),
  ('Baraka School',  'lunch',     'Beans',       0.05)
) as p(school, meal_type, item_name, portion) on p.school = s.name and p.meal_type = a.meal_type
join food_items f on f.item_name = p.item_name
join inventory_items i on i.school_id = s.school_id and i.food_id = f.food_id
where not exists (select 1 from food_consumption c
                  where c.item_id = i.item_id
                    and c.meal_type = a.meal_type
                    and c.consumption_date = a.attendance_date)
group by i.item_id, a.meal_type, a.attendance_date, p.portion;

commit;
