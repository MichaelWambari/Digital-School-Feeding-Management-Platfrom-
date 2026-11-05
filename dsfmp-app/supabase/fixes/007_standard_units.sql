-- ============================================================
-- Fix 007: every food is measured in kg or litres
--
-- A food's unit used to be free text, so a unit typed as "500kg"
-- or "90kg bags" was shown after every quantity ("10 500kg").
-- This fix:
--
--   * sets each food's unit to 'litres' for liquids (a unit that
--     says litres/ltr/l, or a food named oil, milk or juice) and
--     to 'kg' for everything else;
--   * adds a rule so only 'kg' and 'litres' can be saved from now on.
--
-- Quantities are NOT changed. The result table at the end lists
-- every food with its old and new unit. If an old unit was a bag
-- size (e.g. stock counted in 90 kg bags), the quantities are
-- still counts of bags and need converting: say which foods, and
-- by how much, before recording more stock.
--
-- Run it once, after fixes 001-006. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

drop table if exists unit_changes;
create temp table unit_changes as
select food_id, item_name, unit as old_unit,
       case
         when lower(unit) ~ '(lit(re|er)|ltr|^\s*[0-9.,]*\s*l\s*$)'
           or lower(item_name) ~ '\m(oil|milk|juice)\M' then 'litres'
         else 'kg'
       end as new_unit
from food_items;

update food_items f
set unit = c.new_unit
from unit_changes c
where f.food_id = c.food_id and f.unit is distinct from c.new_unit;

alter table food_items drop constraint if exists food_items_unit_check;
alter table food_items add constraint food_items_unit_check check (unit in ('kg', 'litres'));

commit;

-- What changed (shown in the results panel).
select item_name as food, old_unit, new_unit,
       case when old_unit = new_unit then 'unchanged' else 'changed' end as result
from unit_changes
order by item_name;
