-- ============================================================
-- Fix 013: headteachers sign up and create their own school
--
-- There is no platform or network administrator any more. Each
-- school is created by its headteacher: they create an account in
-- the app, name their school, and run it. The only other role is
-- the coordinator, whom the headteacher adds, and who runs
-- students, attendance, the timetable and inventory day to day.
--
--   * Roles: 'headteacher' and 'coordinator' only. Existing
--     inventory officers and staff become coordinators; platform
--     admins lose their role (they can create a school like anyone).
--   * create_my_school(): an account with no school creates one and
--     becomes its headteacher. Each account can do this only once,
--     and never while it belongs to a school.
--   * Coordinators get every permission by default; the headteacher
--     can still turn permissions off. Managing staff, choosing
--     suppliers and confirming orders stay with the headteacher.
--   * School names no longer have to be unique.
--   * The shared food list is read-only (kept by the developers);
--     each school can add its own foods, which only it sees.
--   * Suppliers (later): each school will approve its own.
--
-- Run it once, after fix 012 (and after reset/fresh_start.sql if
-- you are starting fresh). It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Roles
-- ------------------------------------------------------------
alter table users drop constraint if exists users_role_check;
alter table users drop constraint if exists users_role_school_check;

alter table users disable trigger keep_a_headteacher;
update users set role = 'coordinator' where role in ('inventory_officer', 'staff');
update users set role = null, school_id = null where role = 'platform_admin';
alter table users enable trigger keep_a_headteacher;

alter table users add constraint users_role_check check (role in ('headteacher', 'coordinator'));
-- Both roles belong to exactly one school; a login with no role has no school.
alter table users add constraint users_role_school_check check ((role is not null) = (school_id is not null));

-- ------------------------------------------------------------
-- Coordinator permissions: everything by default
-- ------------------------------------------------------------
delete from school_role_permissions where role <> 'coordinator';
alter table school_role_permissions drop constraint if exists school_role_permissions_role_check;
alter table school_role_permissions add constraint school_role_permissions_role_check
  check (role = 'coordinator');

create or replace function public.add_default_permissions()
returns trigger as $$
begin
  insert into school_role_permissions (school_id, role, permission)
  select new.school_id, 'coordinator', p from unnest(public.permission_codes()) as p
  on conflict do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Existing schools: coordinators get the permissions they didn't have.
insert into school_role_permissions (school_id, role, permission)
select s.school_id, 'coordinator', p
from schools s cross join unnest(public.permission_codes()) as p
on conflict do nothing;

-- ------------------------------------------------------------
-- Schools: created by their headteacher; names needn't be unique
-- ------------------------------------------------------------
alter table schools drop constraint if exists schools_name_key;

create or replace function public.create_my_school(
  p_school_name text, p_full_name text default null, p_county text default null,
  p_location text default null, p_timezone text default 'Africa/Nairobi')
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user users%rowtype;
  v_school_id uuid;
  v_timezone text := coalesce(nullif(btrim(p_timezone), ''), 'Africa/Nairobi');
begin
  if auth.uid() is null or not public.session_verified() then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  -- Locked so two taps can't create two schools.
  select * into v_user from users where user_id = auth.uid() for update;
  if not found or v_user.status <> 'active' then
    raise exception 'This account is not active' using errcode = '42501';
  end if;
  if v_user.role is not null or v_user.school_id is not null then
    raise exception 'This account already belongs to a school' using errcode = '22023';
  end if;
  if coalesce(btrim(p_school_name), '') = '' then
    raise exception 'Enter the name of your school' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_timezone) then
    raise exception 'Unknown timezone %', v_timezone using errcode = '22023';
  end if;

  -- The school's default permissions and Monday-Friday timetable are
  -- added by triggers.
  insert into schools (name, county, location, timezone)
  values (btrim(p_school_name), nullif(btrim(p_county), ''), nullif(btrim(p_location), ''), v_timezone)
  returning school_id into v_school_id;

  update users
    set role = 'headteacher', school_id = v_school_id,
        full_name = coalesce(nullif(btrim(p_full_name), ''), full_name)
    where user_id = auth.uid();
  return v_school_id;
end;
$$;

revoke all on function public.create_my_school(text, text, text, text, text) from public;
grant execute on function public.create_my_school(text, text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- Staff: the headteacher's staff are coordinators. A coordinator
-- can be made headteacher (to hand the school over).
-- ------------------------------------------------------------
create or replace function public.update_staff(p_user_id uuid, p_full_name text, p_role text, p_status text)
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
  if p_role is null or p_role not in ('headteacher', 'coordinator') then
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

-- ------------------------------------------------------------
-- Foods: the shared list is read-only; schools add their own.
-- ------------------------------------------------------------
alter table food_items add column if not exists school_id uuid references schools(school_id) on delete cascade;

drop index if exists food_items_name_key;
create unique index if not exists food_items_school_name_key
  on food_items (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(item_name)));

-- A school's own food can't take the name of a shared one.
create or replace function public.check_food_name()
returns trigger as $$
begin
  if new.school_id is not null and exists (
       select 1 from food_items
       where school_id is null and lower(btrim(item_name)) = lower(btrim(new.item_name))) then
    raise exception '% is already on the food list', btrim(new.item_name) using errcode = '23505';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists check_food_name on food_items;
create trigger check_food_name before insert or update of item_name, school_id on food_items
  for each row execute procedure public.check_food_name();

-- Is this food on the shared list or the school's own?
create or replace function public.food_usable_by(p_food_id uuid, p_school_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from food_items
                 where food_id = p_food_id and (school_id is null or school_id = p_school_id));
$$;
revoke all on function public.food_usable_by(uuid, uuid) from public;
grant execute on function public.food_usable_by(uuid, uuid) to authenticated;

-- A dish can only use the shared foods and the school's own.
create or replace function public.check_ingredient_food()
returns trigger as $$
begin
  if not public.food_usable_by(new.food_id, new.school_id) then
    raise exception 'That food isn''t on your school''s food list' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists check_ingredient_food on meal_ingredients;
create trigger check_ingredient_food after insert or update on meal_ingredients
  for each row execute procedure public.check_ingredient_food();

-- ------------------------------------------------------------
-- Policies that mentioned the platform admin
-- ------------------------------------------------------------
drop policy if exists "Staff read their school and the platform admin all schools" on schools;
drop policy if exists "Staff read their school" on schools;
create policy "Staff read their school"
  on schools for select using (public.is_school_member(school_id));

drop policy if exists "Signed-in users read the food list" on food_items;
drop policy if exists "The platform admin manages the food list" on food_items;
drop policy if exists "Signed-in users read the shared foods and their school's" on food_items;
drop policy if exists "Schools manage their own foods" on food_items;
create policy "Signed-in users read the shared foods and their school's"
  on food_items for select
  using ((school_id is null and public.session_verified()) or public.can_view_school(school_id));
create policy "Schools manage their own foods"
  on food_items for all
  using (school_id is not null
         and (public.has_school_permission(school_id, 'manage_meals')
              or public.has_school_permission(school_id, 'verify_deliveries')))
  with check (school_id is not null
              and (public.has_school_permission(school_id, 'manage_meals')
                   or public.has_school_permission(school_id, 'verify_deliveries')));
revoke insert, update on food_items from authenticated;
grant insert (item_name, unit, pack_size, school_id) on food_items to authenticated;
grant update (item_name, unit, pack_size) on food_items to authenticated;

drop policy if exists "The platform admin manages shared nutrition values" on food_nutrition;

drop policy if exists "Headteachers read their school's audit log" on audit_logs;
create policy "Headteachers read their school's audit log"
  on audit_logs for select using (public.has_school_role(school_id, array['headteacher']));

drop function if exists public.list_schools();
drop function if exists public.set_school_status(uuid, text);
drop function if exists public.is_platform_admin();

-- ------------------------------------------------------------
-- Functions that take a food: only the shared foods and the
-- school's own.
-- ------------------------------------------------------------
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
  if not public.food_usable_by(p_food_id, v_school_id) then
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

create or replace function public.set_food_nutrition(p_food_id uuid, p_values jsonb, p_source text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
  k text;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_permission(v_school_id, 'manage_meals') then
    raise exception 'You don''t have permission to change nutrition values' using errcode = '42501';
  end if;
  if not public.food_usable_by(p_food_id, v_school_id) then
    raise exception 'Food not found' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_source), '') = '' then
    raise exception 'Say where the values come from (e.g. the packet, or a food table)'
      using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(coalesce(p_values, '{}'::jsonb)) loop
    if k not in ('energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fibre_g', 'calcium_mg',
                 'iron_mg', 'zinc_mg', 'vitamin_a_ug', 'vitamin_c_mg') then
      raise exception 'Unknown nutrient %', k using errcode = '22023';
    end if;
  end loop;

  delete from food_nutrition where food_id = p_food_id and school_id = v_school_id;
  insert into food_nutrition (food_id, school_id, energy_kcal, protein_g, carbohydrate_g, fat_g,
                              fibre_g, calcium_mg, iron_mg, zinc_mg, vitamin_a_ug, vitamin_c_mg,
                              source, updated_by)
  values (p_food_id, v_school_id,
          (p_values ->> 'energy_kcal')::numeric, (p_values ->> 'protein_g')::numeric,
          (p_values ->> 'carbohydrate_g')::numeric, (p_values ->> 'fat_g')::numeric,
          (p_values ->> 'fibre_g')::numeric, (p_values ->> 'calcium_mg')::numeric,
          (p_values ->> 'iron_mg')::numeric, (p_values ->> 'zinc_mg')::numeric,
          (p_values ->> 'vitamin_a_ug')::numeric, (p_values ->> 'vitamin_c_mg')::numeric,
          btrim(p_source), auth.uid());
end;
$$;

-- The school's food list (shared foods and its own) with the values it uses.
create or replace function public.school_food_nutrition(p_school_id uuid)
returns table (food_id uuid, item_name text, unit text, energy_kcal numeric, protein_g numeric,
               carbohydrate_g numeric, fat_g numeric, fibre_g numeric, calcium_mg numeric,
               iron_mg numeric, zinc_mg numeric, vitamin_a_ug numeric, vitamin_c_mg numeric,
               source text, is_school_value boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.food_id, f.item_name, f.unit,
         coalesce(o.energy_kcal, d.energy_kcal), coalesce(o.protein_g, d.protein_g),
         coalesce(o.carbohydrate_g, d.carbohydrate_g), coalesce(o.fat_g, d.fat_g),
         coalesce(o.fibre_g, d.fibre_g), coalesce(o.calcium_mg, d.calcium_mg),
         coalesce(o.iron_mg, d.iron_mg), coalesce(o.zinc_mg, d.zinc_mg),
         coalesce(o.vitamin_a_ug, d.vitamin_a_ug), coalesce(o.vitamin_c_mg, d.vitamin_c_mg),
         coalesce(o.source, d.source), o.food_id is not null
  from food_items f
  left join food_nutrition d on d.food_id = f.food_id and d.school_id is null
  left join food_nutrition o on o.food_id = f.food_id and o.school_id = p_school_id
  where (f.school_id is null or f.school_id = p_school_id)
    -- A school's own foods and values only for its staff (or the system).
    and (auth.uid() is null or public.can_view_school(p_school_id))
  order by f.item_name;
$$;

commit;

-- Who is in which school now (shown in the results panel).
select coalesce(s.name, '(no school)') as school, coalesce(u.role, '(no role)') as role, count(*) as people
from users u left join schools s using (school_id)
group by 1, 2 order by 1, 2;
