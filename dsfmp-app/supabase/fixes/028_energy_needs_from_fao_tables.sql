-- ============================================================
-- Fix 028: energy needs exactly as printed by FAO/WHO/UNU (2004)
--
-- Fix 021 stored energy needs that were within 10 kcal (under 1%)
-- of FAO/WHO/UNU (2004) Human energy requirements, but not the
-- values the report and the app cite. This replaces them with the
-- moderate-activity kcal/d printed in Table 4.5 (boys) and Table
-- 4.6 (girls) (fao.org/4/y5686e/y5686e06.htm, checked 24 Nov 2026).
-- FAO rounds them to the nearest 25 kcal.
--
--   * Age N uses the table's "N-(N+1)" row; the 17-18 row also
--     covers 18, as before.
--   * Under 10, a student with no sex recorded gets the average of
--     boys and girls.
--   * The fat needs (30% of energy, 9 kcal per g) are recalculated
--     from the new values.
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run more than once.
-- ============================================================

begin;

delete from nutrient_requirements where nutrient in ('energy_kcal', 'fat_g');

insert into nutrient_requirements (nutrient, sex, age_min, age_max, variant, amount, unit, source)
select 'energy_kcal', e.sex, e.age, case when e.age = 17 then 18 else e.age end, '', e.kcal, 'kcal',
       'FAO/WHO/UNU 2004, Human energy requirements, Tables 4.5 and 4.6 (moderate physical activity)'
from (values
  ('male', 4, 1350), ('male', 5, 1475), ('male', 6, 1575), ('male', 7, 1700), ('male', 8, 1825),
  ('male', 9, 1975), ('male', 10, 2150), ('male', 11, 2350), ('male', 12, 2550), ('male', 13, 2775),
  ('male', 14, 3000), ('male', 15, 3175), ('male', 16, 3325), ('male', 17, 3400),
  ('female', 4, 1250), ('female', 5, 1325), ('female', 6, 1425), ('female', 7, 1550), ('female', 8, 1700),
  ('female', 9, 1850), ('female', 10, 2000), ('female', 11, 2150), ('female', 12, 2275), ('female', 13, 2375),
  ('female', 14, 2450), ('female', 15, 2500), ('female', 16, 2500), ('female', 17, 2500),
  -- under 10, sex not recorded: average of boys and girls
  (null, 4, 1300), (null, 5, 1400), (null, 6, 1500), (null, 7, 1625), (null, 8, 1762.5), (null, 9, 1912.5)
) as e(sex, age, kcal);

insert into nutrient_requirements (nutrient, sex, age_min, age_max, variant, amount, unit, source)
select 'fat_g', sex, age_min, age_max, '', round(amount * 0.30 / 9), 'g',
       '30% of the energy need (FAO 2010, Fats and fatty acids in human nutrition: 25-35% for ages 4-18)'
from nutrient_requirements
where nutrient = 'energy_kcal';

commit;

-- Check (shown in the results panel): 34 energy rows, 34 fat rows.
select nutrient, count(*) as rows, min(amount) as lowest, max(amount) as highest
from nutrient_requirements where nutrient in ('energy_kcal', 'fat_g') group by nutrient order by nutrient;
