-- ============================================================
-- Fix 009: independent schools
--
-- The platform is no longer a network of schools run from a
-- central store. Each school is independent and its headteacher
-- runs it; a platform admin only onboards schools and (from fix
-- 014) verifies suppliers, and cannot see any school's records.
--
--   * Roles: network_admin -> platform_admin, admin -> headteacher,
--     plus a new 'staff' role. Users no longer get a role when they
--     sign up; they have no access until a school or the platform
--     gives them one.
--   * Each school's headteacher creates its staff and decides what
--     the coordinator, inventory officer and staff roles may do
--     (school_role_permissions). Staff management, supplier choices
--     and order confirmation always stay with the headteacher.
--   * Every school keeps at least one active headteacher.
--   * Schools can be suspended by the platform admin, which blocks
--     their staff from everything.
--   * The central store is retired: its history stays in the
--     database but nothing new can be dispatched, and deliveries
--     already in transit can still be received. Schools record food
--     they receive themselves (record_stock_received()).
--   * audit_logs records changes to schools, staff, permissions,
--     students, reorder levels and deliveries.
--
-- Nothing is deleted. Run it once, after fix 008. It is safe to
-- run again. Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Schools: contact details and a suspended status
-- ------------------------------------------------------------
alter table schools add column if not exists county text;
alter table schools add column if not exists phone text;
alter table schools add column if not exists email text;
alter table schools add column if not exists registration_no text;

alter table schools drop constraint if exists schools_status_check;
update schools set status = 'suspended' where status = 'inactive';
alter table schools add constraint schools_status_check check (status in ('active', 'suspended'));

-- ------------------------------------------------------------
-- Users: the new roles
-- ------------------------------------------------------------
alter table users drop constraint if exists users_role_check;
alter table users drop constraint if exists users_role_school_check;
alter table users alter column role drop not null;
alter table users add column if not exists must_change_password boolean not null default false;

update users set role = 'platform_admin', school_id = null where role = 'network_admin';
update users set role = 'headteacher' where role = 'admin';
-- School roles without a school never had access; they are unassigned now.
update users set role = null
  where role in ('coordinator', 'inventory_officer', 'staff') and school_id is null;
update users set school_id = null where role is null;

-- A null role means the login has no access yet.
alter table users add constraint users_role_check check (role in
  ('platform_admin', 'headteacher', 'coordinator', 'inventory_officer', 'staff'));
-- School roles belong to exactly one school; the platform admin to none.
alter table users add constraint users_role_school_check check (
  (coalesce(role, '') in ('headteacher', 'coordinator', 'inventory_officer', 'staff'))
  = (school_id is not null));

-- New logins start with no role and no school.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (user_id, username, full_name, role)
  values (
    new.id,
    new.raw_user_meta_data->>'username',
    coalesce(new.raw_user_meta_data->>'full_name', 'New User'),
    null
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- ------------------------------------------------------------
-- What each role may do at a school. The headteacher may do
-- everything and has no rows here. Managing staff, choosing
-- suppliers and confirming orders are not on the list: only the
-- headteacher does those.
-- ------------------------------------------------------------
create or replace function public.permission_codes()
returns text[] language sql immutable as $$
  select array[
    'view_students',      -- see the student list
    'manage_students',    -- add and edit students and their NFC tags
    'record_attendance',  -- mark attendance by hand
    'view_attendance',    -- see who attended
    'manage_meals',       -- timetable, recipes and nutrition values
    'view_nutrition',     -- students' estimated nutrition
    'view_inventory',     -- stock levels and movements
    'verify_deliveries',  -- confirm the amount a delivery brought
    'stock_counts',       -- enter physical stock counts
    'view_procurement',   -- see reorder requests, quotations and orders
    'view_reports'        -- reports
  ]
$$;

create table if not exists school_role_permissions (
  school_id uuid not null references schools(school_id) on delete cascade,
  role text not null check (role in ('coordinator', 'inventory_officer', 'staff')),
  permission text not null check (permission = any (public.permission_codes())),
  primary key (school_id, role, permission)
);

create or replace function public.add_default_permissions()
returns trigger as $$
begin
  insert into school_role_permissions (school_id, role, permission)
  select new.school_id, d.role, d.permission
  from (values
    ('coordinator', 'view_students'), ('coordinator', 'manage_students'),
    ('coordinator', 'record_attendance'), ('coordinator', 'view_attendance'),
    ('coordinator', 'manage_meals'), ('coordinator', 'view_nutrition'),
    ('coordinator', 'view_inventory'), ('coordinator', 'view_reports'),
    ('inventory_officer', 'view_inventory'), ('inventory_officer', 'verify_deliveries'),
    ('inventory_officer', 'stock_counts'), ('inventory_officer', 'view_procurement'),
    ('inventory_officer', 'view_reports'),
    ('staff', 'view_students'), ('staff', 'record_attendance'), ('staff', 'view_attendance')
  ) as d(role, permission)
  on conflict do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists on_school_created on schools;
create trigger on_school_created
  after insert on schools
  for each row execute procedure public.add_default_permissions();

-- Existing schools get the defaults too (only where they have none yet).
insert into school_role_permissions (school_id, role, permission)
select s.school_id, d.role, d.permission
from schools s
cross join (values
  ('coordinator', 'view_students'), ('coordinator', 'manage_students'),
  ('coordinator', 'record_attendance'), ('coordinator', 'view_attendance'),
  ('coordinator', 'manage_meals'), ('coordinator', 'view_nutrition'),
  ('coordinator', 'view_inventory'), ('coordinator', 'view_reports'),
  ('inventory_officer', 'view_inventory'), ('inventory_officer', 'verify_deliveries'),
  ('inventory_officer', 'stock_counts'), ('inventory_officer', 'view_procurement'),
  ('inventory_officer', 'view_reports'),
  ('staff', 'view_students'), ('staff', 'record_attendance'), ('staff', 'view_attendance')
) as d(role, permission)
where not exists (select 1 from school_role_permissions p where p.school_id = s.school_id);

-- ------------------------------------------------------------
-- Permission checks used by the policies below
-- ------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active' and role = 'platform_admin'
  );
$$;

-- Does the current user work at this school (even while it's suspended)?
create or replace function public.is_school_member(p_school_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active' and school_id = p_school_id
  );
$$;

-- Can the current user see this school's records? Only its own
-- staff can, and only while the school is active.
create or replace function public.can_view_school(p_school_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users u join public.schools s on s.school_id = u.school_id
    where u.user_id = auth.uid() and u.status = 'active' and s.status = 'active'
      and u.school_id = p_school_id
  );
$$;

-- Does the current user hold one of these roles at this (active) school?
create or replace function public.has_school_role(p_school_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users u join public.schools s on s.school_id = u.school_id
    where u.user_id = auth.uid() and u.status = 'active' and s.status = 'active'
      and u.school_id = p_school_id and u.role = any(p_roles)
  );
$$;

-- May the current user do this at this (active) school? The
-- headteacher always may; other roles if the school allows it.
create or replace function public.has_school_permission(p_school_id uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users u join public.schools s on s.school_id = u.school_id
    where u.user_id = auth.uid() and u.status = 'active' and s.status = 'active'
      and u.school_id = p_school_id
      and (u.role = 'headteacher' or exists (
        select 1 from public.school_role_permissions p
        where p.school_id = u.school_id and p.role = u.role and p.permission = p_permission))
  );
$$;

-- The current user's permissions, for the app to show or hide things.
create or replace function public.my_permissions()
returns text[] language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not public.session_verified() then '{}'::text[]
    when u.role = 'headteacher' then public.permission_codes()
    else coalesce((select array_agg(p.permission order by p.permission)
                   from public.school_role_permissions p
                   where p.school_id = u.school_id and p.role = u.role), '{}'::text[])
  end
  from public.users u
  where u.user_id = auth.uid() and u.status = 'active';
$$;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_school_member(uuid) from public;
revoke all on function public.has_school_permission(uuid, text) from public;
revoke all on function public.my_permissions() from public;
grant execute on function public.is_platform_admin() to anon, authenticated;
grant execute on function public.is_school_member(uuid) to anon, authenticated;
grant execute on function public.has_school_permission(uuid, text) to anon, authenticated;
grant execute on function public.my_permissions() to authenticated;

-- ------------------------------------------------------------
-- Row level security: every policy is replaced. Schools only see
-- their own records; the platform admin sees no school records.
-- ------------------------------------------------------------
alter table school_role_permissions enable row level security;

do $$
declare
  r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

drop function if exists public.is_network_admin();
drop function if exists public.cancel_distribution(uuid);

-- Schools: staff read their own school (also while suspended, so the
-- app can say so); the platform admin reads the list of schools.
-- New schools are added by the manage-staff Edge Function, and the
-- status only changes through set_school_status().
create policy "Staff read their school and the platform admin all schools"
  on schools for select using (public.is_school_member(school_id) or public.is_platform_admin());
create policy "Headteachers update their school"
  on schools for update
  using (public.has_school_role(school_id, array['headteacher']))
  with check (public.has_school_role(school_id, array['headteacher']));
revoke insert, update, delete on schools from authenticated;
grant update (name, location, county, phone, email, registration_no, timezone,
              breakfast_start, breakfast_end, lunch_start, lunch_end, supper_start, supper_end)
  on schools to authenticated;

-- Users: your own profile; headteachers see their school's staff.
-- Changes go through update_staff() and the manage-staff function.
create policy "Users read their own profile and headteachers their staff"
  on users for select
  using (user_id = auth.uid() or public.has_school_role(school_id, array['headteacher']));
revoke insert, update, delete on users from authenticated;

create policy "Staff read their school's permissions"
  on school_role_permissions for select using (public.is_school_member(school_id));
create policy "Headteachers grant permissions"
  on school_role_permissions for insert
  with check (public.has_school_role(school_id, array['headteacher']));
create policy "Headteachers remove permissions"
  on school_role_permissions for delete
  using (public.has_school_role(school_id, array['headteacher']));
revoke update on school_role_permissions from authenticated;

create policy "Staff read their school's students"
  on beneficiaries for select
  using (public.has_school_permission(school_id, 'view_students')
         or public.has_school_permission(school_id, 'manage_students')
         or public.has_school_permission(school_id, 'record_attendance'));
create policy "Permitted staff manage their school's students"
  on beneficiaries for all
  using (public.has_school_permission(school_id, 'manage_students'))
  with check (public.has_school_permission(school_id, 'manage_students'));

create policy "Staff read their school's readers"
  on nfc_devices for select using (public.can_view_school(school_id));
create policy "Headteachers manage their school's readers"
  on nfc_devices for all
  using (public.has_school_role(school_id, array['headteacher']))
  with check (public.has_school_role(school_id, array['headteacher']));

-- The food list is shared by every school; the platform admin keeps it.
create policy "Signed-in users read the food list"
  on food_items for select using (public.session_verified());
create policy "The platform admin manages the food list"
  on food_items for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());
revoke insert, update on food_items from authenticated;
grant insert (item_name, unit, pack_size) on food_items to authenticated;
grant update (item_name, unit, pack_size) on food_items to authenticated;

-- The central store is retired: its movements stay in the database
-- as history, but nobody reads or adds them through the app.
revoke all on central_transactions from anon, authenticated;

-- Old dispatches stay readable by the school they went to; those
-- still in transit are received through receive_distribution().
create policy "Staff read their school's dispatches from the old central store"
  on food_distribution for select
  using (public.has_school_permission(school_id, 'view_inventory')
         or public.has_school_permission(school_id, 'verify_deliveries'));
revoke insert, update, delete on food_distribution from anon, authenticated;

create policy "Staff read their school's stock"
  on inventory_items for select
  using (public.has_school_permission(school_id, 'view_inventory')
         or public.has_school_permission(school_id, 'verify_deliveries')
         or public.has_school_permission(school_id, 'view_reports'));
create policy "Headteachers set reorder levels"
  on inventory_items for update
  using (public.has_school_role(school_id, array['headteacher']))
  with check (public.has_school_role(school_id, array['headteacher']));
revoke insert, update, delete on inventory_items from authenticated;
grant update (reorder_level) on inventory_items to authenticated;

-- Food used is still entered after each meal until fix 013 works it
-- out from attendance and recipes.
create policy "Staff read their school's food used"
  on food_consumption for select
  using (public.has_school_permission(school_id, 'view_inventory')
         or public.has_school_permission(school_id, 'view_reports'));
create policy "Headteachers and coordinators record food used"
  on food_consumption for insert
  with check (public.has_school_role(school_id, array['headteacher', 'coordinator']));

create policy "Staff read their school's stock movements"
  on inventory_transactions for select
  using (public.has_school_permission(school_id, 'view_inventory')
         or public.has_school_permission(school_id, 'view_reports'));
revoke insert, update, delete on inventory_transactions from authenticated;

create policy "Staff read their school's attendance"
  on meal_attendance for select
  using (public.has_school_permission(school_id, 'view_attendance')
         or public.has_school_permission(school_id, 'record_attendance')
         or public.has_school_permission(school_id, 'view_reports'));
create policy "Permitted staff record their school's attendance"
  on meal_attendance for all
  using (public.has_school_permission(school_id, 'record_attendance'))
  with check (public.has_school_permission(school_id, 'record_attendance'));

create policy "Staff read their school's reports"
  on reports for select using (public.has_school_permission(school_id, 'view_reports'));
create policy "Permitted staff manage their school's reports"
  on reports for all
  using (public.has_school_permission(school_id, 'view_reports'))
  with check (public.has_school_permission(school_id, 'view_reports'));

create policy "Headteachers read their school's NFC scan log"
  on nfc_tag_logs for select using (public.has_school_role(school_id, array['headteacher']));

-- ------------------------------------------------------------
-- Every school keeps at least one active headteacher.
-- ------------------------------------------------------------
create or replace function public.keep_a_headteacher()
returns trigger as $$
begin
  if old.role = 'headteacher' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role is distinct from 'headteacher'
          or new.status <> 'active' or new.school_id is distinct from old.school_id)
     and not exists (
       select 1 from users
       where school_id = old.school_id and role = 'headteacher' and status = 'active'
         and user_id <> old.user_id)
  then
    raise exception 'A school must keep at least one active headteacher. Make someone else headteacher first.'
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists keep_a_headteacher on users;
create trigger keep_a_headteacher
  after update or delete on users
  for each row execute procedure public.keep_a_headteacher();

-- ------------------------------------------------------------
-- AUDIT_LOGS: who changed what. Added by triggers only. A school's
-- headteacher reads its log; the platform admin reads changes to
-- schools (onboarding, suspensions).
-- ------------------------------------------------------------
create table if not exists audit_logs (
  log_id bigint generated always as identity primary key,
  school_id uuid references schools(school_id) on delete set null,
  actor_id uuid,          -- the signed-in user; null for the system or an Edge Function
  action text not null,   -- insert, update or delete
  table_name text not null,
  record_id text,
  changes jsonb,          -- the new row, or for updates {column: {from, to}}
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_school on audit_logs(school_id, created_at desc);

alter table audit_logs enable row level security;
revoke insert, update, delete on audit_logs from anon, authenticated;
create policy "Headteachers read their school's audit log"
  on audit_logs for select
  using (public.has_school_role(school_id, array['headteacher'])
         or (table_name = 'schools' and public.is_platform_admin()));

-- Trigger arguments name the columns that identify the row.
create or replace function public.audit_change()
returns trigger as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changes jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_object('from', v_old -> key, 'to', value))
      into v_changes
      from jsonb_each(v_new) where v_old -> key is distinct from value;
    if v_changes is null then
      return new;
    end if;
  else
    v_changes := v_row;
  end if;
  insert into audit_logs (school_id, actor_id, action, table_name, record_id, changes)
  values ((v_row ->> 'school_id')::uuid, auth.uid(), lower(tg_op), tg_table_name,
          (select string_agg(v_row ->> c, ':') from unnest(tg_argv) as c), v_changes);
  return coalesce(new, old);
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists audit_schools on schools;
create trigger audit_schools after insert or update on schools
  for each row execute procedure public.audit_change('school_id');
drop trigger if exists audit_users on users;
create trigger audit_users after insert or update on users
  for each row execute procedure public.audit_change('user_id');
drop trigger if exists audit_permissions on school_role_permissions;
create trigger audit_permissions after insert or delete on school_role_permissions
  for each row execute procedure public.audit_change('role', 'permission');
drop trigger if exists audit_beneficiaries on beneficiaries;
create trigger audit_beneficiaries after insert or update or delete on beneficiaries
  for each row execute procedure public.audit_change('beneficiary_id');
drop trigger if exists audit_reorder_levels on inventory_items;
create trigger audit_reorder_levels after update of reorder_level on inventory_items
  for each row execute procedure public.audit_change('item_id');
drop trigger if exists audit_distributions on food_distribution;
create trigger audit_distributions after update on food_distribution
  for each row execute procedure public.audit_change('distribution_id');

-- ------------------------------------------------------------
-- Receiving food
-- ------------------------------------------------------------
alter table inventory_transactions add column if not exists supplier_name text;
alter table inventory_transactions add column if not exists note text;

-- A dispatch from the old central store that is still in transit.
create or replace function public.receive_distribution(p_distribution_id uuid, p_quantity_received numeric)
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
  if not public.has_school_permission(v_dispatch.school_id, 'verify_deliveries') then
    raise exception 'You don''t have permission to confirm deliveries' using errcode = '42501';
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

-- Food the school received and checked itself, e.g. bought at the
-- market or delivered before supplier orders are on the platform.
create or replace function public.record_stock_received(
  p_food_id uuid, p_quantity numeric, p_supplier_name text default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
  v_item_id uuid;
  v_transaction_id uuid;
  v_today date;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_permission(v_school_id, 'verify_deliveries') then
    raise exception 'You don''t have permission to record food received' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'The amount received must be more than 0' using errcode = '22023';
  end if;
  if not exists (select 1 from food_items where food_id = p_food_id) then
    raise exception 'Food not found' using errcode = 'P0002';
  end if;

  v_today := (now() at time zone (select timezone from schools where school_id = v_school_id))::date;

  insert into inventory_items (school_id, food_id) values (v_school_id, p_food_id)
    on conflict (school_id, food_id) do nothing;
  select item_id into v_item_id from inventory_items
    where school_id = v_school_id and food_id = p_food_id;

  insert into inventory_transactions
      (item_id, transaction_type, quantity, transaction_date, recorded_by, supplier_name, note)
    values (v_item_id, 'received', p_quantity, v_today, auth.uid(),
            nullif(btrim(p_supplier_name), ''), nullif(btrim(p_note), ''))
    returning transaction_id into v_transaction_id;
  return v_transaction_id;
end;
$$;

revoke all on function public.receive_distribution(uuid, numeric) from public;
revoke all on function public.record_stock_received(uuid, numeric, text, text) from public;
grant execute on function public.receive_distribution(uuid, numeric) to authenticated;
grant execute on function public.record_stock_received(uuid, numeric, text, text) to authenticated;

-- ------------------------------------------------------------
-- Staff: each headteacher manages their own school's staff.
-- Logins are created by the manage-staff Edge Function.
-- ------------------------------------------------------------
drop function if exists public.update_staff(uuid, text, text, uuid, text);
drop function if exists public.update_staff(uuid, text, text, text);
drop function if exists public.list_staff();

create function public.list_staff()
returns table (user_id uuid, email text, full_name text, role text, school_id uuid,
               status text, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select u.school_id into v_school_id from public.users u where u.user_id = auth.uid();
  if v_school_id is null or not public.has_school_role(v_school_id, array['headteacher']) then
    raise exception 'Only the headteacher can manage staff' using errcode = '42501';
  end if;
  return query
    select u.user_id, a.email::text, u.full_name, u.role, u.school_id, u.status, a.last_sign_in_at
    from public.users u
    join auth.users a on a.id = u.user_id
    where u.school_id = v_school_id
    order by u.full_name;
end;
$$;

create function public.update_staff(p_user_id uuid, p_full_name text, p_role text, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_role(v_school_id, array['headteacher']) then
    raise exception 'Only the headteacher can manage staff' using errcode = '42501';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'Full name is required' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('headteacher', 'coordinator', 'inventory_officer', 'staff') then
    raise exception 'Unknown role %', p_role using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  if p_user_id = auth.uid() and (p_role <> 'headteacher' or p_status <> 'active') then
    raise exception 'You can''t change your own role or suspend yourself. Another headteacher can.'
      using errcode = '22023';
  end if;

  update users
    set full_name = trim(p_full_name), role = p_role, status = p_status
    where user_id = p_user_id and school_id = v_school_id;
  if not found then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Clears the "choose a new password" prompt after the user has set one.
create or replace function public.password_changed()
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.users set must_change_password = false where user_id = auth.uid();
$$;

revoke all on function public.list_staff() from public;
revoke all on function public.update_staff(uuid, text, text, text) from public;
revoke all on function public.password_changed() from public;
grant execute on function public.list_staff() to authenticated;
grant execute on function public.update_staff(uuid, text, text, text) to authenticated;
grant execute on function public.password_changed() to authenticated;

-- ------------------------------------------------------------
-- The platform admin's list of schools, with each headteacher's
-- contact, and suspending or restoring a school. Nothing else.
-- ------------------------------------------------------------
create or replace function public.list_schools()
returns table (school_id uuid, name text, location text, county text, phone text, email text,
               registration_no text, timezone text, status text, created_at timestamptz,
               headteacher_name text, headteacher_email text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform admin can list schools' using errcode = '42501';
  end if;
  return query
    select s.school_id, s.name, s.location, s.county, s.phone, s.email, s.registration_no,
           s.timezone, s.status, s.created_at, h.full_name, h.email
    from public.schools s
    left join lateral (
      select u.full_name, a.email::text as email
      from public.users u join auth.users a on a.id = u.user_id
      where u.school_id = s.school_id and u.role = 'headteacher' and u.status = 'active'
      order by u.created_at
      limit 1
    ) h on true
    order by s.name;
end;
$$;

create or replace function public.set_school_status(p_school_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the platform admin can suspend schools' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  update schools set status = p_status where school_id = p_school_id;
  if not found then
    raise exception 'School not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.list_schools() from public;
revoke all on function public.set_school_status(uuid, text) from public;
grant execute on function public.list_schools() to authenticated;
grant execute on function public.set_school_status(uuid, text) to authenticated;

commit;

-- Who has which role now (shown in the results panel).
select coalesce(u.role, '(no access yet)') as role, coalesce(s.name, '-') as school, count(*) as people
from users u left join schools s using (school_id)
group by 1, 2 order by 2, 1;
