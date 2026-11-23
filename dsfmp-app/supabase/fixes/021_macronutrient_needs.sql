-- ============================================================
-- Fix 021: daily needs for energy and the macronutrients
--
-- The student report shows energy, protein, carbohydrate, fat and
-- fibre as a share of the student's daily need, like the
-- micronutrients (fix 018), and colours each day's energy by it.
--
--   * Energy: FAO/WHO/UNU (2004) Human energy requirements,
--     Tables 4.5 (boys) and 4.6 (girls), moderate activity, for
--     each year of age. Under 10 a student with no sex recorded
--     gets the average of boys and girls.
--   * Protein and carbohydrate: Institute of Medicine (2005)
--     Dietary Reference Intakes, RDA.
--   * Fibre: Institute of Medicine (2005), adequate intake.
--   * Fat: 30% of the energy need (9 kcal per g), the middle of
--     the 25-35% range FAO (2010) gives for ages 4 to 18.
--
-- student_nutrient_adequacy now returns these five as well. When a
-- need is set both for the student's sex and for either sex, the
-- one for their sex is used.
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

delete from nutrient_requirements
where nutrient in ('energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fibre_g');

-- Energy, kcal per day, by year of age (the 17-18 value also covers 18).
insert into nutrient_requirements (nutrient, sex, age_min, age_max, variant, amount, unit, source)
select 'energy_kcal', e.sex, e.age, case when e.age = 17 then 18 else e.age end, '', e.kcal, 'kcal',
       'FAO/WHO/UNU 2004, Human energy requirements, Tables 4.5 and 4.6 (moderate activity)'
from (values
  ('male', 4, 1360), ('male', 5, 1467), ('male', 6, 1573), ('male', 7, 1692), ('male', 8, 1830),
  ('male', 9, 1978), ('male', 10, 2150), ('male', 11, 2341), ('male', 12, 2548), ('male', 13, 2770),
  ('male', 14, 2990), ('male', 15, 3178), ('male', 16, 3322), ('male', 17, 3410),
  ('female', 4, 1241), ('female', 5, 1330), ('female', 6, 1428), ('female', 7, 1554), ('female', 8, 1698),
  ('female', 9, 1854), ('female', 10, 2006), ('female', 11, 2149), ('female', 12, 2276), ('female', 13, 2379),
  ('female', 14, 2449), ('female', 15, 2491), ('female', 16, 2503), ('female', 17, 2503),
  -- under 10, sex not recorded: average of boys and girls
  (null, 4, 1300), (null, 5, 1399), (null, 6, 1501), (null, 7, 1623), (null, 8, 1764), (null, 9, 1916)
) as e(sex, age, kcal);

-- Fat: 30% of energy, in grams.
insert into nutrient_requirements (nutrient, sex, age_min, age_max, variant, amount, unit, source)
select 'fat_g', sex, age_min, age_max, '', round(amount * 0.30 / 9), 'g',
       '30% of the energy need (FAO 2010, Fats and fatty acids in human nutrition: 25-35% for ages 4-18)'
from nutrient_requirements
where nutrient = 'energy_kcal';

insert into nutrient_requirements (nutrient, sex, age_min, age_max, variant, amount, unit, source) values
  ('protein_g', null, 4, 8, '', 19, 'g', 'IOM 2005, Dietary Reference Intakes, RDA'),
  ('protein_g', null, 9, 13, '', 34, 'g', 'IOM 2005, Dietary Reference Intakes, RDA'),
  ('protein_g', 'male', 14, 18, '', 52, 'g', 'IOM 2005, Dietary Reference Intakes, RDA'),
  ('protein_g', 'female', 14, 18, '', 46, 'g', 'IOM 2005, Dietary Reference Intakes, RDA'),
  ('carbohydrate_g', null, 4, 18, '', 130, 'g', 'IOM 2005, Dietary Reference Intakes, RDA'),
  ('fibre_g', null, 4, 8, '', 25, 'g', 'IOM 2005, Dietary Reference Intakes, AI'),
  ('fibre_g', 'male', 9, 13, '', 31, 'g', 'IOM 2005, Dietary Reference Intakes, AI'),
  ('fibre_g', 'female', 9, 13, '', 26, 'g', 'IOM 2005, Dietary Reference Intakes, AI'),
  -- age 9, sex not recorded: average of boys and girls
  ('fibre_g', null, 9, 9, '', 28.5, 'g', 'IOM 2005, Dietary Reference Intakes, AI'),
  ('fibre_g', 'male', 14, 18, '', 38, 'g', 'IOM 2005, Dietary Reference Intakes, AI'),
  ('fibre_g', 'female', 14, 18, '', 26, 'g', 'IOM 2005, Dietary Reference Intakes, AI');

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
           sum(energy_kcal) kcal, sum(protein_g) prot, sum(carbohydrate_g) carb, sum(fat_g) fat,
           sum(fibre_g) fib,
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
                        'vitamin_c_mg', 'energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g',
                        'fibre_g']) as nutrient,
           unnest(array[fe, zn, va, fol, b12, ca, mg, b1, b2, b3, vc, kcal, prot, carb, fat, fib]) as total,
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
  left join lateral (
    select q.amount, q.unit
    from nutrient_requirements q
    where q.nutrient = c.nutrient and q.variant = c.variant
      and s.age between q.age_min and q.age_max
      and (q.sex is null or q.sex = s.sex)
    order by q.sex is null -- the need for the student's sex first
    limit 1
  ) q on true;
$$;

revoke all on function public.student_nutrient_adequacy(uuid, date, date) from public;
grant execute on function public.student_nutrient_adequacy(uuid, date, date) to authenticated;

commit;
