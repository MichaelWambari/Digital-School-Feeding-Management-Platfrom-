-- ============================================================
-- Fix 017: micronutrients from the Kenya Food Composition Tables
--
-- 1. Food values gain the micronutrients that matter most for
--    school feeding: magnesium, thiamin, riboflavin, niacin,
--    folate (dietary folate equivalents, which count the folic acid
--    added to fortified flour 1.7 times), vitamin B12, and phytate
--    (which lowers how much iron and zinc the body absorbs).
--    Each shared food records the KFCT 2018 food code it came from.
-- 2. The shared values are replaced by the exact KFCT 2018 values
--    (per 100 g edible portion, raw), for the variant schools
--    actually use: whole maize and whole maize flour, not fortified
--    flour. Five foods are added: fortified packaged maize flour,
--    yellow maize, orange-fleshed sweet potatoes, eggs and dried
--    omena. A school's own values are never touched.
-- 3. Each student's meal record (attendance_nutrition) stores the
--    new nutrients too, from now on. Earlier records are kept as
--    they were.
--
-- Source: FAO/Government of Kenya. 2018. Kenya Food Composition
-- Tables. Nairobi. Notes on the values:
--   * "tr" (trace) is stored as 0; a blank (unknown) stays null.
--   * Phytate is only given for cereals, legumes and a few others;
--     animal foods, sugar, oil and salt contain none (0).
--   * Beef uses "Beef, lean, raw" (07002): the medium-fat row
--     (07004) lists more iron than liver, which looks like an error.
--   * Cooking oil is sunflower oil (09013), converted to per 100 ml
--     (x 0.92). KFCT has no vitamin A-fortified oil.
--   * Iodine isn't in KFCT 2018, so it isn't tracked.
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. New nutrient columns
-- ------------------------------------------------------------
alter table food_nutrition
  add column if not exists magnesium_mg numeric check (magnesium_mg >= 0),
  add column if not exists thiamin_mg numeric check (thiamin_mg >= 0),
  add column if not exists riboflavin_mg numeric check (riboflavin_mg >= 0),
  add column if not exists niacin_mg numeric check (niacin_mg >= 0),
  add column if not exists folate_ug numeric check (folate_ug >= 0),         -- dietary folate equivalents
  add column if not exists vitamin_b12_ug numeric check (vitamin_b12_ug >= 0),
  add column if not exists phytate_mg numeric check (phytate_mg >= 0),
  add column if not exists kfct_code text;

alter table attendance_nutrition
  add column if not exists magnesium_mg numeric,
  add column if not exists thiamin_mg numeric,
  add column if not exists riboflavin_mg numeric,
  add column if not exists niacin_mg numeric,
  add column if not exists folate_ug numeric,
  add column if not exists vitamin_b12_ug numeric,
  add column if not exists phytate_mg numeric;

-- ------------------------------------------------------------
-- 2. Exact KFCT 2018 values for the shared foods
-- ------------------------------------------------------------
create temporary table kfct (
  name text, unit text, pack numeric, code text,
  kcal numeric, protein numeric, fat numeric, carb numeric, fibre numeric,
  ca numeric, fe numeric, mg numeric, zn numeric,
  vita numeric, thiamin numeric, ribo numeric, niacin numeric, folate numeric, b12 numeric, vitc numeric,
  phytate numeric
) on commit drop;

insert into kfct values
  -- name                              unit      pack  code     kcal  prot  fat   carb  fibre  Ca    Fe    Mg   Zn    VitA  B1    B2    B3    Fol  B12   VitC  Phyt
  ('Maize',                            'kg',     90,   '01018', 345,  7.94, 4.5,  63.4, 9.4,   24,   2.6,  75,  1.88, 0,    0.25, 0.1,  2,    71,  0,    0,    615),
  ('Maize flour',                      'kg',     null, '01022', 345,  7.9,  4.5,  63.4, 9.4,   9,    2.6,  110, 1.88, 0,    0.25, 0.1,  2,    71,  0,    0,    615),
  ('Maize flour (fortified, packaged)','kg',     null, '01020', 352,  6.8,  3,    72.3, 4.5,   20,   3.6,  50,  4.36, 71,   0.5,  0.31, 3.69, 523, 0,    0,    622),
  ('Maize (yellow)',                   'kg',     90,   '01019', 340,  8.3,  3.7,  62.5, 11.9,  7,    3.9,  104, 2.3,  20,   0.5,  0.12, 2.2,  33,  0,    0,    null),
  ('Rice',                             'kg',     null, '01034', 353,  7.6,  1,    78.1, 0.7,   21,   0.9,  23,  1.32, 0,    0.07, 0.11, 1.1,  9,   0,    0,    295),
  ('Beans',                            'kg',     90,   '03004', 305,  20.5, 2,    40.6, 21.2,  106,  6.4,  103, 2.78, 1,    0.35, 0.18, 2.4,  272, 0,    0.3,  623),
  ('Green grams',                      'kg',     null, '03019', 311,  27.2, 1.7,  38.4, 16.7,  151,  7.6,  208, 2.62, 9,    0.52, 0.2,  2.2,  607, 0,    3.0,  368),
  ('Lentils',                          'kg',     null, '03020', 318,  28.4, 0.6,  41.3, 16.8,  83,   7.4,  101, 4,    1,    0.4,  0.19, 2.54, 132, 0,    6.8,  564),
  ('Sorghum',                          'kg',     null, '01039', 341,  10.8, 3.5,  60.5, 11.9,  18,   6.4,  101, 1.69, 1,    0.24, 0.11, 3.3,  64,  0,    0,    532),
  ('Millet flour',                     'kg',     null, '01026', 306,  7.4,  2,    53.3, 22.6,  344,  18.5, 154, 1.7,  0,    0.19, 0.04, 4.6,  93,  0,    0,    null),
  ('Wheat flour',                      'kg',     null, '01043', 349,  11.2, 1.6,  70.7, 3.6,   35,   5.6,  31,  0.87, 93,   0.91, 0.57, 5.9,  577, 0.7,  0,    123),
  ('Cooking oil',                      'litres', null, '09013', 828,  0,    92,   0,    0,     0,    0,    0,   0.01, 0,    0,    0,    0,    0,   0,    0,    0),
  ('Salt',                             'kg',     null, '13027', 0,    0,    0,    0,    0,     32,   0.1,  1,   0.1,  0,    0,    0,    0,    0,   0,    0,    0),
  ('Milk',                             'litres', null, '06022', 70,   3.3,  3.5,  6.1,  0,     119,  0.1,  11,  0.63, 41,   0,    0.27, 0,    8,   0.59, 0,    0),
  ('Sugar',                            'kg',     50,   '11003', 400,  0,    0,    100,  0,     0,    0,    0,   0,    0,    0,    0,    0,    0,   0,    0,    0),
  ('Kale (sukuma wiki)',               'kg',     null, '04020', 29,   3.0,  0.3,  1.2,  4.7,   402,  2.8,  41,  0.5,  177,  0.11, 0.13, 1.0,  62,  0,    134,  null),
  ('Cabbage',                          'kg',     null, '04007', 18,   1.1,  0.1,  2.2,  2.2,   47,   0.5,  9,   0.2,  0,    0.04, 0.04, 0.4,  15,  0,    50,   null),
  ('Irish potatoes',                   'kg',     50,   '02009', 105,  2.4,  0.1,  22.7, 1.68,  9,    1.4,  19,  0.32, 0,    0.07, 0.04, 1.2,  53,  0,    6.6,  81),
  ('Sweet potatoes',                   'kg',     null, '02013', 101,  1.7,  0.4,  20.8, 4,     22,   0.4,  12,  0.28, 8,    0.07, 0.03, 0.8,  16,  0,    18,   null),
  ('Sweet potatoes (orange-fleshed)',  'kg',     null, '02014', 76.9, 1.9,  0.1,  15.6, 3,     27,   0.5,  14,  0.5,  517,  0.03, 0.05, 1,    11,  0,    31,   null),
  ('Beef',                             'kg',     null, '07002', 104,  20.6, 2.3,  0.4,  0,     5,    2.3,  24,  4.22, 6,    0,    0.23, 5.2,  2,   2.42, 0.5,  0),
  ('Bread',                            'kg',     null, '01007', 249,  7.7,  1.9,  48.8, 3.1,   37,   1.7,  27,  0.8,  0,    0.16, 0.06, 3.8,  28,  0.07, 0,    null),
  ('Eggs',                             'kg',     null, '07011', 134,  12.7, 8.1,  2.4,  0,     54,   1.7,  14,  1.13, 186,  0.12, 0.51, 0,    83,  1.7,  0,    0),
  ('Omena (dried)',                    'kg',     null, '08002', 333,  59.5, 10.6, 0,    0,     2790, 6.9,  98,  16,   141,  0.34, 0.52, 18.2, 46,  60,   0,    0);

-- Foods missing from the shared list are added, unless a school
-- already has its own food with that name.
insert into food_items (item_name, unit, pack_size)
select k.name, k.unit, k.pack from kfct k
where not exists (select 1 from food_items f where lower(btrim(f.item_name)) = lower(k.name));

-- Shared values: replace them with KFCT's.
delete from food_nutrition n
using food_items f, kfct k
where n.food_id = f.food_id and f.school_id is null and n.school_id is null
  and lower(btrim(f.item_name)) = lower(k.name);

insert into food_nutrition (food_id, school_id, energy_kcal, protein_g, carbohydrate_g, fat_g, fibre_g,
                            calcium_mg, iron_mg, magnesium_mg, zinc_mg, vitamin_a_ug, thiamin_mg,
                            riboflavin_mg, niacin_mg, folate_ug, vitamin_b12_ug, vitamin_c_mg,
                            phytate_mg, kfct_code, source)
select f.food_id, null, k.kcal, k.protein, k.carb, k.fat, k.fibre, k.ca, k.fe, k.mg, k.zn, k.vita,
       k.thiamin, k.ribo, k.niacin, k.folate, k.b12, k.vitc, k.phytate, k.code,
       'Kenya Food Composition Tables 2018 (FAO/Government of Kenya), food ' || k.code
from kfct k
join food_items f on f.school_id is null and lower(btrim(f.item_name)) = lower(k.name);

-- ------------------------------------------------------------
-- 3. A school's own values: the new nutrients can be set too
-- ------------------------------------------------------------
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
                 'iron_mg', 'magnesium_mg', 'zinc_mg', 'vitamin_a_ug', 'thiamin_mg', 'riboflavin_mg',
                 'niacin_mg', 'folate_ug', 'vitamin_b12_ug', 'vitamin_c_mg', 'phytate_mg') then
      raise exception 'Unknown nutrient %', k using errcode = '22023';
    end if;
  end loop;

  delete from food_nutrition where food_id = p_food_id and school_id = v_school_id;
  insert into food_nutrition (food_id, school_id, energy_kcal, protein_g, carbohydrate_g, fat_g,
                              fibre_g, calcium_mg, iron_mg, magnesium_mg, zinc_mg, vitamin_a_ug,
                              thiamin_mg, riboflavin_mg, niacin_mg, folate_ug, vitamin_b12_ug,
                              vitamin_c_mg, phytate_mg, source, updated_by)
  values (p_food_id, v_school_id,
          (p_values ->> 'energy_kcal')::numeric, (p_values ->> 'protein_g')::numeric,
          (p_values ->> 'carbohydrate_g')::numeric, (p_values ->> 'fat_g')::numeric,
          (p_values ->> 'fibre_g')::numeric, (p_values ->> 'calcium_mg')::numeric,
          (p_values ->> 'iron_mg')::numeric, (p_values ->> 'magnesium_mg')::numeric,
          (p_values ->> 'zinc_mg')::numeric, (p_values ->> 'vitamin_a_ug')::numeric,
          (p_values ->> 'thiamin_mg')::numeric, (p_values ->> 'riboflavin_mg')::numeric,
          (p_values ->> 'niacin_mg')::numeric, (p_values ->> 'folate_ug')::numeric,
          (p_values ->> 'vitamin_b12_ug')::numeric, (p_values ->> 'vitamin_c_mg')::numeric,
          (p_values ->> 'phytate_mg')::numeric, btrim(p_source), auth.uid());
end;
$$;

-- The school's food list with the values it uses: its own where it
-- set them, otherwise the shared ones (value by value).
drop function if exists public.school_food_nutrition(uuid);
create function public.school_food_nutrition(p_school_id uuid)
returns table (food_id uuid, item_name text, unit text, energy_kcal numeric, protein_g numeric,
               carbohydrate_g numeric, fat_g numeric, fibre_g numeric, calcium_mg numeric,
               iron_mg numeric, magnesium_mg numeric, zinc_mg numeric, vitamin_a_ug numeric,
               thiamin_mg numeric, riboflavin_mg numeric, niacin_mg numeric, folate_ug numeric,
               vitamin_b12_ug numeric, vitamin_c_mg numeric, phytate_mg numeric,
               kfct_code text, source text, is_school_value boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.food_id, f.item_name, f.unit,
         coalesce(o.energy_kcal, d.energy_kcal), coalesce(o.protein_g, d.protein_g),
         coalesce(o.carbohydrate_g, d.carbohydrate_g), coalesce(o.fat_g, d.fat_g),
         coalesce(o.fibre_g, d.fibre_g), coalesce(o.calcium_mg, d.calcium_mg),
         coalesce(o.iron_mg, d.iron_mg), coalesce(o.magnesium_mg, d.magnesium_mg),
         coalesce(o.zinc_mg, d.zinc_mg), coalesce(o.vitamin_a_ug, d.vitamin_a_ug),
         coalesce(o.thiamin_mg, d.thiamin_mg), coalesce(o.riboflavin_mg, d.riboflavin_mg),
         coalesce(o.niacin_mg, d.niacin_mg), coalesce(o.folate_ug, d.folate_ug),
         coalesce(o.vitamin_b12_ug, d.vitamin_b12_ug), coalesce(o.vitamin_c_mg, d.vitamin_c_mg),
         coalesce(o.phytate_mg, d.phytate_mg),
         case when o.food_id is null then d.kfct_code end,
         coalesce(o.source, d.source), o.food_id is not null
  from food_items f
  left join food_nutrition d on d.food_id = f.food_id and d.school_id is null
  left join food_nutrition o on o.food_id = f.food_id and o.school_id = p_school_id
  where (f.school_id is null or f.school_id = p_school_id)
    -- A school's own foods and values only for its staff (or the system).
    and (auth.uid() is null or public.can_view_school(p_school_id))
  order by f.item_name;
$$;

revoke all on function public.school_food_nutrition(uuid) from public;
grant execute on function public.school_food_nutrition(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. Each student's meal record, with the new nutrients
-- ------------------------------------------------------------
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
           'kfct_code', n.kfct_code,
           'per_100', jsonb_build_object(
             'energy_kcal', n.energy_kcal, 'protein_g', n.protein_g,
             'carbohydrate_g', n.carbohydrate_g, 'fat_g', n.fat_g, 'fibre_g', n.fibre_g,
             'calcium_mg', n.calcium_mg, 'iron_mg', n.iron_mg, 'magnesium_mg', n.magnesium_mg,
             'zinc_mg', n.zinc_mg, 'vitamin_a_ug', n.vitamin_a_ug, 'thiamin_mg', n.thiamin_mg,
             'riboflavin_mg', n.riboflavin_mg, 'niacin_mg', n.niacin_mg, 'folate_ug', n.folate_ug,
             'vitamin_b12_ug', n.vitamin_b12_ug, 'vitamin_c_mg', n.vitamin_c_mg,
             'phytate_mg', n.phytate_mg))
           order by n.item_name), '[]'::jsonb)
    into v_items
    from meal_ingredients mi
    join public.school_food_nutrition(new.school_id) n on n.food_id = mi.food_id
    where mi.meal_id = v_meal_id;

  -- Complete only if there is a serving and every nutrient value of every
  -- food is known. Phytate isn't counted: KFCT gives it for few foods.
  v_complete := v_meal_id is not null and jsonb_array_length(v_items) > 0 and not exists (
    select 1 from jsonb_array_elements(v_items) i, jsonb_each(i -> 'per_100') kv
    where kv.value = 'null'::jsonb and kv.key <> 'phytate_mg');

  insert into attendance_nutrition (
      attendance_id, beneficiary_id, school_id, attendance_date, meal_type, meal_id, meal_name,
      energy_kcal, protein_g, carbohydrate_g, fat_g, fibre_g, calcium_mg, iron_mg, magnesium_mg,
      zinc_mg, vitamin_a_ug, thiamin_mg, riboflavin_mg, niacin_mg, folate_ug, vitamin_b12_ug,
      vitamin_c_mg, phytate_mg, complete, ingredients)
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
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'magnesium_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'zinc_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'vitamin_a_ug')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'thiamin_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 3) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'riboflavin_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 3) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'niacin_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'folate_ug')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'vitamin_b12_ug')::numeric, 0) * (i ->> 'amount')::numeric / 100), 2) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'vitamin_c_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 1) end,
         case when v_meal_id is null then null else round(sum(coalesce((i -> 'per_100' ->> 'phytate_mg')::numeric, 0) * (i ->> 'amount')::numeric / 100), 0) end,
         v_complete, v_items
  from (select null::jsonb as i where jsonb_array_length(v_items) = 0
        union all
        select e from jsonb_array_elements(v_items) e) items
  on conflict (attendance_id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

commit;

-- The shared values now in use (shown in the results panel).
select f.item_name as food, n.kfct_code, n.iron_mg, n.zinc_mg, n.vitamin_a_ug, n.folate_ug,
       n.vitamin_b12_ug, n.phytate_mg
from food_items f
join food_nutrition n on n.food_id = f.food_id and n.school_id is null
where f.school_id is null
order by f.item_name;
