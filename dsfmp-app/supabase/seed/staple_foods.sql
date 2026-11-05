-- ============================================================
-- DSFMP staple foods
--
-- Adds the common school-feeding staples to the food list and
-- stocks them everywhere:
--
--   * the central store gets a delivery of each staple, enough to
--     supply every school and still hold the "store" amount below;
--   * every school gets the "per school" amount of each staple it
--     doesn't stock yet, as a dispatch from the store that the
--     school has confirmed, so stock histories add up as usual.
--
-- Foods already on the list (e.g. Rice, Beans) keep their name,
-- unit and stock; schools that don't stock them yet get some.
--
-- Safe to run on a live database and safe to run again: it only
-- adds what is missing and never changes or deletes existing data.
-- Run after fixes 007 and 008 (units and bag sizes), in Supabase:
-- SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- Stock is recorded as the first active network admin (or admin),
-- so records say who entered them.
create temp table seed_user on commit drop as
  select user_id from public.users
  where status = 'active' and role in ('network_admin', 'admin')
  order by role desc -- 'network_admin' sorts before 'admin'
  limit 1;

-- store: what the central store holds after supplying the schools.
-- per_school: each school's opening stock; school_reorder: its warning level.
-- pack: kg per bag (litres per jerrycan for oil). Amounts are whole
-- bags: maize's 1800 kg in the store is 20 bags of 90 kg.
create temp table staples on commit drop as
select * from (values
  -- food,              unit,     store reorder, store, per school, school reorder, pack
  ('Maize',             'kg',     270,           1800,  180,        45,             90),
  ('Maize flour',       'kg',     200,           1000,  100,        25,             50),
  ('Rice',              'kg',     200,           1000,  100,        25,             50),
  ('Beans',             'kg',     180,            900,   90,        20,             90),
  ('Green grams',       'kg',      90,            450,   90,        20,             90),
  ('Lentils',           'kg',      50,            300,   50,        10,             50),
  ('Sorghum',           'kg',      90,            450,   90,        20,             90),
  ('Millet flour',      'kg',      50,            400,   50,        10,             50),
  ('Wheat flour',       'kg',      50,            400,   50,        10,             50),
  ('Porridge flour',    'kg',      75,            600,   50,        10,             25),
  ('Cooking oil',       'litres',  40,            200,   20,         5,             20),
  ('Salt',              'kg',      50,            250,   50,         5,             50)
) as v(item_name, unit, store_reorder, store, per_school, school_reorder, pack);

insert into food_items (item_name, unit, reorder_level, pack_size)
select item_name, unit, store_reorder, pack from staples
on conflict do nothing;

-- One dispatch per school and staple, for schools that don't stock
-- it yet and aren't already waiting for a delivery of it.
create temp table seed_dispatches on commit drop as
select sc.school_id, f.food_id, st.per_school, st.school_reorder
from staples st
join food_items f on lower(f.item_name) = lower(st.item_name)
cross join schools sc
where not exists (select 1 from inventory_items i
                  where i.school_id = sc.school_id and i.food_id = f.food_id)
  and not exists (select 1 from food_distribution d
                  where d.school_id = sc.school_id and d.food_id = f.food_id
                    and d.status = 'in_transit');

-- Delivery into the central store: enough for the dispatches, leaving
-- at least the "store" amount. Only for staples being dispatched, so
-- running the script again delivers nothing.
insert into central_transactions (food_id, transaction_type, quantity, transaction_date, recorded_by)
select f.food_id, 'received',
       greatest(n.needed + st.store - f.quantity_available, n.needed),
       (now() at time zone 'Africa/Nairobi')::date - 3,
       (select user_id from seed_user)
from (select food_id, sum(per_school) as needed from seed_dispatches group by food_id) n
join food_items f on f.food_id = n.food_id
join staples st on lower(st.item_name) = lower(f.item_name)
where greatest(n.needed + st.store - f.quantity_available, n.needed) > 0;

-- Inserting a dispatch takes the food out of the central store.
create temp table new_dispatches (distribution_id uuid, school_id uuid, food_id uuid) on commit drop;
with sent as (
  insert into food_distribution (school_id, food_id, quantity_dispatched, dispatch_date, dispatched_by)
  select school_id, food_id, per_school, (now() at time zone 'Africa/Nairobi')::date - 2,
         (select user_id from seed_user)
  from seed_dispatches
  returning distribution_id, school_id, food_id
)
insert into new_dispatches select * from sent;

-- Confirm them in full, as receive_distribution() would.
insert into inventory_items (school_id, food_id, reorder_level)
select school_id, food_id, school_reorder from seed_dispatches
on conflict (school_id, food_id) do nothing;

update food_distribution d
set status = 'received', quantity_received = d.quantity_dispatched,
    received_date = d.dispatch_date + 1, received_by = d.dispatched_by
from new_dispatches n
where d.distribution_id = n.distribution_id;

insert into inventory_transactions
    (item_id, transaction_type, quantity, transaction_date, distribution_id, recorded_by)
select i.item_id, 'received', d.quantity_received, d.received_date, d.distribution_id, d.received_by
from new_dispatches n
join food_distribution d on d.distribution_id = n.distribution_id
join inventory_items i on i.school_id = n.school_id and i.food_id = n.food_id;

commit;

-- The central store's stock of each staple (shown in the results panel).
select f.item_name as food, f.unit, f.quantity_available as in_store,
       count(i.item_id) as schools_stocking
from food_items f
left join inventory_items i on i.food_id = f.food_id
group by f.food_id
order by f.item_name;
