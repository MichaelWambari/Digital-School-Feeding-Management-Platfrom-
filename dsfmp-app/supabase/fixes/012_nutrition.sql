-- ============================================================
-- Fix 012: nutrition and each student's feeding record
--
-- Every food on the shared food list gets nutrition values per
-- 100 g (per 100 ml for foods counted in litres), pre-filled from
-- the Kenya Food Composition Tables 2018. They are approximate:
-- check them against the published tables. A school can change
-- any value for itself (and give its source) without changing it
-- for other schools; the platform admin keeps the shared values.
--
-- Whenever a student's attendance is recorded (NFC scan or by
-- hand), the nutrients of one standard serving of that day's
-- dish are worked out and stored with it (attendance_nutrition),
-- together with the dish, serving and values used. Later changes
-- to the dish or the values don't change past records.
--
-- These are ESTIMATES of the food provided, based on a standard
-- serving and recorded attendance, not of what a student ate.
--
--   * food_nutrition: shared values (school_id null) and each
--     school's own changes.
--   * set_food_nutrition() / reset_food_nutrition(): a school's
--     own values for a food.
--   * attendance_nutrition: one row per attendance.
--   * Common foods missing from the food list are added (milk,
--     sugar, kale, cabbage, potatoes, sweet potatoes, beef, bread).
--
-- Staff with 'view_nutrition' (the headteacher, and coordinators
-- by default) see students' nutrition; staff with 'manage_meals'
-- change their school's values.
--
-- Attendance recorded before this fix has no nutrition record.
--
-- Run it once, after fix 011. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- FOOD_NUTRITION: per 100 g (or 100 ml). A null value is unknown.
-- ------------------------------------------------------------
create table if not exists food_nutrition (
  nutrition_id uuid primary key default gen_random_uuid(),
  food_id uuid not null references food_items(food_id) on delete cascade,
  school_id uuid references schools(school_id) on delete cascade, -- null = the shared values
  energy_kcal numeric check (energy_kcal >= 0),
  protein_g numeric check (protein_g >= 0),
  carbohydrate_g numeric check (carbohydrate_g >= 0),
  fat_g numeric check (fat_g >= 0),
  fibre_g numeric check (fibre_g >= 0),
  calcium_mg numeric check (calcium_mg >= 0),
  iron_mg numeric check (iron_mg >= 0),
  zinc_mg numeric check (zinc_mg >= 0),
  vitamin_a_ug numeric check (vitamin_a_ug >= 0),   -- retinol activity equivalents
  vitamin_c_mg numeric check (vitamin_c_mg >= 0),
  source text,
  updated_by uuid references users(user_id),
  updated_at timestamptz not null default now()
);

create unique index if not exists food_nutrition_shared_key
  on food_nutrition (food_id) where school_id is null;
create unique index if not exists food_nutrition_school_key
  on food_nutrition (food_id, school_id) where school_id is not null;

alter table food_nutrition enable row level security;

drop policy if exists "Signed-in users read shared nutrition and their school's" on food_nutrition;
drop policy if exists "Schools manage their own nutrition values" on food_nutrition;
drop policy if exists "The platform admin manages shared nutrition values" on food_nutrition;
create policy "Signed-in users read shared nutrition and their school's"
  on food_nutrition for select
  using ((school_id is null and public.session_verified()) or public.can_view_school(school_id));
create policy "Schools manage their own nutrition values"
  on food_nutrition for all
  using (school_id is not null and public.has_school_permission(school_id, 'manage_meals'))
  with check (school_id is not null and public.has_school_permission(school_id, 'manage_meals'));
create policy "The platform admin manages shared nutrition values"
  on food_nutrition for all
  using (school_id is null and public.is_platform_admin())
  with check (school_id is null and public.is_platform_admin());

drop trigger if exists touch_food_nutrition on food_nutrition;
create trigger touch_food_nutrition before update on food_nutrition
  for each row execute procedure public.touch_updated_at();
drop trigger if exists audit_food_nutrition on food_nutrition;
create trigger audit_food_nutrition after insert or update or delete on food_nutrition
  for each row execute procedure public.audit_change('food_id');

-- ------------------------------------------------------------
-- Common foods, and their shared values. Approximate values per
-- 100 g edible portion, raw (per 100 ml for milk and oil), from
-- the Kenya Food Composition Tables 2018. Foods already on the
-- list keep their unit; existing values are never overwritten.
-- ------------------------------------------------------------
insert into food_items (item_name, unit, pack_size)
select v.name, v.unit, v.pack
from (values
  ('Milk', 'litres', null::numeric),
  ('Sugar', 'kg', 50),
  ('Kale (sukuma wiki)', 'kg', null),
  ('Cabbage', 'kg', null),
  ('Irish potatoes', 'kg', 50),
  ('Sweet potatoes', 'kg', null),
  ('Beef', 'kg', null),
  ('Bread', 'kg', null)
) as v(name, unit, pack)
where not exists (select 1 from food_items f where lower(f.item_name) = lower(v.name));

insert into food_nutrition (food_id, school_id, energy_kcal, protein_g, carbohydrate_g, fat_g, fibre_g,
                            calcium_mg, iron_mg, zinc_mg, vitamin_a_ug, vitamin_c_mg, source)
select f.food_id, null, v.kcal, v.protein, v.carb, v.fat, v.fibre, v.ca, v.fe, v.zn, v.vita, v.vitc,
       'Kenya Food Composition Tables 2018 (approximate; check against the published table)'
from (values
  -- name             kcal  protein carb   fat   fibre  Ca    Fe    Zn   VitA  VitC
  ('maize',           365,  9.4,    64.0,  4.7,  7.3,   7,    2.7,  2.2, 0,    0),
  ('maize flour',     358,  8.1,    71.0,  3.6,  4.0,   6,    1.8,  1.7, 0,    0),
  ('rice',            360,  6.8,    79.0,  0.6,  1.0,   9,    0.8,  1.2, 0,    0),
  ('beans',           337,  21.4,   46.0,  1.4,  16.0,  120,  6.0,  2.8, 0,    1),
  ('green grams',     340,  23.9,   46.0,  1.2,  16.0,  120,  6.7,  2.7, 3,    0),
  ('lentils',         330,  24.6,   52.0,  1.1,  11.0,  50,   7.5,  3.3, 2,    1),
  ('sorghum',         340,  10.6,   66.0,  3.3,  6.7,   13,   3.4,  1.7, 0,    0),
  ('millet flour',    336,  7.4,    72.0,  1.5,  11.0,  344,  3.9,  2.3, 0,    0),
  ('wheat flour',     350,  10.3,   73.0,  1.0,  2.7,   15,   1.2,  0.7, 0,    0),
  ('cooking oil',     813,  0,      0,     92.0, 0,     0,    0,    0,   0,    0), -- unfortified; fortified oil adds vitamin A
  ('salt',            0,    0,      0,     0,    0,     24,   0.3,  0.1, 0,    0),
  ('milk',            64,   3.3,    4.7,   3.6,  0,     120,  0.05, 0.4, 40,   1),
  ('sugar',           400,  0,      99.9,  0,    0,     1,    0.1,  0,   0,    0),
  ('kale (sukuma wiki)', 40, 3.3,   4.4,   0.7,  3.6,   150,  1.6,  0.4, 450,  90),
  ('cabbage',         25,   1.3,    3.7,   0.1,  2.5,   40,   0.5,  0.2, 5,    36),
  ('irish potatoes',  77,   2.0,    16.0,  0.1,  2.1,   10,   0.8,  0.3, 0,    20),
  ('sweet potatoes',  86,   1.6,    17.3,  0.1,  3.0,   30,   0.6,  0.3, 5,    2),
  ('beef',            200,  19.0,   0,     14.0, 0,     10,   2.0,  4.0, 0,    0),
  ('bread',           265,  8.5,    49.0,  3.2,  2.7,   100,  1.5,  0.8, 0,    0)
) as v(name, kcal, protein, carb, fat, fibre, ca, fe, zn, vita, vitc)
join food_items f on lower(btrim(f.item_name)) = v.name
where not exists (select 1 from food_nutrition n where n.food_id = f.food_id and n.school_id is null);
-- Porridge flour isn't filled in: blends differ too much. Enter its
-- values from the packet.

-- ------------------------------------------------------------
-- A school's own values for a food. p_values holds any of the
-- nutrient columns; missing ones fall back to the shared values.
-- Runs with the caller's permissions.
-- ------------------------------------------------------------
create or replace function public.set_food_nutrition(p_food_id uuid, p_values jsonb, p_source text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
  n numeric;
  k text;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_permission(v_school_id, 'manage_meals') then
    raise exception 'You don''t have permission to change nutrition values' using errcode = '42501';
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

-- Goes back to the shared values for a food.
create or replace function public.reset_food_nutrition(p_food_id uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_permission(v_school_id, 'manage_meals') then
    raise exception 'You don''t have permission to change nutrition values' using errcode = '42501';
  end if;
  delete from food_nutrition where food_id = p_food_id and school_id = v_school_id;
end;
$$;

revoke all on function public.set_food_nutrition(uuid, jsonb, text) from public;
revoke all on function public.reset_food_nutrition(uuid) from public;
grant execute on function public.set_food_nutrition(uuid, jsonb, text) to authenticated;
grant execute on function public.reset_food_nutrition(uuid) to authenticated;

-- ------------------------------------------------------------
-- The values a school uses for each food: its own where it set
-- them, otherwise the shared ones (value by value).
-- ------------------------------------------------------------
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
  -- Anyone may see the shared values; a school's own only its staff (or the system).
  where p_school_id is null or auth.uid() is null or public.can_view_school(p_school_id)
  order by f.item_name;
$$;

revoke all on function public.school_food_nutrition(uuid) from public;
grant execute on function public.school_food_nutrition(uuid) to authenticated;

-- ------------------------------------------------------------
-- ATTENDANCE_NUTRITION: the estimated nutrients of the standard
-- serving a student was provided at one attended meal, with the
-- dish, serving and values used, as they were at the time.
-- ------------------------------------------------------------
create table if not exists attendance_nutrition (
  attendance_id uuid primary key references meal_attendance(attendance_id) on delete cascade,
  beneficiary_id uuid not null references beneficiaries(beneficiary_id) on delete cascade,
  school_id uuid not null references schools(school_id) on delete cascade,
  attendance_date date not null,
  meal_type text not null,
  meal_id uuid references meals(meal_id) on delete set null,
  meal_name text,                 -- null = no dish on the timetable
  energy_kcal numeric, protein_g numeric, carbohydrate_g numeric, fat_g numeric,
  fibre_g numeric, calcium_mg numeric, iron_mg numeric, zinc_mg numeric,
  vitamin_a_ug numeric, vitamin_c_mg numeric,
  complete boolean not null default false, -- false: no dish, no serving, or a value unknown
  ingredients jsonb not null default '[]'::jsonb, -- [{food, amount, unit, values per 100}]
  created_at timestamptz not null default now()
);

create index if not exists idx_attendance_nutrition_student
  on attendance_nutrition(beneficiary_id, attendance_date);
create index if not exists idx_attendance_nutrition_school
  on attendance_nutrition(school_id, attendance_date);

alter table attendance_nutrition enable row level security;
revoke insert, update, delete on attendance_nutrition from anon, authenticated;
drop policy if exists "Permitted staff read their school's nutrition records" on attendance_nutrition;
create policy "Permitted staff read their school's nutrition records"
  on attendance_nutrition for select
  using (public.has_school_permission(school_id, 'view_nutrition'));

-- Works out and stores one attendance's nutrition record.
create or replace function public.record_attendance_nutrition()
returns trigger as $$
declare
  v_meal_id uuid;
  v_meal_name text;
  v_items jsonb;
  v_complete boolean;
begin
  select ms.meal_id, m.name into v_meal_id, v_meal_name
    from meal_schedules ms join meals m on m.meal_id = ms.meal_id
    where ms.school_id = new.school_id and ms.meal_type = new.meal_type
      and ms.weekday = extract(isodow from new.attendance_date)::int;

  select coalesce(jsonb_agg(jsonb_build_object(
           'food_id', n.food_id, 'food', n.item_name, 'amount', mi.amount_per_serving,
           'unit', case when n.unit = 'litres' then 'ml' else 'g' end, 'source', n.source,
           'per_100', jsonb_build_object(
             'energy_kcal', n.energy_kcal, 'protein_g', n.protein_g,
             'carbohydrate_g', n.carbohydrate_g, 'fat_g', n.fat_g, 'fibre_g', n.fibre_g,
             'calcium_mg', n.calcium_mg, 'iron_mg', n.iron_mg, 'zinc_mg', n.zinc_mg,
             'vitamin_a_ug', n.vitamin_a_ug, 'vitamin_c_mg', n.vitamin_c_mg))
           order by n.item_name), '[]'::jsonb)
    into v_items
    from meal_ingredients mi
    join public.school_food_nutrition(new.school_id) n on n.food_id = mi.food_id
    where mi.meal_id = v_meal_id;

  -- Complete only if there is a serving and every value of every food is known.
  v_complete := v_meal_id is not null and jsonb_array_length(v_items) > 0 and not exists (
    select 1 from jsonb_array_elements(v_items) i, jsonb_each(i -> 'per_100') kv
    where kv.value = 'null'::jsonb);

  insert into attendance_nutrition (
      attendance_id, beneficiary_id, school_id, attendance_date, meal_type, meal_id, meal_name,
      energy_kcal, protein_g, carbohydrate_g, fat_g, fibre_g, calcium_mg, iron_mg, zinc_mg,
      vitamin_a_ug, vitamin_c_mg, complete, ingredients)
  select new.attendance_id, new.beneficiary_id, new.school_id, new.attendance_date, new.meal_type,
         v_meal_id, v_meal_name,
         -- amount (g or ml) x value per 100; unknown values count as 0 and mark it incomplete.
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'energy_kcal')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'protein_g')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'carbohydrate_g')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'fat_g')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'fibre_g')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'calcium_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'iron_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'zinc_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'vitamin_a_ug')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'vitamin_c_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         v_complete, v_items
  from (select null::jsonb as i where jsonb_array_length(v_items) = 0
        union all
        select e from jsonb_array_elements(v_items) e) items
  on conflict (attendance_id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists on_attendance_recorded on meal_attendance;
create trigger on_attendance_recorded
  after insert on meal_attendance
  for each row execute procedure public.record_attendance_nutrition();

commit;

-- Foods and whether they have nutrition values (shown in the results panel).
select f.item_name as food, f.unit,
       case when n.food_id is null then 'no values yet' else n.energy_kcal || ' kcal, '
            || n.protein_g || ' g protein per 100 ' || case when f.unit = 'litres' then 'ml' else 'g' end end as per_100
from food_items f
left join food_nutrition n on n.food_id = f.food_id and n.school_id is null
order by f.item_name;
