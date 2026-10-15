-- ============================================================
-- Fix 003: support a network of schools
--
-- Adds a schools table and a school_id on every record, so each
-- school's students, readers, stock, attendance, distributions,
-- reports and scan logs are kept separate. All existing data is
-- moved into the first school, "Jasiri School".
--
--   * New role 'network_admin' sees and manages every school.
--     admin / coordinator / inventory_officer only see their own.
--   * Each school holds its own stock.
--   * Each school has its own meal serving windows and timezone
--     (defaults: breakfast 06:00-07:00, lunch 12:00-14:00,
--     supper 18:00-20:00, Africa/Nairobi). A null window means the
--     school does not serve that meal.
--   * Each staff member belongs to one school (users.school_id).
--
-- Attendance, distributions and stock movements take their
-- school_id from the beneficiary or item automatically, so the
-- app never sends it and records can't be filed under the wrong
-- school. record_nfc_scan() keeps the same signature, so readers
-- need no change; it now only accepts cards and items from the
-- reader's own school.
--
-- Safe to run on a live database: it keeps all data. It runs as
-- one transaction, so if anything fails nothing is changed.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- SCHOOLS
-- ------------------------------------------------------------
create table if not exists schools (
  school_id uuid primary key default gen_random_uuid(),
  name text not null unique,
  location text,
  timezone text not null default 'Africa/Nairobi',
  breakfast_start time default '06:00',
  breakfast_end time default '07:00',
  lunch_start time default '12:00',
  lunch_end time default '14:00',
  supper_start time default '18:00',
  supper_end time default '20:00',
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  constraint breakfast_window check (
    (breakfast_start is null) = (breakfast_end is null) and
    (breakfast_start is null or breakfast_start < breakfast_end)),
  constraint lunch_window check (
    (lunch_start is null) = (lunch_end is null) and
    (lunch_start is null or lunch_start < lunch_end)),
  constraint supper_window check (
    (supper_start is null) = (supper_end is null) and
    (supper_start is null or supper_start < supper_end))
);

insert into schools (name) values ('Jasiri School') on conflict (name) do nothing;

-- ------------------------------------------------------------
-- school_id columns, back-filled with Jasiri School
-- ------------------------------------------------------------
alter table users add column if not exists school_id uuid references schools(school_id);
alter table beneficiaries add column if not exists school_id uuid references schools(school_id);
alter table nfc_devices add column if not exists school_id uuid references schools(school_id);
alter table inventory_items add column if not exists school_id uuid references schools(school_id);
alter table inventory_transactions add column if not exists school_id uuid references schools(school_id);
alter table meal_attendance add column if not exists school_id uuid references schools(school_id);
alter table food_distribution add column if not exists school_id uuid references schools(school_id);
alter table reports add column if not exists school_id uuid references schools(school_id); -- null = network-wide
alter table nfc_tag_logs add column if not exists school_id uuid references schools(school_id); -- null = unknown reader

do $$
declare
  v_jasiri uuid := (select school_id from schools where name = 'Jasiri School');
begin
  update users set school_id = v_jasiri where school_id is null and role <> 'network_admin';
  update beneficiaries set school_id = v_jasiri where school_id is null;
  update nfc_devices set school_id = v_jasiri where school_id is null;
  update inventory_items set school_id = v_jasiri where school_id is null;
  update inventory_transactions set school_id = v_jasiri where school_id is null;
  update meal_attendance set school_id = v_jasiri where school_id is null;
  update food_distribution set school_id = v_jasiri where school_id is null;
  update reports set school_id = v_jasiri where school_id is null;
  update nfc_tag_logs l set school_id = d.school_id
    from nfc_devices d where l.device_id = d.device_id and l.school_id is null;
end $$;

alter table beneficiaries alter column school_id set not null;
alter table nfc_devices alter column school_id set not null;
alter table inventory_items alter column school_id set not null;
alter table inventory_transactions alter column school_id set not null;
alter table meal_attendance alter column school_id set not null;
alter table food_distribution alter column school_id set not null;

create index if not exists idx_beneficiaries_school on beneficiaries(school_id);
create index if not exists idx_inventory_items_school on inventory_items(school_id);
create index if not exists idx_meal_attendance_school_date on meal_attendance(school_id, attendance_date);
create index if not exists idx_food_distribution_school_date on food_distribution(school_id, distribution_date);

-- Admission numbers are unique within a school, not across the network.
-- (NFC card IDs stay unique network-wide: a card is one physical object.)
alter table beneficiaries drop constraint if exists beneficiaries_admission_no_key;
alter table beneficiaries drop constraint if exists beneficiaries_school_admission_no_key;
alter table beneficiaries add constraint beneficiaries_school_admission_no_key unique (school_id, admission_no);

-- network_admin role. Staff without a school (e.g. a login just
-- created in the dashboard) can sign in but see nothing until assigned.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('network_admin', 'admin', 'coordinator', 'inventory_officer'));

-- ------------------------------------------------------------
-- Keep school_id consistent with the record it belongs to
-- ------------------------------------------------------------
create or replace function public.set_school_from_beneficiary()
returns trigger as $$
begin
  select school_id into new.school_id from beneficiaries where beneficiary_id = new.beneficiary_id;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create or replace function public.set_school_from_item()
returns trigger as $$
begin
  select school_id into new.school_id from inventory_items where item_id = new.item_id;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- A distribution must use food from the beneficiary's own school.
create or replace function public.set_distribution_school()
returns trigger as $$
begin
  select school_id into new.school_id from beneficiaries where beneficiary_id = new.beneficiary_id;
  if not exists (select 1 from inventory_items
                 where item_id = new.item_id and school_id = new.school_id) then
    raise exception 'This food item belongs to a different school than the beneficiary';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists set_meal_attendance_school on meal_attendance;
create trigger set_meal_attendance_school
  before insert or update of beneficiary_id on meal_attendance
  for each row execute procedure public.set_school_from_beneficiary();

drop trigger if exists set_food_distribution_school on food_distribution;
create trigger set_food_distribution_school
  before insert or update of beneficiary_id, item_id on food_distribution
  for each row execute procedure public.set_distribution_school();

drop trigger if exists set_inventory_transaction_school on inventory_transactions;
create trigger set_inventory_transaction_school
  before insert or update of item_id on inventory_transactions
  for each row execute procedure public.set_school_from_item();

-- ------------------------------------------------------------
-- Access helpers
-- ------------------------------------------------------------
create or replace function public.is_network_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active' and role = 'network_admin'
  );
$$;

-- Can the current user see this school's data?
create or replace function public.can_view_school(p_school_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active'
      and (role = 'network_admin' or school_id = p_school_id)
  );
$$;

-- Does the current user hold one of these roles at this school?
-- Network admins pass for every school.
create or replace function public.has_school_role(p_school_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active'
      and (role = 'network_admin' or (school_id = p_school_id and role = any(p_roles)))
  );
$$;

revoke all on function public.is_network_admin() from public;
revoke all on function public.can_view_school(uuid) from public;
revoke all on function public.has_school_role(uuid, text[]) from public;
grant execute on function public.is_network_admin() to anon, authenticated;
grant execute on function public.can_view_school(uuid) to anon, authenticated;
grant execute on function public.has_school_role(uuid, text[]) to anon, authenticated;

-- ------------------------------------------------------------
-- Row-level security, per school
-- ------------------------------------------------------------
alter table schools enable row level security;

drop policy if exists "Users can read own profile" on users;
drop policy if exists "Authenticated users can read beneficiaries" on beneficiaries;
drop policy if exists "Coordinators can manage beneficiaries" on beneficiaries;
drop policy if exists "Authenticated users can read devices" on nfc_devices;
drop policy if exists "Admins can manage devices" on nfc_devices;
drop policy if exists "Authenticated users can read inventory items" on inventory_items;
drop policy if exists "Inventory officers can manage items" on inventory_items;
drop policy if exists "Authenticated users can read inventory transactions" on inventory_transactions;
drop policy if exists "Inventory officers can record transactions" on inventory_transactions;
drop policy if exists "Authenticated users can read attendance" on meal_attendance;
drop policy if exists "Coordinators can manage attendance" on meal_attendance;
drop policy if exists "Authenticated users can read distributions" on food_distribution;
drop policy if exists "Coordinators can record distributions" on food_distribution;
drop policy if exists "Authenticated users can read reports" on reports;
drop policy if exists "Coordinators can manage reports" on reports;
drop policy if exists "Admins can read NFC audit logs" on nfc_tag_logs;
drop function if exists public.has_any_role(text[]);

drop policy if exists "Staff can read their school" on schools;
drop policy if exists "School admins can update their school" on schools;
drop policy if exists "Network admins can add schools" on schools;
drop policy if exists "Network admins can remove schools" on schools;
create policy "Staff can read their school"
  on schools for select using (public.can_view_school(school_id));
create policy "School admins can update their school"
  on schools for update
  using (public.has_school_role(school_id, array['admin']))
  with check (public.has_school_role(school_id, array['admin']));
create policy "Network admins can add schools"
  on schools for insert with check (public.is_network_admin());
create policy "Network admins can remove schools"
  on schools for delete using (public.is_network_admin());

drop policy if exists "Users can read own profile and admins their school" on users;
create policy "Users can read own profile and admins their school"
  on users for select
  using (user_id = auth.uid() or public.has_school_role(school_id, array['admin']));

drop policy if exists "Staff can read their school's beneficiaries" on beneficiaries;
drop policy if exists "Coordinators can manage their school's beneficiaries" on beneficiaries;
create policy "Staff can read their school's beneficiaries"
  on beneficiaries for select using (public.can_view_school(school_id));
create policy "Coordinators can manage their school's beneficiaries"
  on beneficiaries for all
  using (public.has_school_role(school_id, array['admin', 'coordinator']))
  with check (public.has_school_role(school_id, array['admin', 'coordinator']));

drop policy if exists "Staff can read their school's devices" on nfc_devices;
drop policy if exists "Admins can manage their school's devices" on nfc_devices;
create policy "Staff can read their school's devices"
  on nfc_devices for select using (public.can_view_school(school_id));
create policy "Admins can manage their school's devices"
  on nfc_devices for all
  using (public.has_school_role(school_id, array['admin']))
  with check (public.has_school_role(school_id, array['admin']));

drop policy if exists "Staff can read their school's inventory items" on inventory_items;
drop policy if exists "Inventory officers can manage their school's items" on inventory_items;
create policy "Staff can read their school's inventory items"
  on inventory_items for select using (public.can_view_school(school_id));
create policy "Inventory officers can manage their school's items"
  on inventory_items for all
  using (public.has_school_role(school_id, array['admin', 'inventory_officer']))
  with check (public.has_school_role(school_id, array['admin', 'inventory_officer']));
-- quantity_available only changes through transactions; items can't move between schools.
revoke insert, update, delete on inventory_items from authenticated;
grant insert (school_id, item_name, unit, reorder_level) on inventory_items to authenticated;
grant update (item_name, unit, reorder_level) on inventory_items to authenticated;

drop policy if exists "Staff can read their school's inventory transactions" on inventory_transactions;
drop policy if exists "Inventory officers can record their school's transactions" on inventory_transactions;
create policy "Staff can read their school's inventory transactions"
  on inventory_transactions for select using (public.can_view_school(school_id));
create policy "Inventory officers can record their school's transactions"
  on inventory_transactions for insert
  with check (public.has_school_role(school_id, array['admin', 'inventory_officer']));

drop policy if exists "Staff can read their school's attendance" on meal_attendance;
drop policy if exists "Coordinators can manage their school's attendance" on meal_attendance;
create policy "Staff can read their school's attendance"
  on meal_attendance for select using (public.can_view_school(school_id));
create policy "Coordinators can manage their school's attendance"
  on meal_attendance for all
  using (public.has_school_role(school_id, array['admin', 'coordinator']))
  with check (public.has_school_role(school_id, array['admin', 'coordinator']));

drop policy if exists "Staff can read their school's distributions" on food_distribution;
drop policy if exists "Coordinators can record their school's distributions" on food_distribution;
create policy "Staff can read their school's distributions"
  on food_distribution for select using (public.can_view_school(school_id));
create policy "Coordinators can record their school's distributions"
  on food_distribution for insert
  with check (public.has_school_role(school_id, array['admin', 'coordinator']));

-- A null school_id is a network-wide report, visible to network admins only.
drop policy if exists "Staff can read their school's reports" on reports;
drop policy if exists "Coordinators can manage their school's reports" on reports;
create policy "Staff can read their school's reports"
  on reports for select using (public.can_view_school(school_id));
create policy "Coordinators can manage their school's reports"
  on reports for all
  using (public.has_school_role(school_id, array['admin', 'coordinator']))
  with check (public.has_school_role(school_id, array['admin', 'coordinator']));

-- Logs from unknown readers (null school_id) are visible to network admins only.
drop policy if exists "Admins can read their school's NFC audit logs" on nfc_tag_logs;
create policy "Admins can read their school's NFC audit logs"
  on nfc_tag_logs for select using (public.has_school_role(school_id, array['admin']));

-- ------------------------------------------------------------
-- New logins start with no school; assign one in the users table.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (user_id, username, full_name, role)
  values (
    new.id,
    new.raw_user_meta_data->>'username',
    coalesce(new.raw_user_meta_data->>'full_name', 'New User'),
    'coordinator'
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- ------------------------------------------------------------
-- record_nfc_scan(): same signature, now school-aware
-- ------------------------------------------------------------
create or replace function record_nfc_scan(
  p_nfc_tag_id text,
  p_device_id text,
  p_mode text default 'attendance', -- 'attendance' or 'distribution'
  p_item_id uuid default null,      -- required when p_mode = 'distribution'
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

  if p_mode is null or p_mode not in ('attendance', 'distribution') then
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

  if p_mode = 'distribution' then
    if p_item_id is null or p_quantity is null or p_quantity <= 0
      or not exists (select 1 from inventory_items
                     where item_id = p_item_id and school_id = v_school.school_id) then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'invalid_distribution');
      return json_build_object('success', false, 'error', 'invalid_distribution');
    end if;

    begin
    insert into food_distribution (beneficiary_id, item_id, device_id, quantity_issued)
      values (v_beneficiary.beneficiary_id, p_item_id, p_device_id, p_quantity);
    exception when check_violation then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'insufficient_stock');
      return json_build_object('success', false, 'error', 'insufficient_stock');
    end;
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'distribution_recorded');
  else
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
  end if;

  return json_build_object('success', true, 'first_name', split_part(v_beneficiary.full_name, ' ', 1));
end;
$$;

grant execute on function record_nfc_scan(text, text, text, uuid, numeric) to anon, authenticated;

commit;
