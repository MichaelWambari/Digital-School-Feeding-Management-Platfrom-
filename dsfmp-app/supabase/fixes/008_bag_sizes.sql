-- ============================================================
-- Fix 008: bag sizes
--
-- Food is delivered in bags (kg foods) or jerrycans (litre
-- foods), so each food can now have a pack size: maize in bags
-- of 90 kg, cooking oil in jerrycans of 20 litres, and so on.
-- Stock is still counted in kg or litres; the app shows it in
-- bags as well ("900 kg · 10 bags of 90 kg") and lets deliveries
-- and dispatches be entered as a number of bags.
--
--   * food_items.pack_size: kg per bag (or litres per jerrycan),
--     or empty for food that isn't bagged.
--   * Common staples get the usual sizes below if they have none
--     yet. Change any of them in the app: Inventory > the food > Edit.
--
-- Run it once, after fix 007. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

alter table food_items add column if not exists pack_size numeric;
alter table food_items drop constraint if exists food_items_pack_size_check;
alter table food_items add constraint food_items_pack_size_check
  check (pack_size is null or pack_size > 0);

-- The network admin sets it from the app, like the name and unit.
grant insert (pack_size), update (pack_size) on food_items to authenticated;

update food_items f
set pack_size = v.pack_size
from (values
  ('maize',          90),
  ('beans',          90),
  ('green grams',    90),
  ('sorghum',        90),
  ('rice',           50),
  ('lentils',        50),
  ('maize flour',    50),
  ('wheat flour',    50),
  ('millet flour',   50),
  ('porridge flour', 25),
  ('salt',           50),
  ('cooking oil',    20)
) as v(item_name, pack_size)
where lower(btrim(f.item_name)) = v.item_name and f.pack_size is null;

commit;

-- Every food's unit and pack size (shown in the results panel).
select item_name as food, unit,
       case when pack_size is null then 'not bagged'
            else 'per ' || case when unit = 'litres' then 'jerrycan' else 'bag' end
                 || ': ' || pack_size || ' ' || unit end as pack
from food_items
order by item_name;
