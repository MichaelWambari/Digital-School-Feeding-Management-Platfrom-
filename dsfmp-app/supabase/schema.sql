-- ============================================================
-- DSFMP Database Schema for Supabase (PostgreSQL)
-- Updated to match the expanded ERD (Users, Beneficiaries,
-- NFC_Devices, Inventory_Items, Inventory_Transactions,
-- Meal_Attendance, Food_Distribution, Reports, NFC_Tag_Logs).
--
-- Run this in the Supabase SQL Editor: Project > SQL Editor > New query
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- DESTRUCTIVE RESET
-- This development bootstrap drops all application tables and their
-- data. Do not run it against a database whose data you need to keep.
-- ============================================================
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.has_any_role(text[]) cascade;
drop function if exists public.record_nfc_scan(text, text, text, uuid, numeric) cascade;
drop function if exists public.apply_inventory_transaction() cascade;
drop function if exists public.log_distribution_as_transaction() cascade;

drop table if exists nfc_tag_logs cascade;
drop table if exists reports cascade;
drop table if exists food_distribution cascade;
drop table if exists meal_attendance cascade;
drop table if exists inventory_transactions cascade;
drop table if exists inventory_items cascade;
drop table if exists nfc_devices cascade;
drop table if exists beneficiaries cascade;
drop table if exists users cascade;

-- earlier (pre-rename) table names from the previous schema version
drop table if exists distribution cascade;
drop table if exists attendance cascade;
drop table if exists inventory cascade;
drop table if exists devices cascade;
drop table if exists profiles cascade;

-- ------------------------------------------------------------
-- USERS (extends Supabase's built-in auth.users)
-- This is the "Users" entity from the ERD. We still rely on
-- Supabase Auth for the password itself (auth.users holds the
-- hashed password internally) rather than storing our own
-- password_hash column -- Supabase already does this correctly
-- and re-implementing it ourselves would be both extra work and
-- less secure.
-- ------------------------------------------------------------
create table users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  full_name text not null,
  role text not null check (role in ('admin', 'coordinator', 'inventory_officer')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- BENEFICIARIES
-- ------------------------------------------------------------
create table beneficiaries (
  beneficiary_id uuid primary key default gen_random_uuid(),
  full_name text not null,
  age int,
  admission_no text unique not null,
  nfc_tag_id text unique, -- the beneficiary's own card/tag UID (not a device)
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now()
);

create index idx_beneficiaries_nfc_tag_id on beneficiaries(nfc_tag_id);

-- ------------------------------------------------------------
-- NFC_DEVICES
-- The physical ESP32 + MFRC522 reader units at each serving
-- point -- NOT the beneficiaries' cards. This is an allow-list:
-- a device must exist here and be "active" before its scans are
-- accepted (see record_nfc_scan() below).
-- ------------------------------------------------------------
create table nfc_devices (
  device_id text primary key, -- e.g. 'reader-01'
  device_name text,
  location text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- INVENTORY_ITEMS
-- quantity_available is kept in sync automatically by a trigger
-- on inventory_transactions below, rather than being edited
-- directly, so the running total can never drift from the
-- transaction history that justifies it.
-- ------------------------------------------------------------
create table inventory_items (
  item_id uuid primary key default gen_random_uuid(),
  item_name text not null,
  quantity_available numeric not null default 0,
  unit text default 'kg',
  reorder_level numeric default 0, -- triggers a low-stock warning in the Inventory UI
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- INVENTORY_TRANSACTIONS
-- Every stock movement (delivery received, stock used) is
-- recorded here; quantity_available on inventory_items is a
-- derived running total, not the source of truth.
-- ------------------------------------------------------------
create table inventory_transactions (
  transaction_id uuid primary key default gen_random_uuid(),
  item_id uuid not null references inventory_items(item_id) on delete cascade,
  transaction_type text not null check (transaction_type in ('received', 'used')),
  quantity numeric not null check (quantity > 0),
  transaction_date date default current_date,
  recorded_by uuid references users(user_id),
  created_at timestamptz default now()
);

-- Keep inventory_items.quantity_available in sync with transactions
create function public.apply_inventory_transaction()
returns trigger as $$
begin
  if new.transaction_type = 'received' then
    update inventory_items set quantity_available = quantity_available + new.quantity
      where item_id = new.item_id;
  else
    update inventory_items set quantity_available = quantity_available - new.quantity
      where item_id = new.item_id and quantity_available >= new.quantity;
    if not found then
      raise exception 'Insufficient stock for inventory item %', new.item_id
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

create trigger on_inventory_transaction_insert
  after insert on inventory_transactions
  for each row execute procedure public.apply_inventory_transaction();

-- ------------------------------------------------------------
-- MEAL_ATTENDANCE
-- device_id and nfc_tag_id are both stored directly (alongside
-- beneficiary_id) so an attendance row is self-explanatory on
-- its own -- useful for the Reports module -- without always
-- requiring a join back to beneficiaries or nfc_devices.
-- ------------------------------------------------------------
create table meal_attendance (
  attendance_id uuid primary key default gen_random_uuid(),
  beneficiary_id uuid not null references beneficiaries(beneficiary_id) on delete cascade,
  nfc_tag_id text,
  device_id text references nfc_devices(device_id),
  recorded_by uuid references users(user_id), -- set when a Coordinator records it manually; null for a device-triggered scan
  meal_type text not null default 'lunch',
  attendance_date date default current_date,
  status text default 'present',
  created_at timestamptz default now()
);

create unique index idx_meal_attendance_once_per_meal
  on meal_attendance(beneficiary_id, attendance_date, meal_type);

-- ------------------------------------------------------------
-- FOOD_DISTRIBUTION
-- ------------------------------------------------------------
create table food_distribution (
  distribution_id uuid primary key default gen_random_uuid(),
  beneficiary_id uuid not null references beneficiaries(beneficiary_id),
  item_id uuid not null references inventory_items(item_id),
  device_id text references nfc_devices(device_id),
  recorded_by uuid references users(user_id),
  quantity_issued numeric not null check (quantity_issued > 0),
  distribution_date date default current_date,
  created_at timestamptz default now()
);

-- Recording a distribution also consumes stock, via the same
-- transaction table and trigger used for manual stock updates.
create function public.log_distribution_as_transaction()
returns trigger as $$
begin
  insert into inventory_transactions (item_id, transaction_type, quantity, recorded_by)
  values (new.item_id, 'used', coalesce(new.quantity_issued, 0), new.recorded_by);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_food_distribution_insert
  after insert on food_distribution
  for each row execute procedure public.log_distribution_as_transaction();

-- ------------------------------------------------------------
-- REPORTS
-- Stores metadata about a generated report; the file itself is
-- expected to live in Supabase Storage, with file_path pointing
-- to it.
-- ------------------------------------------------------------
create table reports (
  report_id uuid primary key default gen_random_uuid(),
  report_type text not null, -- e.g. 'attendance', 'inventory', 'distribution'
  generated_date date default current_date,
  start_date date,
  end_date date,
  generated_by uuid references users(user_id),
  file_path text,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- NFC_TAG_LOGS
-- A raw, append-only audit trail of every scan attempt at every
-- reader -- successful or not -- kept separate from
-- meal_attendance/food_distribution, which only hold the scans
-- that became official business records. Useful for debugging a
-- reader in the field ("why isn't this card working?") without
-- digging through business tables.
-- ------------------------------------------------------------
create table nfc_tag_logs (
  log_id uuid primary key default gen_random_uuid(),
  nfc_tag_id text,
  device_id text,
  action_type text not null, -- Failed scans may come from unregistered devices.
  created_at timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table users enable row level security;
alter table beneficiaries enable row level security;
alter table nfc_devices enable row level security;
alter table inventory_items enable row level security;
alter table inventory_transactions enable row level security;
alter table meal_attendance enable row level security;
alter table food_distribution enable row level security;
alter table reports enable row level security;
alter table nfc_tag_logs enable row level security;

create function public.has_any_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users
    where auth.uid() is not null
      and user_id = auth.uid()
      and status = 'active'
      and role = any(p_roles)
  );
$$;
revoke all on function public.has_any_role(text[]) from public;
grant execute on function public.has_any_role(text[]) to anon, authenticated;

create policy "Users can read own profile"
  on users for select using (user_id = auth.uid());

create policy "Authenticated users can read beneficiaries"
  on beneficiaries for select using (auth.role() = 'authenticated');
create policy "Coordinators can manage beneficiaries"
  on beneficiaries for all
  using (public.has_any_role(array['admin', 'coordinator']))
  with check (public.has_any_role(array['admin', 'coordinator']));

create policy "Authenticated users can read devices"
  on nfc_devices for select using (auth.role() = 'authenticated');
create policy "Admins can manage devices"
  on nfc_devices for all
  using (public.has_any_role(array['admin']))
  with check (public.has_any_role(array['admin']));

create policy "Authenticated users can read inventory items"
  on inventory_items for select using (auth.role() = 'authenticated');
create policy "Inventory officers can manage items"
  on inventory_items for all
  using (public.has_any_role(array['admin', 'inventory_officer']))
  with check (public.has_any_role(array['admin', 'inventory_officer']));
revoke insert, update, delete on inventory_items from authenticated;
grant insert (item_name, unit, reorder_level) on inventory_items to authenticated;
grant update (item_name, unit, reorder_level) on inventory_items to authenticated;

create policy "Authenticated users can read inventory transactions"
  on inventory_transactions for select using (auth.role() = 'authenticated');
create policy "Inventory officers can record transactions"
  on inventory_transactions for insert
  with check (public.has_any_role(array['admin', 'inventory_officer']));

create policy "Authenticated users can read attendance"
  on meal_attendance for select using (auth.role() = 'authenticated');
create policy "Coordinators can manage attendance"
  on meal_attendance for all
  using (public.has_any_role(array['admin', 'coordinator']))
  with check (public.has_any_role(array['admin', 'coordinator']));

create policy "Authenticated users can read distributions"
  on food_distribution for select using (auth.role() = 'authenticated');
create policy "Coordinators can record distributions"
  on food_distribution for insert
  with check (public.has_any_role(array['admin', 'coordinator']));

create policy "Authenticated users can read reports"
  on reports for select using (auth.role() = 'authenticated');
create policy "Coordinators can manage reports"
  on reports for all
  using (public.has_any_role(array['admin', 'coordinator']))
  with check (public.has_any_role(array['admin', 'coordinator']));

create policy "Admins can read NFC audit logs"
  on nfc_tag_logs for select using (public.has_any_role(array['admin']));

-- Note: there is deliberately no policy letting the anon key (used
-- by the ESP32 readers, which have no user login) write directly to
-- meal_attendance, food_distribution or nfc_tag_logs. Instead, every
-- device write goes through record_nfc_scan() below, which runs as
-- SECURITY DEFINER (so it isn't limited by these policies), checks
-- the device is registered and active, looks the tag up internally,
-- and returns only a success flag and first name -- the beneficiaries
-- table itself is never exposed to the public anon key.

-- ------------------------------------------------------------
-- Auto-create a users row whenever someone signs up
-- ------------------------------------------------------------
create function public.handle_new_user()
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ------------------------------------------------------------
-- record_nfc_scan(): the single endpoint the ESP32 calls.
-- Called for both attendance and distribution scans (p_mode
-- selects which). Every call is logged to nfc_tag_logs
-- regardless of outcome, so a misbehaving reader or an
-- unregistered card leaves a trace to investigate.
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
  v_beneficiary beneficiaries%rowtype;
  v_device_status text;
begin
  if p_nfc_tag_id is null or btrim(p_nfc_tag_id) = '' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'invalid_tag');
    return json_build_object('success', false, 'error', 'invalid_tag');
  end if;

  select status into v_device_status from nfc_devices where device_id = p_device_id;
  if v_device_status is null or v_device_status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'inactive_device');
    return json_build_object('success', false, 'error', 'unregistered_or_inactive_device');
  end if;

  if p_mode is null or p_mode not in ('attendance', 'distribution') then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'invalid_mode');
    return json_build_object('success', false, 'error', 'invalid_mode');
  end if;

  select * into v_beneficiary from beneficiaries where nfc_tag_id = p_nfc_tag_id;
  if v_beneficiary.beneficiary_id is null then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'unknown_tag');
    return json_build_object('success', false, 'error', 'unknown_tag');
  end if;

  if v_beneficiary.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'not_eligible');
    return json_build_object('success', false, 'error', 'not_eligible');
  end if;

  if p_mode = 'distribution' then
    if p_item_id is null or p_quantity is null or p_quantity <= 0
      or not exists (select 1 from inventory_items where item_id = p_item_id) then
      insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
        values (p_nfc_tag_id, p_device_id, 'invalid_distribution');
      return json_build_object('success', false, 'error', 'invalid_distribution');
    end if;

    begin
    insert into food_distribution (beneficiary_id, item_id, device_id, quantity_issued)
      values (v_beneficiary.beneficiary_id, p_item_id, p_device_id, p_quantity);
    exception when check_violation then
      insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
        values (p_nfc_tag_id, p_device_id, 'insufficient_stock');
      return json_build_object('success', false, 'error', 'insufficient_stock');
    end;
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'distribution_recorded');
  else
    insert into meal_attendance (beneficiary_id, nfc_tag_id, device_id, status)
      values (v_beneficiary.beneficiary_id, p_nfc_tag_id, p_device_id, 'present')
      on conflict (beneficiary_id, attendance_date, meal_type) do nothing;
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'attendance_recorded');
  end if;

  return json_build_object('success', true, 'first_name', split_part(v_beneficiary.full_name, ' ', 1));
end;
$$;

grant execute on function record_nfc_scan(text, text, text, uuid, numeric) to anon, authenticated;
