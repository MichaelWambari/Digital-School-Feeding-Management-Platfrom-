-- ============================================================
-- Fix 004: central store, dispatches and food used per meal
--
-- Food now flows from the network's central store to schools:
--
--   supplier --received--> central store --dispatch--> school
--   store --food used at breakfast/lunch/supper-->
--
--   * food_items: the network's food list (kept by the network
--     admin) and the central store's stock of each food.
--   * central_transactions: deliveries into the store, write-offs,
--     and dispatches out of it.
--   * food_distribution now holds dispatches from the store to a
--     school, "in transit" until the school confirms how much
--     arrived (receive_distribution()). The network admin can
--     cancel a dispatch still in transit (cancel_distribution()).
--   * food_consumption: food a school used at one meal, recorded
--     in bulk after the meal. It replaces issuing a portion to each
--     student, and NFC readers no longer issue food (only
--     attendance).
--   * inventory_items now points at a food in food_items instead
--     of having its own name and unit. Schools get an item when
--     they first receive that food.
--   * Network admins can view every school but no longer change
--     students, attendance, school stock or food used; each
--     school's own staff do that.
--
-- Existing data is kept and converted:
--   * Every school food item becomes a food in the food list
--     (matched by name, ignoring case). The central store starts
--     empty: record a delivery in the app's Inventory screen.
--   * Food issued to students is added up into food used per
--     school, food, day and meal. Old records don't say which meal,
--     so each is filed under the meal whose serving window it was
--     recorded in, or lunch if none. Per-student portions and the
--     reader that recorded them are not kept.
--
-- Run it once, after fixes 001-003. It runs as one transaction,
-- so if anything fails nothing is changed.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.food_items') is not null then
    raise exception 'Fix 004 has already been applied to this database.';
  end if;
  if exists (select 1 from inventory_items
             group by school_id, lower(btrim(item_name)) having count(*) > 1) then
    raise exception 'A school has two food items with the same name. Rename or remove one in the Table Editor (inventory_items), then run this fix again.';
  end if;
  if exists (select 1 from inventory_items
             group by lower(btrim(item_name))
             having count(distinct coalesce(nullif(btrim(unit), ''), 'kg')) > 1) then
    raise exception 'The same food is measured in different units at different schools (inventory_items.unit). Make the units match, then run this fix again.';
  end if;
end $$;

-- ------------------------------------------------------------
-- FOOD_ITEMS: the food list, built from the schools' items
-- ------------------------------------------------------------
create table food_items (
  food_id uuid primary key default gen_random_uuid(),
  item_name text not null,
  unit text not null default 'kg',
  quantity_available numeric not null default 0, -- central store stock
  reorder_level numeric not null default 0,       -- low-stock warning for the central store
  created_at timestamptz default now()
);

create unique index food_items_name_key on food_items (lower(item_name));

insert into food_items (item_name, unit)
select distinct on (lower(btrim(item_name))) btrim(item_name), coalesce(nullif(btrim(unit), ''), 'kg')
from inventory_items
order by lower(btrim(item_name)), created_at;

alter table inventory_items add column food_id uuid references food_items(food_id);
update inventory_items i set food_id = f.food_id
  from food_items f where lower(f.item_name) = lower(btrim(i.item_name));
alter table inventory_items alter column food_id set not null;
alter table inventory_items
  add constraint inventory_items_school_food_key unique (school_id, food_id);
alter table inventory_items drop column item_name, drop column unit;

-- ------------------------------------------------------------
-- FOOD_CONSUMPTION, filled from the old per-student distributions
-- (before its stock trigger exists, as that stock is already used)
-- ------------------------------------------------------------
create table food_consumption (
  consumption_id uuid primary key default gen_random_uuid(),
  item_id uuid not null references inventory_items(item_id),
  school_id uuid not null references schools(school_id), -- copied from the item by trigger
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'supper')),
  consumption_date date not null default current_date,
  quantity numeric not null check (quantity > 0),
  recorded_by uuid references users(user_id),
  created_at timestamptz default now()
);

create index idx_food_consumption_school_date on food_consumption(school_id, consumption_date);

insert into food_consumption (item_id, school_id, meal_type, consumption_date, quantity, recorded_by, created_at)
select item_id, school_id, meal_type, distribution_date, sum(quantity_issued),
       (array_agg(recorded_by order by created_at))[1], min(created_at)
from (
  select d.*,
         case
           when t >= s.breakfast_start and t < s.breakfast_end then 'breakfast'
           when t >= s.supper_start and t < s.supper_end then 'supper'
           else 'lunch'
         end as meal_type
  from food_distribution d
  join schools s on s.school_id = d.school_id
  cross join lateral (select (d.created_at at time zone s.timezone)::time as t) local_time
) old
group by item_id, school_id, meal_type, distribution_date;

-- ------------------------------------------------------------
-- FOOD_DISTRIBUTION becomes dispatches from the central store
-- ------------------------------------------------------------
drop table food_distribution cascade;
drop function if exists public.log_distribution_as_transaction();
drop function if exists public.set_distribution_school();

-- ------------------------------------------------------------
-- FOOD_DISTRIBUTION
-- A dispatch of one food from the central store to a school.
-- Dispatching takes the stock out of the central store at once;
-- the food is "in transit" until the school confirms how much
-- actually arrived (receive_distribution() below), which adds
-- that amount to the school's stock. Any shortfall stays on
-- record for the network admin.
-- ------------------------------------------------------------
create table food_distribution (
  distribution_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id),
  food_id uuid not null references food_items(food_id),
  quantity_dispatched numeric not null check (quantity_dispatched > 0),
  dispatch_date date not null default current_date,
  dispatched_by uuid references users(user_id),
  status text not null default 'in_transit' check (status in ('in_transit', 'received', 'cancelled')),
  quantity_received numeric check (quantity_received >= 0 and quantity_received <= quantity_dispatched),
  received_date date,
  received_by uuid references users(user_id),
  created_at timestamptz default now(),
  constraint received_has_quantity check ((status = 'received') = (quantity_received is not null))
);

create index idx_food_distribution_school_date on food_distribution(school_id, dispatch_date);

-- ------------------------------------------------------------
-- CENTRAL_TRANSACTIONS
-- Every movement in or out of the central store: deliveries from
-- suppliers ('received'), losses and corrections ('written_off'),
-- dispatches to schools ('dispatched') and cancelled dispatches
-- coming back ('returned'). The last two are added automatically.
-- ------------------------------------------------------------
create table central_transactions (
  transaction_id uuid primary key default gen_random_uuid(),
  food_id uuid not null references food_items(food_id) on delete cascade,
  transaction_type text not null
    check (transaction_type in ('received', 'written_off', 'dispatched', 'returned')),
  quantity numeric not null check (quantity > 0),
  transaction_date date default current_date,
  distribution_id uuid references food_distribution(distribution_id), -- set for dispatched/returned
  recorded_by uuid references users(user_id),
  created_at timestamptz default now()
);

create function public.apply_central_transaction()
returns trigger as $$
begin
  if new.transaction_type in ('received', 'returned') then
    update food_items set quantity_available = quantity_available + new.quantity
      where food_id = new.food_id;
  else
    update food_items set quantity_available = quantity_available - new.quantity
      where food_id = new.food_id and quantity_available >= new.quantity;
    if not found then
      raise exception 'Insufficient central stock for food %', new.food_id
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create trigger on_central_transaction_insert
  after insert on central_transactions
  for each row execute procedure public.apply_central_transaction();

-- Dispatching takes the food out of the central store (and is
-- rejected if the store doesn't have enough).
create function public.log_dispatch_as_central_transaction()
returns trigger as $$
begin
  insert into central_transactions
      (food_id, transaction_type, quantity, transaction_date, distribution_id, recorded_by)
    values (new.food_id, 'dispatched', new.quantity_dispatched, new.dispatch_date,
            new.distribution_id, new.dispatched_by);
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create trigger on_food_distribution_insert
  after insert on food_distribution
  for each row execute procedure public.log_dispatch_as_central_transaction();
-- ------------------------------------------------------------
-- School stock movements link to what caused them
-- ------------------------------------------------------------
alter table inventory_transactions
  add column distribution_id uuid references food_distribution(distribution_id),
  add column consumption_id uuid references food_consumption(consumption_id);

-- Recording food used at a meal takes it out of the school's
-- stock (and is rejected if the school doesn't have enough).
create function public.log_consumption_as_transaction()
returns trigger as $$
begin
  insert into inventory_transactions
      (item_id, transaction_type, quantity, transaction_date, consumption_id, recorded_by)
    values (new.item_id, 'used', new.quantity, new.consumption_date,
            new.consumption_id, new.recorded_by);
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create trigger on_food_consumption_insert
  after insert on food_consumption
  for each row execute procedure public.log_consumption_as_transaction();
create trigger set_food_consumption_school
  before insert or update of item_id on food_consumption
  for each row execute procedure public.set_school_from_item();

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Network admins view schools but no longer pass school role
-- checks; they keep the network-level rights they need.
-- ------------------------------------------------------------
create or replace function public.has_school_role(p_school_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active'
      and school_id = p_school_id and role = any(p_roles)
  );
$$;

alter table food_items enable row level security;
alter table food_distribution enable row level security;
alter table central_transactions enable row level security;
alter table food_consumption enable row level security;

drop policy if exists "School admins can update their school" on schools;
create policy "Admins can update their school"
  on schools for update
  using (public.has_school_role(school_id, array['admin']) or public.is_network_admin())
  with check (public.has_school_role(school_id, array['admin']) or public.is_network_admin());

drop policy if exists "Users can read own profile and admins their school" on users;
create policy "Users can read own profile and admins their school"
  on users for select
  using (user_id = auth.uid() or public.has_school_role(school_id, array['admin'])
         or public.is_network_admin());

drop policy if exists "Admins can manage their school's devices" on nfc_devices;
create policy "Admins can manage their school's devices"
  on nfc_devices for all
  using (public.has_school_role(school_id, array['admin']) or public.is_network_admin())
  with check (public.has_school_role(school_id, array['admin']) or public.is_network_admin());

-- Every signed-in user can read the food list; the network admin keeps it.
create policy "Signed-in users can read the food list"
  on food_items for select using (auth.uid() is not null);
create policy "Network admins can manage the food list"
  on food_items for all
  using (public.is_network_admin()) with check (public.is_network_admin());
-- quantity_available only changes through central_transactions.
revoke insert, update on food_items from authenticated;
grant insert (item_name, unit, reorder_level) on food_items to authenticated;
grant update (item_name, unit, reorder_level) on food_items to authenticated;

create policy "Network admins can read central store movements"
  on central_transactions for select using (public.is_network_admin());
-- Dispatches and returns are added automatically, not by hand.
create policy "Network admins can record deliveries and write-offs"
  on central_transactions for insert
  with check (public.is_network_admin() and transaction_type in ('received', 'written_off'));

-- Deliveries are confirmed or cancelled through receive_distribution()
-- and cancel_distribution() below, never by editing rows directly.
create policy "Staff can read their school's deliveries"
  on food_distribution for select using (public.can_view_school(school_id));
create policy "Network admins can dispatch food"
  on food_distribution for insert with check (public.is_network_admin());
revoke insert, update, delete on food_distribution from authenticated;
grant insert (school_id, food_id, quantity_dispatched, dispatch_date, dispatched_by)
  on food_distribution to authenticated;

drop policy if exists "Inventory officers can manage their school's items" on inventory_items;
create policy "Inventory officers can set their school's reorder levels"
  on inventory_items for update
  using (public.has_school_role(school_id, array['admin', 'inventory_officer']))
  with check (public.has_school_role(school_id, array['admin', 'inventory_officer']));
revoke insert, update, delete on inventory_items from authenticated;
grant update (reorder_level) on inventory_items to authenticated;

create policy "Staff can read their school's food used"
  on food_consumption for select using (public.can_view_school(school_id));
create policy "School staff can record food used"
  on food_consumption for insert
  with check (public.has_school_role(school_id, array['admin', 'coordinator', 'inventory_officer']));

-- Stock movements are only added by triggers and functions now.
drop policy if exists "Inventory officers can record their school's transactions" on inventory_transactions;

drop policy if exists "Coordinators can manage their school's reports" on reports;
create policy "Coordinators can manage their school's reports"
  on reports for all
  using (public.has_school_role(school_id, array['admin', 'coordinator']) or public.is_network_admin())
  with check (public.has_school_role(school_id, array['admin', 'coordinator']) or public.is_network_admin());

drop policy if exists "Admins can read their school's NFC audit logs" on nfc_tag_logs;
create policy "Admins can read their school's NFC audit logs"
  on nfc_tag_logs for select
  using (public.has_school_role(school_id, array['admin']) or public.is_network_admin());

-- ------------------------------------------------------------
-- receive_distribution(): a school confirms a delivery from the
-- central store, giving the amount that actually arrived (at most
-- the amount sent). That amount is added to the school's stock.
-- ------------------------------------------------------------
create function public.receive_distribution(p_distribution_id uuid, p_quantity_received numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dispatch food_distribution%rowtype;
  v_item_id uuid;
  v_today date;
begin
  select * into v_dispatch from food_distribution
    where distribution_id = p_distribution_id for update;
  if not found or not public.can_view_school(v_dispatch.school_id) then
    raise exception 'Delivery not found' using errcode = 'P0002';
  end if;
  if not public.has_school_role(v_dispatch.school_id, array['admin', 'inventory_officer']) then
    raise exception 'Only the school''s admin or inventory officer can confirm deliveries'
      using errcode = '42501';
  end if;
  if v_dispatch.status <> 'in_transit' then
    raise exception 'This delivery is already %', replace(v_dispatch.status, '_', ' ')
      using errcode = '22023';
  end if;
  if p_quantity_received is null or p_quantity_received < 0
     or p_quantity_received > v_dispatch.quantity_dispatched then
    raise exception 'The amount received must be between 0 and %', v_dispatch.quantity_dispatched
      using errcode = '22023';
  end if;

  v_today := (now() at time zone (select timezone from schools
                                  where school_id = v_dispatch.school_id))::date;

  insert into inventory_items (school_id, food_id)
    values (v_dispatch.school_id, v_dispatch.food_id)
    on conflict (school_id, food_id) do nothing;
  select item_id into v_item_id from inventory_items
    where school_id = v_dispatch.school_id and food_id = v_dispatch.food_id;

  update food_distribution
    set status = 'received', quantity_received = p_quantity_received,
        received_date = v_today, received_by = auth.uid()
    where distribution_id = p_distribution_id;

  if p_quantity_received > 0 then
    insert into inventory_transactions
        (item_id, transaction_type, quantity, transaction_date, distribution_id, recorded_by)
      values (v_item_id, 'received', p_quantity_received, v_today, p_distribution_id, auth.uid());
  end if;
end;
$$;

-- ------------------------------------------------------------
-- cancel_distribution(): the network admin cancels a dispatch
-- that is still in transit; its food goes back into the store.
-- ------------------------------------------------------------
create function public.cancel_distribution(p_distribution_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dispatch food_distribution%rowtype;
begin
  if not public.is_network_admin() then
    raise exception 'Only network admins can cancel a dispatch' using errcode = '42501';
  end if;
  select * into v_dispatch from food_distribution
    where distribution_id = p_distribution_id for update;
  if not found then
    raise exception 'Dispatch not found' using errcode = 'P0002';
  end if;
  if v_dispatch.status <> 'in_transit' then
    raise exception 'This delivery is already %', replace(v_dispatch.status, '_', ' ')
      using errcode = '22023';
  end if;

  update food_distribution set status = 'cancelled' where distribution_id = p_distribution_id;
  insert into central_transactions
      (food_id, transaction_type, quantity, distribution_id, recorded_by)
    values (v_dispatch.food_id, 'returned', v_dispatch.quantity_dispatched,
            p_distribution_id, auth.uid());
end;
$$;

revoke all on function public.receive_distribution(uuid, numeric) from public;
revoke all on function public.cancel_distribution(uuid) from public;
grant execute on function public.receive_distribution(uuid, numeric) to authenticated;
grant execute on function public.cancel_distribution(uuid) to authenticated;
-- ------------------------------------------------------------
-- record_nfc_scan(): the single endpoint the ESP32 calls.
-- A card tap records the student's attendance at the current
-- meal. (Food used is recorded per meal in bulk, in
-- food_consumption, not per tap.) Every call is logged to
-- nfc_tag_logs regardless of outcome, so a misbehaving reader or
-- an unregistered card leaves a trace to investigate.
-- The reader's school decides everything: only that school's
-- cards are accepted ('wrong_school' otherwise),
-- and attendance scans are filed under the meal whose serving
-- window (in schools, school local time) they fall in. Scans
-- outside every window are rejected with 'outside_meal_time'.
-- ------------------------------------------------------------
create or replace function record_nfc_scan(
  p_nfc_tag_id text,
  p_device_id text,
  -- Readers used to issue food per tap too. Only 'attendance' is
  -- accepted now; the unused parameters keep older readers working.
  p_mode text default 'attendance',
  p_item_id uuid default null,
  p_quantity numeric default 1
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device nfc_devices%rowtype;
  v_school schools%rowtype;
  v_beneficiary beneficiaries%rowtype;
  v_local_now timestamp;
  v_time time;
  v_meal_type text;
begin
  if p_nfc_tag_id is null or btrim(p_nfc_tag_id) = '' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'invalid_tag');
    return json_build_object('success', false, 'error', 'invalid_tag');
  end if;

  select * into v_device from nfc_devices where device_id = p_device_id;
  if not found or v_device.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_device.school_id, 'inactive_device');
    return json_build_object('success', false, 'error', 'unregistered_or_inactive_device');
  end if;

  select * into v_school from schools where school_id = v_device.school_id;
  if v_school.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'inactive_school');
    return json_build_object('success', false, 'error', 'inactive_school');
  end if;

  if p_mode is null or p_mode <> 'attendance' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'invalid_mode');
    return json_build_object('success', false, 'error', 'invalid_mode');
  end if;

  select * into v_beneficiary from beneficiaries where nfc_tag_id = p_nfc_tag_id;
  if not found then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'unknown_tag');
    return json_build_object('success', false, 'error', 'unknown_tag');
  end if;

  if v_beneficiary.school_id <> v_school.school_id then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'wrong_school');
    return json_build_object('success', false, 'error', 'wrong_school');
  end if;

  if v_beneficiary.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'not_eligible');
    return json_build_object('success', false, 'error', 'not_eligible');
  end if;

  -- The meal is decided by the school's serving window the scan falls in
  -- (school local time, end time exclusive). A null window = meal not served.
  v_local_now := now() at time zone v_school.timezone;
  v_time := v_local_now::time;
  v_meal_type := case
    when v_time >= v_school.breakfast_start and v_time < v_school.breakfast_end then 'breakfast'
    when v_time >= v_school.lunch_start and v_time < v_school.lunch_end then 'lunch'
    when v_time >= v_school.supper_start and v_time < v_school.supper_end then 'supper'
  end;
  if v_meal_type is null then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'outside_meal_time');
    return json_build_object('success', false, 'error', 'outside_meal_time');
  end if;

  insert into meal_attendance
      (beneficiary_id, nfc_tag_id, device_id, meal_type, attendance_date, status)
    values (v_beneficiary.beneficiary_id, p_nfc_tag_id, p_device_id,
            v_meal_type, v_local_now::date, 'present')
    on conflict (beneficiary_id, attendance_date, meal_type) do nothing;
  insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
    values (p_nfc_tag_id, p_device_id, v_school.school_id, 'attendance_recorded');

  return json_build_object('success', true, 'first_name', split_part(v_beneficiary.full_name, ' ', 1));
end;
$$;

grant execute on function record_nfc_scan(text, text, text, uuid, numeric) to anon, authenticated;

commit;
