-- ============================================================
-- Fix 020: nutrients lost in cooking, and students' dates of birth
--
-- 1. Cooking losses. Food values are for raw food, but cooking
--    destroys some vitamins, washes out some minerals and breaks
--    down part of the phytate. retention_factors holds the share
--    of each nutrient that stays in the food after cooking, from
--    the Kenya Food Composition Tables 2018, Table VI (vitamins)
--    and Table VII (minerals and phytate), which KFCT took from
--    Vásquez-Caicedo (2008). Only cooking methods with values in
--    both tables are included.
--      * Every shared food gets the usual way schools cook it
--        (food_items.default_cooking), e.g. maize "grain, stewed"
--        as in githeri, kale "leafy vegetables, fried".
--      * A dish can say how each of its foods is cooked
--        (meal_ingredients.cooking_method); when it doesn't, the
--        food's usual way is used. A school's own foods count as
--        not cooked until it says otherwise.
--      * Energy, protein, fat, carbohydrate and fibre are not
--        changed: KFCT gives no retention factors for them.
--    Each student's meal record now stores the nutrients after
--    cooking, and the factors used for each food (in ingredients).
--    Records made since fix 018 are worked out again with the
--    cooking losses, from the food values stored in them; older
--    records are left as they were.
-- 2. Students can have a date of birth. When it is set, the age is
--    worked out from it (and kept up to date in the needs
--    assessment, which uses the age at the end of the period).
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Retention factors (share kept after cooking, 0-1)
-- ------------------------------------------------------------
create table if not exists retention_factors (
  method text primary key,
  food_group text not null,
  label text not null,
  sort int not null,
  vitamin_a numeric not null,      -- vitamin A, RAE and RE alike
  thiamin_mg numeric not null,
  riboflavin_mg numeric not null,
  niacin_mg numeric not null,
  folate_ug numeric not null,
  vitamin_b12_ug numeric not null,
  vitamin_c_mg numeric not null,
  calcium_mg numeric not null,
  iron_mg numeric not null,
  magnesium_mg numeric not null,
  zinc_mg numeric not null,
  phytate_mg numeric not null,     -- KFCT's apparent retention factor
  kfct_name text,                  -- the row name in KFCT Tables VI and VII
  source text not null default 'Kenya Food Composition Tables 2018, Tables VI and VII (from Vásquez-Caicedo 2008)'
);

alter table retention_factors enable row level security;
drop policy if exists "Signed-in users read retention factors" on retention_factors;
create policy "Signed-in users read retention factors"
  on retention_factors for select to authenticated using (true);
revoke insert, update, delete on retention_factors from anon, authenticated;

insert into retention_factors (method, food_group, label, sort, vitamin_a, thiamin_mg, riboflavin_mg,
  niacin_mg, folate_ug, vitamin_b12_ug, vitamin_c_mg, calcium_mg, iron_mg, magnesium_mg, zinc_mg,
  phytate_mg, kfct_name) values
  --                                                                                                   VitA  B1    B2    B3    Fol   B12   C     Ca    Fe    Mg    Zn    Phyt
  ('none',                  'Other',      'Not cooked, or bought ready to eat',                1,  1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    null),
  ('grain_stewed',          'Cereals',    'Grain, stewed (e.g. maize in githeri)',             10, 0.95, 0.75, 1.00, 0.95, 0.80, 0.95, 0.70, 1,    1,    1,    1,    0.51, 'Grain or grain product, stewed'),
  ('grain_whole_boiled',    'Cereals',    'Whole grain, boiled and drained',                   11, 0.90, 0.50, 0.75, 0.75, 0.70, 0.75, 0.70, 1,    1,    1,    0.95, 0.51, 'Rice or other grain, whole, boiled'),
  ('grain_polished_boiled', 'Cereals',    'Rice, boiled (water absorbed)',                     12, 0.95, 0.75, 1.00, 0.95, 0.80, 0.95, 0.70, 1,    1,    1,    1,    0.51, 'Rice or other grain, polished, boiled (with cooking liquid)'),
  ('flour_boiled',          'Cereals',    'Flour, boiled (ugali, porridge)',                   13, 0.90, 0.80, 0.90, 0.90, 0.70, 1.00, 0.80, 1,    1,    1,    1,    0.83, 'Flour or grain product, boiled/steamed'),
  ('flour_fried',           'Cereals',    'Flour, fried (chapati, mandazi)',                   14, 0.90, 0.90, 0.90, 0.90, 0.70, 1.00, 0.85, 1,    1,    1,    1,    0.83, 'Flour or starch sauteed/stir fried'),
  ('pulse_unsoaked_stewed', 'Legumes',    'Beans or pulses, not soaked, stewed',               20, 1.00, 0.80, 1.00, 0.80, 0.60, 1.00, 0.60, 1,    1,    1,    1,    0.81, 'Pulse dish, unsoaked, stewed'),
  ('pulse_soaked_stewed',   'Legumes',    'Beans or pulses, soaked, stewed',                   21, 1.00, 0.80, 1.00, 0.80, 0.60, 1.00, 0.60, 1,    1,    1,    1,    0.67, 'Pulse dish, soaked and stewed'),
  ('pulse_unsoaked_boiled', 'Legumes',    'Beans or pulses, not soaked, boiled and drained',   22, 1.00, 0.65, 0.75, 0.65, 0.50, 1.00, 0.60, 0.85, 0.85, 0.85, 0.90, 0.81, 'Pulse dish, unsoaked, boiled'),
  ('pulse_soaked_boiled',   'Legumes',    'Beans or pulses, soaked, boiled and drained',       23, 1.00, 0.65, 0.75, 0.65, 0.50, 1.00, 0.60, 0.85, 0.85, 0.85, 0.90, 0.67, 'Pulse dish, soaked and boiled'),
  ('starchy_root_boiled',   'Roots',      'Potatoes or other starchy roots, boiled',           30, 0.95, 0.78, 0.88, 0.75, 0.63, 0.75, 0.70, 0.95, 0.93, 0.90, 0.90, 0.59, 'Starchy root or potato, boiled'),
  ('root_stewed',           'Roots',      'Roots or tubers, stewed',                           31, 0.90, 0.90, 0.95, 0.95, 0.70, 0.70, 0.85, 1,    1,    1,    1,    0.54, 'Root, tuber and bulb vegetables, stewed'),
  ('starchy_root_fried',    'Roots',      'Potatoes or starchy roots, deep fried',             32, 0.95, 0.83, 0.98, 0.95, 0.78, 0.85, 0.93, 1,    1,    1,    1,    0.59, 'Starchy root or potato deep fried'),
  ('leafy_sauteed',         'Vegetables', 'Leafy vegetables, fried (e.g. sukuma wiki)',        40, 0.93, 0.90, 0.95, 0.95, 0.70, 0.83, 0.82, 1,    1,    1,    1,    0.54, 'Leafy vegetables, sauteed/stir fried'),
  ('leafy_stewed',          'Vegetables', 'Leafy vegetables, stewed',                          41, 0.90, 0.90, 0.95, 0.95, 0.70, 0.70, 0.60, 1,    1,    1,    1,    0.54, 'Leafy vegetables, stewed'),
  ('leafy_boiled',          'Vegetables', 'Leafy vegetables, boiled and drained',              42, 0.90, 0.65, 0.65, 0.65, 0.50, 0.60, 0.40, 0.95, 0.75, 0.60, 0.75, 0.90, 'Leafy vegetables, boiled'),
  ('veg_stewed',            'Vegetables', 'Other vegetables, stewed',                          43, 0.90, 0.90, 0.95, 0.95, 0.70, 0.70, 0.80, 1,    1,    1,    1,    0.54, 'Stem, flower, fruit, corn, seed, stewed'),
  ('veg_boiled',            'Vegetables', 'Other vegetables, boiled and drained',              44, 0.90, 0.65, 0.65, 0.65, 0.50, 0.70, 0.65, 0.95, 0.75, 0.60, 0.75, 0.90, 'Stem, flower, fruit, corn, seed, boiled'),
  ('milk_boiled',           'Milk',       'Milk, boiled',                                      50, 1.00, 0.90, 0.95, 0.95, 0.80, 0.95, 0.70, 1,    1,    1,    1,    1,    'Milk, milk product or milk substitute, boiled'),
  ('fish_sauce',            'Fish',       'Fish, in a stew or sauce',                          60, 0.90, 0.85, 1.00, 0.95, 0.85, 0.90, 0.85, 1,    1,    1,    1,    1,    'Low fat fish, with sauce, cooked by moist heat'),
  ('fish_boiled',           'Fish',       'Fish, boiled (no sauce)',                           61, 0.90, 0.75, 0.70, 0.70, 0.70, 0.80, 0.80, 1,    0.80, 0.85, 1,    1,    'Low fat fish, cooked by moist heat'),
  ('fish_fried',            'Fish',       'Fish, deep fried',                                  62, 0.90, 0.80, 0.90, 0.90, 0.80, 0.90, 0.80, 1,    0.85, 0.90, 1,    1,    'Low fat fish, deep fried'),
  ('beef_stewed',           'Meat',       'Beef, stewed',                                      70, 0.75, 0.45, 0.85, 0.60, 0.65, 0.60, 1.00, 0.85, 1,    0.65, 1,    1,    'Beef, stewed/braised'),
  ('beef_boiled',           'Meat',       'Beef, boiled',                                      71, 0.75, 0.40, 0.80, 0.50, 0.65, 0.60, 1.00, 0.80, 1,    0.60, 1,    1,    'Beef, boiled/steamed'),
  ('chicken_boiled',        'Meat',       'Chicken, boiled',                                   72, 0.55, 0.55, 0.95, 0.60, 0.50, 0.50, 1.00, 0.85, 0.80, 0.70, 1,    1,    'Chicken, boiled/steamed'),
  ('egg_boiled',            'Eggs',       'Eggs, boiled',                                      80, 0.95, 0.80, 0.80, 0.80, 0.80, 0.80, 0.80, 0.95, 0.95, 0.95, 0.95, 1,    'Egg or egg product, cooked by moist heat (boiled)'),
  ('egg_fried',             'Eggs',       'Eggs, fried',                                       81, 0.95, 0.83, 0.83, 0.95, 0.70, 0.95, 0.80, 1,    1,    1,    1,    1,    'Egg or egg product, cooked with fat or oil (fried)'),
  ('oil_fried',             'Fats',       'Oil, used for cooking',                             90, 0.50, 1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    1,    'Fat or oil, cooked with fat or oil (fried)')
on conflict (method) do update set
  food_group = excluded.food_group, label = excluded.label, sort = excluded.sort,
  vitamin_a = excluded.vitamin_a, thiamin_mg = excluded.thiamin_mg,
  riboflavin_mg = excluded.riboflavin_mg, niacin_mg = excluded.niacin_mg,
  folate_ug = excluded.folate_ug, vitamin_b12_ug = excluded.vitamin_b12_ug,
  vitamin_c_mg = excluded.vitamin_c_mg, calcium_mg = excluded.calcium_mg,
  iron_mg = excluded.iron_mg, magnesium_mg = excluded.magnesium_mg, zinc_mg = excluded.zinc_mg,
  phytate_mg = excluded.phytate_mg, kfct_name = excluded.kfct_name;

-- The factors for one cooking method, keyed like nutrient_keys()
-- (1 for nutrients without a factor, and for an unknown method).
create or replace function public.cooking_retention(p_method text)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_object_agg(k, coalesce(
           case when k in ('vitamin_a_ug', 'vitamin_a_re_ug') then r.vitamin_a
                else (to_jsonb(r) ->> k)::numeric end, 1))
  from unnest(public.nutrient_keys()) k
  left join retention_factors r on r.method = coalesce(p_method, 'none');
$$;

-- ------------------------------------------------------------
-- 2. How each food is usually cooked, and how a dish cooks it
-- ------------------------------------------------------------
alter table food_items add column if not exists default_cooking text references retention_factors(method);
alter table meal_ingredients add column if not exists cooking_method text references retention_factors(method);

grant insert (default_cooking), update (default_cooking) on food_items to authenticated;
grant update (cooking_method) on meal_ingredients to authenticated;

update food_items f set default_cooking = v.method
from food_nutrition n, (values
  ('01018', 'grain_stewed'), ('01019', 'grain_stewed'), ('01039', 'grain_stewed'),
  ('01022', 'flour_boiled'), ('01020', 'flour_boiled'), ('01026', 'flour_boiled'),
  ('01043', 'flour_fried'), ('01034', 'grain_polished_boiled'),
  ('03004', 'pulse_unsoaked_stewed'), ('03019', 'pulse_unsoaked_stewed'), ('03020', 'pulse_unsoaked_stewed'),
  ('09013', 'oil_fried'), ('13027', 'none'), ('11003', 'none'), ('01007', 'none'),
  ('06022', 'milk_boiled'), ('04020', 'leafy_sauteed'), ('04007', 'leafy_sauteed'),
  ('02009', 'starchy_root_boiled'), ('02013', 'starchy_root_boiled'), ('02014', 'starchy_root_boiled'),
  ('07002', 'beef_stewed'), ('07011', 'egg_boiled'), ('08002', 'fish_sauce')
) as v(code, method)
where f.school_id is null and n.food_id = f.food_id and n.school_id is null and n.kfct_code = v.code
  and f.default_cooking is null;

-- set_meal_ingredients(): items may say how the food is cooked.
-- p_items: [{"food_id": "...", "amount": 100, "cooking": "grain_stewed"}, ...]
-- ("cooking" left out or null = the food's usual way)
create or replace function public.set_meal_ingredients(p_meal_id uuid, p_items jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
  v_bad text;
begin
  select school_id into v_school_id from meals where meal_id = p_meal_id;
  if v_school_id is null or not public.has_school_permission(v_school_id, 'manage_meals') then
    raise exception 'You don''t have permission to change this dish' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'The serving must be a list of foods' using errcode = '22023';
  end if;
  select i ->> 'cooking' into v_bad
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
  where nullif(i ->> 'cooking', '') is not null
    and not exists (select 1 from retention_factors r where r.method = i ->> 'cooking')
  limit 1;
  if v_bad is not null then
    raise exception 'Unknown cooking method %', v_bad using errcode = '22023';
  end if;

  delete from meal_ingredients where meal_id = p_meal_id;
  insert into meal_ingredients (meal_id, food_id, school_id, amount_per_serving, cooking_method)
  select p_meal_id, (i ->> 'food_id')::uuid, v_school_id, (i ->> 'amount')::numeric,
         nullif(i ->> 'cooking', '')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as i;
end;
$$;

revoke all on function public.set_meal_ingredients(uuid, jsonb) from public;
grant execute on function public.set_meal_ingredients(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 3. Each student's meal record, after cooking
-- ------------------------------------------------------------
alter table attendance_nutrition add column if not exists cooked boolean not null default false;

-- Totals for a list of foods: amount x value per 100 x share kept.
create or replace function public.nutrition_totals(p_items jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_object_agg(k, total)
  from (select k, round(sum(coalesce((i -> 'per_100' ->> k)::numeric, 0)
                            * (i ->> 'amount')::numeric / 100
                            * coalesce((i -> 'retention' ->> k)::numeric, 1)), 2) as total
        from unnest(public.nutrient_keys()) k cross join jsonb_array_elements(p_items) i
        group by k) t;
$$;

create or replace function public.record_attendance_nutrition()
returns trigger as $$
declare
  v_keys text[] := public.nutrient_keys();
  v_meal_id uuid;
  v_meal_name text;
  v_items jsonb;
  v_totals jsonb;
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
           'per_100', (select jsonb_object_agg(k, to_jsonb(n) -> k) from unnest(v_keys) k),
           'cooking', coalesce(mi.cooking_method, f.default_cooking, 'none'),
           'retention', public.cooking_retention(coalesce(mi.cooking_method, f.default_cooking, 'none')))
           order by n.item_name), '[]'::jsonb)
    into v_items
    from meal_ingredients mi
    join food_items f on f.food_id = mi.food_id
    join public.school_food_nutrition(new.school_id) n on n.food_id = mi.food_id
    where mi.meal_id = v_meal_id;

  v_complete := v_meal_id is not null and jsonb_array_length(v_items) > 0 and not exists (
    select 1 from jsonb_array_elements(v_items) i, jsonb_each(i -> 'per_100') kv
    where kv.value = 'null'::jsonb and kv.key <> 'phytate_mg');

  if v_meal_id is not null and jsonb_array_length(v_items) > 0 then
    v_totals := public.nutrition_totals(v_items);
  end if;

  insert into attendance_nutrition
  select * from jsonb_populate_record(null::attendance_nutrition,
    coalesce(v_totals, '{}'::jsonb) || jsonb_build_object(
      'attendance_id', new.attendance_id, 'beneficiary_id', new.beneficiary_id,
      'school_id', new.school_id, 'attendance_date', new.attendance_date,
      'meal_type', new.meal_type, 'meal_id', v_meal_id, 'meal_name', v_meal_name,
      'complete', v_complete, 'ingredients', v_items, 'cooked', true, 'created_at', now()))
  on conflict (attendance_id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Records made since fix 018 (they store every nutrient's value per
-- 100 g): work them out again with the cooking losses. The dish's
-- current cooking method is used, else the food's usual way.
do $$
declare
  a attendance_nutrition%rowtype;
  v_items jsonb;
begin
  for a in select * from attendance_nutrition
           where not cooked and vitamin_a_re_ug is not null and jsonb_array_length(ingredients) > 0 loop
    select jsonb_agg(i || jsonb_build_object(
             'cooking', m.method, 'retention', public.cooking_retention(m.method)))
      into v_items
    from jsonb_array_elements(a.ingredients) i
    cross join lateral (
      select coalesce(
        (select mi.cooking_method from meal_ingredients mi
          where mi.meal_id = a.meal_id and mi.food_id = (i ->> 'food_id')::uuid),
        (select f.default_cooking from food_items f where f.food_id = (i ->> 'food_id')::uuid),
        'none') as method) m;

    delete from attendance_nutrition where attendance_id = a.attendance_id;
    insert into attendance_nutrition
    select * from jsonb_populate_record(null::attendance_nutrition,
      to_jsonb(a) || public.nutrition_totals(v_items)
        || jsonb_build_object('ingredients', v_items, 'cooked', true));
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 4. Students' dates of birth
-- ------------------------------------------------------------
alter table beneficiaries add column if not exists date_of_birth date;

-- With a date of birth, the age is worked out from it.
create or replace function public.set_age_from_birth()
returns trigger as $$
begin
  if new.date_of_birth is not null then
    if new.date_of_birth > current_date then
      raise exception 'The date of birth can''t be in the future' using errcode = '22023';
    end if;
    new.age := extract(year from age(current_date, new.date_of_birth))::int;
    if new.age > 30 then
      raise exception 'Check the date of birth: that makes the student % years old', new.age
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

drop trigger if exists set_beneficiary_age on beneficiaries;
create trigger set_beneficiary_age
  before insert or update of date_of_birth, age on beneficiaries
  for each row execute procedure public.set_age_from_birth();

-- The needs assessment uses the age at the end of the period: from
-- the date of birth when there is one, otherwise the age typed in.
create or replace function public.student_nutrient_adequacy(p_beneficiary_id uuid, p_from date, p_to date)
returns table (nutrient text, per_day numeric, requirement numeric, unit text, percent numeric,
               variant text, days int, phytate_zinc numeric, missing text)
language sql stable set search_path = public, pg_temp as $$
  with s as (
    select coalesce(extract(year from age(p_to, date_of_birth))::int, age) as age, sex
    from beneficiaries where beneficiary_id = p_beneficiary_id
  ),
  recs as (
    -- Meals with a dish, recorded since vitamin A in RE was stored.
    select * from attendance_nutrition a
    where a.beneficiary_id = p_beneficiary_id and a.attendance_date between p_from and p_to
      and a.meal_name is not null and a.vitamin_a_re_ug is not null
  ),
  tot as (
    select count(distinct attendance_date)::int as days,
           sum(iron_mg) fe, sum(zinc_mg) zn, sum(vitamin_a_re_ug) va, sum(folate_ug) fol,
           sum(vitamin_b12_ug) b12, sum(calcium_mg) ca, sum(magnesium_mg) mg,
           sum(thiamin_mg) b1, sum(riboflavin_mg) b2, sum(niacin_mg) b3, sum(vitamin_c_mg) vc,
           sum(coalesce(phytate_mg, 0)) phy
    from recs
  ),
  r as (
    select tot.*, case when tot.zn > 0 then round((tot.phy / 660.0) / (tot.zn / 65.4), 1) end as ratio
    from tot
  ),
  vals as (
    select unnest(array['iron_mg', 'zinc_mg', 'vitamin_a_re_ug', 'folate_ug', 'vitamin_b12_ug',
                        'calcium_mg', 'magnesium_mg', 'thiamin_mg', 'riboflavin_mg', 'niacin_mg',
                        'vitamin_c_mg']) as nutrient,
           unnest(array[fe, zn, va, fol, b12, ca, mg, b1, b2, b3, vc]) as total,
           days, ratio
    from r
  ),
  chosen as (
    select v.*,
           case v.nutrient
             when 'zinc_mg' then case when v.ratio > 15 then 'zinc_low' when v.ratio >= 5 then 'zinc_moderate'
                                      else 'zinc_high' end
             when 'iron_mg' then case when v.ratio > 15 then 'iron_5' else 'iron_10' end
             else '' end as variant
    from vals v
  )
  select c.nutrient,
         case when c.days > 0 then round(c.total / c.days, 2) end,
         q.amount, q.unit,
         case when c.days > 0 and q.amount is not null then round(100 * c.total / c.days / q.amount) end,
         nullif(c.variant, ''), c.days, c.ratio,
         case when s.age is null then 'age'
              when s.age >= 10 and s.sex is null then 'sex'
              when s.age < 4 or s.age > 18 then 'age_range' end
  from chosen c
  cross join s
  left join nutrient_requirements q
    on q.nutrient = c.nutrient and q.variant = c.variant
   and s.age between q.age_min and q.age_max
   and (q.sex is null or q.sex = s.sex);
$$;

revoke all on function public.student_nutrient_adequacy(uuid, date, date) from public;
grant execute on function public.student_nutrient_adequacy(uuid, date, date) to authenticated;

commit;
