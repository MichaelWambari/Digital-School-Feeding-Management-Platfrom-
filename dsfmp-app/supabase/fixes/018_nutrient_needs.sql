-- ============================================================
-- Fix 018: how much of each student's daily micronutrient needs
-- the school meals provide
--
-- 1. Students get a sex (needed from age 10, when boys' and girls'
--    needs differ).
-- 2. nutrient_requirements holds the FAO/WHO recommended nutrient
--    intakes (RNIs) per day for ages 4-18, from:
--      FAO/WHO (2004). Vitamin and mineral requirements in human
--      nutrition, 2nd ed. Appendix 1, Tables 1 (minerals) and 2
--      (vitamins). https://www.fao.org/4/y2809e/y2809e0o.htm
-- 3. Vitamin A is compared in retinol equivalents (RE), the unit of
--    the FAO/WHO safe intakes, so foods now also store KFCT's RE value
--    (for plant foods it is twice the RAE value already stored).
-- 4. student_nutrient_adequacy() gives, for one student and period,
--    the average provided per day of meals and the % of the daily
--    RNI it covers. school_nutrient_adequacy() sums that up per
--    nutrient for the whole school: how many students fall below a
--    target share of their needs.
--
-- How iron and zinc needs are chosen: they depend on how well the
-- diet is absorbed. FAO/WHO give zinc needs for high, moderate and
-- low bioavailability, and iron needs for 15%, 12%, 10% and 5%.
-- The student's own meals decide which applies, from their
-- phytate:zinc molar ratio over the period:
--   above 15: zinc "low" and iron 5% (phytate-rich cereal and legume
--             diet, e.g. whole maize and beans)
--   5 to 15:  zinc "moderate", iron 10%
--   below 5:  zinc "high", iron 10%
-- Girls aged 13-14 are assumed to have started menstruating (FAO/WHO
-- list both cases for 10-14; 15-18 is for menstruating girls).
-- Niacin needs are in niacin equivalents, which include the niacin
-- made from protein; KFCT gives preformed niacin only, so niacin is
-- under-counted. Only meals recorded after this fix are assessed.
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Students' sex
-- ------------------------------------------------------------
alter table beneficiaries add column if not exists sex text;
alter table beneficiaries drop constraint if exists beneficiaries_sex_check;
alter table beneficiaries add constraint beneficiaries_sex_check check (sex in ('female', 'male'));

-- ------------------------------------------------------------
-- 2. Vitamin A in retinol equivalents
-- ------------------------------------------------------------
alter table food_nutrition add column if not exists vitamin_a_re_ug numeric check (vitamin_a_re_ug >= 0);
alter table attendance_nutrition add column if not exists vitamin_a_re_ug numeric;

update food_nutrition n set vitamin_a_re_ug = v.re
from (values
  ('01018', 0), ('01022', 0), ('01020', 71), ('01019', 40), ('01034', 0), ('03004', 1),
  ('03019', 18), ('03020', 2), ('01039', 3), ('01026', 0), ('01043', 93), ('09013', 0),
  ('13027', 0), ('06022', 43), ('11003', 0), ('04020', 355), ('04007', 0), ('02009', 0),
  ('02013', 17), ('02014', 1030), ('07002', 7), ('01007', 0), ('07011', 186), ('08002', 141)
) as v(code, re)
where n.school_id is null and n.kfct_code = v.code;

-- The nutrients worked out for each meal, in one place.
create or replace function public.nutrient_keys()
returns text[] language sql immutable as $$
  select array['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fibre_g',
               'calcium_mg', 'iron_mg', 'magnesium_mg', 'zinc_mg', 'vitamin_a_ug',
               'vitamin_a_re_ug', 'thiamin_mg', 'riboflavin_mg', 'niacin_mg', 'folate_ug',
               'vitamin_b12_ug', 'vitamin_c_mg', 'phytate_mg']
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
    if not k = any (public.nutrient_keys()) then
      raise exception 'Unknown nutrient %', k using errcode = '22023';
    end if;
  end loop;

  delete from food_nutrition where food_id = p_food_id and school_id = v_school_id;
  insert into food_nutrition
  select * from jsonb_populate_record(null::food_nutrition,
    coalesce(p_values, '{}'::jsonb) || jsonb_build_object(
      'nutrition_id', gen_random_uuid(), 'food_id', p_food_id, 'school_id', v_school_id,
      'kfct_code', null, 'source', btrim(p_source), 'updated_by', auth.uid(), 'updated_at', now()));
end;
$$;

drop function if exists public.school_food_nutrition(uuid);
create function public.school_food_nutrition(p_school_id uuid)
returns table (food_id uuid, item_name text, unit text, energy_kcal numeric, protein_g numeric,
               carbohydrate_g numeric, fat_g numeric, fibre_g numeric, calcium_mg numeric,
               iron_mg numeric, magnesium_mg numeric, zinc_mg numeric, vitamin_a_ug numeric,
               vitamin_a_re_ug numeric, thiamin_mg numeric, riboflavin_mg numeric,
               niacin_mg numeric, folate_ug numeric, vitamin_b12_ug numeric,
               vitamin_c_mg numeric, phytate_mg numeric, kfct_code text, source text,
               is_school_value boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.food_id, f.item_name, f.unit,
         coalesce(o.energy_kcal, d.energy_kcal), coalesce(o.protein_g, d.protein_g),
         coalesce(o.carbohydrate_g, d.carbohydrate_g), coalesce(o.fat_g, d.fat_g),
         coalesce(o.fibre_g, d.fibre_g), coalesce(o.calcium_mg, d.calcium_mg),
         coalesce(o.iron_mg, d.iron_mg), coalesce(o.magnesium_mg, d.magnesium_mg),
         coalesce(o.zinc_mg, d.zinc_mg), coalesce(o.vitamin_a_ug, d.vitamin_a_ug),
         coalesce(o.vitamin_a_re_ug, d.vitamin_a_re_ug),
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

-- Each student's meal record: every nutrient in nutrient_keys(), as
-- amount (g or ml) x value per 100. Unknown values count as 0 and
-- mark the record incomplete (phytate excepted: KFCT has few values).
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
           'per_100', (select jsonb_object_agg(k, to_jsonb(n) -> k) from unnest(v_keys) k))
           order by n.item_name), '[]'::jsonb)
    into v_items
    from meal_ingredients mi
    join public.school_food_nutrition(new.school_id) n on n.food_id = mi.food_id
    where mi.meal_id = v_meal_id;

  v_complete := v_meal_id is not null and jsonb_array_length(v_items) > 0 and not exists (
    select 1 from jsonb_array_elements(v_items) i, jsonb_each(i -> 'per_100') kv
    where kv.value = 'null'::jsonb and kv.key <> 'phytate_mg');

  if v_meal_id is not null and jsonb_array_length(v_items) > 0 then
    select jsonb_object_agg(k, total) into v_totals
    from (select k, round(sum(coalesce((i -> 'per_100' ->> k)::numeric, 0)
                              * (i ->> 'amount')::numeric / 100), 2) as total
          from unnest(v_keys) k cross join jsonb_array_elements(v_items) i
          group by k) t;
  end if;

  insert into attendance_nutrition
  select * from jsonb_populate_record(null::attendance_nutrition,
    coalesce(v_totals, '{}'::jsonb) || jsonb_build_object(
      'attendance_id', new.attendance_id, 'beneficiary_id', new.beneficiary_id,
      'school_id', new.school_id, 'attendance_date', new.attendance_date,
      'meal_type', new.meal_type, 'meal_id', v_meal_id, 'meal_name', v_meal_name,
      'complete', v_complete, 'ingredients', v_items, 'created_at', now()))
  on conflict (attendance_id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 3. FAO/WHO recommended nutrient intakes per day, ages 4-18
-- variant: '' for most nutrients; zinc_high/moderate/low and
-- iron_15/12/10/5 (% bioavailability) for zinc and iron.
-- ------------------------------------------------------------
create table if not exists nutrient_requirements (
  nutrient text not null,
  sex text check (sex in ('female', 'male')), -- null = both
  age_min int not null,
  age_max int not null,
  variant text not null default '',
  amount numeric not null check (amount > 0),
  unit text not null,
  source text not null default 'FAO/WHO 2004, Vitamin and mineral requirements in human nutrition, Appendix 1'
);

create unique index if not exists nutrient_requirements_key
  on nutrient_requirements (nutrient, coalesce(sex, ''), age_min, variant);

alter table nutrient_requirements enable row level security;
drop policy if exists "Signed-in users read nutrient requirements" on nutrient_requirements;
create policy "Signed-in users read nutrient requirements"
  on nutrient_requirements for select to authenticated using (true);
revoke insert, update, delete on nutrient_requirements from anon, authenticated;

delete from nutrient_requirements;
insert into nutrient_requirements (nutrient, sex, age_min, age_max, variant, amount, unit) values
  -- Table 1, minerals
  ('calcium_mg', null, 4, 6, '', 600, 'mg'), ('calcium_mg', null, 7, 9, '', 700, 'mg'),
  ('calcium_mg', 'male', 10, 18, '', 1300, 'mg'), ('calcium_mg', 'female', 10, 18, '', 1300, 'mg'),
  ('magnesium_mg', null, 4, 6, '', 73, 'mg'), ('magnesium_mg', null, 7, 9, '', 100, 'mg'),
  ('magnesium_mg', 'male', 10, 18, '', 250, 'mg'), ('magnesium_mg', 'female', 10, 18, '', 230, 'mg'),
  ('zinc_mg', null, 4, 6, 'zinc_high', 3.1, 'mg'), ('zinc_mg', null, 4, 6, 'zinc_moderate', 5.1, 'mg'),
  ('zinc_mg', null, 4, 6, 'zinc_low', 10.3, 'mg'),
  ('zinc_mg', null, 7, 9, 'zinc_high', 3.3, 'mg'), ('zinc_mg', null, 7, 9, 'zinc_moderate', 5.6, 'mg'),
  ('zinc_mg', null, 7, 9, 'zinc_low', 11.3, 'mg'),
  ('zinc_mg', 'male', 10, 18, 'zinc_high', 5.7, 'mg'), ('zinc_mg', 'male', 10, 18, 'zinc_moderate', 9.7, 'mg'),
  ('zinc_mg', 'male', 10, 18, 'zinc_low', 19.2, 'mg'),
  ('zinc_mg', 'female', 10, 18, 'zinc_high', 4.6, 'mg'), ('zinc_mg', 'female', 10, 18, 'zinc_moderate', 7.8, 'mg'),
  ('zinc_mg', 'female', 10, 18, 'zinc_low', 15.5, 'mg'),
  ('iron_mg', null, 4, 6, 'iron_15', 4, 'mg'), ('iron_mg', null, 4, 6, 'iron_12', 5, 'mg'),
  ('iron_mg', null, 4, 6, 'iron_10', 6, 'mg'), ('iron_mg', null, 4, 6, 'iron_5', 13, 'mg'),
  ('iron_mg', null, 7, 9, 'iron_15', 6, 'mg'), ('iron_mg', null, 7, 9, 'iron_12', 7, 'mg'),
  ('iron_mg', null, 7, 9, 'iron_10', 9, 'mg'), ('iron_mg', null, 7, 9, 'iron_5', 18, 'mg'),
  ('iron_mg', 'male', 10, 14, 'iron_15', 10, 'mg'), ('iron_mg', 'male', 10, 14, 'iron_12', 12, 'mg'),
  ('iron_mg', 'male', 10, 14, 'iron_10', 15, 'mg'), ('iron_mg', 'male', 10, 14, 'iron_5', 29, 'mg'),
  ('iron_mg', 'male', 15, 18, 'iron_15', 12, 'mg'), ('iron_mg', 'male', 15, 18, 'iron_12', 16, 'mg'),
  ('iron_mg', 'male', 15, 18, 'iron_10', 19, 'mg'), ('iron_mg', 'male', 15, 18, 'iron_5', 38, 'mg'),
  -- girls 10-12: non-menstruating; 13-14: menstruating; 15-18
  ('iron_mg', 'female', 10, 12, 'iron_15', 9, 'mg'), ('iron_mg', 'female', 10, 12, 'iron_12', 12, 'mg'),
  ('iron_mg', 'female', 10, 12, 'iron_10', 14, 'mg'), ('iron_mg', 'female', 10, 12, 'iron_5', 28, 'mg'),
  ('iron_mg', 'female', 13, 14, 'iron_15', 22, 'mg'), ('iron_mg', 'female', 13, 14, 'iron_12', 28, 'mg'),
  ('iron_mg', 'female', 13, 14, 'iron_10', 33, 'mg'), ('iron_mg', 'female', 13, 14, 'iron_5', 65, 'mg'),
  ('iron_mg', 'female', 15, 18, 'iron_15', 21, 'mg'), ('iron_mg', 'female', 15, 18, 'iron_12', 26, 'mg'),
  ('iron_mg', 'female', 15, 18, 'iron_10', 31, 'mg'), ('iron_mg', 'female', 15, 18, 'iron_5', 62, 'mg'),
  -- Table 2, vitamins
  ('thiamin_mg', null, 4, 6, '', 0.6, 'mg'), ('thiamin_mg', null, 7, 9, '', 0.9, 'mg'),
  ('thiamin_mg', 'male', 10, 18, '', 1.2, 'mg'), ('thiamin_mg', 'female', 10, 18, '', 1.1, 'mg'),
  ('riboflavin_mg', null, 4, 6, '', 0.6, 'mg'), ('riboflavin_mg', null, 7, 9, '', 0.9, 'mg'),
  ('riboflavin_mg', 'male', 10, 18, '', 1.3, 'mg'), ('riboflavin_mg', 'female', 10, 18, '', 1.0, 'mg'),
  ('niacin_mg', null, 4, 6, '', 8, 'mg NE'), ('niacin_mg', null, 7, 9, '', 12, 'mg NE'),
  ('niacin_mg', 'male', 10, 18, '', 16, 'mg NE'), ('niacin_mg', 'female', 10, 18, '', 16, 'mg NE'),
  ('folate_ug', null, 4, 6, '', 200, 'µg DFE'), ('folate_ug', null, 7, 9, '', 300, 'µg DFE'),
  ('folate_ug', 'male', 10, 18, '', 400, 'µg DFE'), ('folate_ug', 'female', 10, 18, '', 400, 'µg DFE'),
  ('vitamin_b12_ug', null, 4, 6, '', 1.2, 'µg'), ('vitamin_b12_ug', null, 7, 9, '', 1.8, 'µg'),
  ('vitamin_b12_ug', 'male', 10, 18, '', 2.4, 'µg'), ('vitamin_b12_ug', 'female', 10, 18, '', 2.4, 'µg'),
  ('vitamin_c_mg', null, 4, 6, '', 30, 'mg'), ('vitamin_c_mg', null, 7, 9, '', 35, 'mg'),
  ('vitamin_c_mg', 'male', 10, 18, '', 40, 'mg'), ('vitamin_c_mg', 'female', 10, 18, '', 40, 'mg'),
  ('vitamin_a_re_ug', null, 4, 6, '', 450, 'µg RE'), ('vitamin_a_re_ug', null, 7, 9, '', 500, 'µg RE'),
  ('vitamin_a_re_ug', 'male', 10, 18, '', 600, 'µg RE'), ('vitamin_a_re_ug', 'female', 10, 18, '', 600, 'µg RE');

-- ------------------------------------------------------------
-- 4. % of daily needs met, per student and per school
-- Runs with the caller's permissions (attendance_nutrition needs
-- view_nutrition).
-- ------------------------------------------------------------
create or replace function public.student_nutrient_adequacy(p_beneficiary_id uuid, p_from date, p_to date)
returns table (nutrient text, per_day numeric, requirement numeric, unit text, percent numeric,
               variant text, days int, phytate_zinc numeric, missing text)
language sql stable set search_path = public, pg_temp as $$
  with s as (
    select age, sex from beneficiaries where beneficiary_id = p_beneficiary_id
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

create or replace function public.school_nutrient_adequacy(
  p_school_id uuid, p_from date, p_to date, p_target numeric default 30)
returns table (nutrient text, students int, below_target int, median_percent numeric, not_assessed int)
language sql stable set search_path = public, pg_temp as $$
  select a.nutrient,
         count(a.percent)::int,
         count(*) filter (where a.percent < p_target)::int,
         round(percentile_cont(0.5) within group (order by a.percent)::numeric),
         count(*) filter (where a.percent is null)::int
  from beneficiaries b
  cross join lateral public.student_nutrient_adequacy(b.beneficiary_id, p_from, p_to) a
  where b.school_id = p_school_id and b.status = 'active' and a.days > 0
  group by a.nutrient;
$$;

revoke all on function public.school_nutrient_adequacy(uuid, date, date, numeric) from public;
grant execute on function public.school_nutrient_adequacy(uuid, date, date, numeric) to authenticated;

commit;
