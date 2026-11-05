-- ============================================================
-- Fix 011: serving amounts
--
-- Each dish on the timetable lists the food in one student's
-- standard serving, e.g. Rice and beans = rice 100 g + beans 80 g
-- + cooking oil 10 ml. The amount is in grams for foods counted
-- in kg, and in millilitres for foods counted in litres.
--
-- With it the system can work out the food a meal used:
-- students who attended x serving. The app pre-fills the food
-- used at each meal with that estimate.
--
--   * meal_ingredients: one row per dish and food.
--   * set_meal_ingredients(): replaces a dish's serving in one go.
--   * expected_food_use(): the estimate for one day's meal.
--
-- Staff with 'manage_meals' set servings; all staff can see them.
--
-- Run it once, after fix 010. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

create table if not exists meal_ingredients (
  meal_id uuid not null references meals(meal_id) on delete cascade,
  food_id uuid not null references food_items(food_id),
  school_id uuid not null references schools(school_id) on delete cascade, -- copied from the dish
  -- Per student: grams for foods counted in kg, millilitres for litres.
  amount_per_serving numeric not null check (amount_per_serving > 0 and amount_per_serving <= 5000),
  created_at timestamptz not null default now(),
  primary key (meal_id, food_id)
);

create index if not exists idx_meal_ingredients_school on meal_ingredients(school_id);

create or replace function public.set_ingredient_school()
returns trigger as $$
begin
  select school_id into new.school_id from meals where meal_id = new.meal_id;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists set_meal_ingredient_school on meal_ingredients;
create trigger set_meal_ingredient_school
  before insert or update of meal_id on meal_ingredients
  for each row execute procedure public.set_ingredient_school();

alter table meal_ingredients enable row level security;

drop policy if exists "Staff read their school's servings" on meal_ingredients;
drop policy if exists "Permitted staff manage their school's servings" on meal_ingredients;
create policy "Staff read their school's servings"
  on meal_ingredients for select using (public.can_view_school(school_id));
create policy "Permitted staff manage their school's servings"
  on meal_ingredients for all
  using (public.has_school_permission(school_id, 'manage_meals'))
  with check (public.has_school_permission(school_id, 'manage_meals'));

revoke update on meal_ingredients from authenticated;
grant update (amount_per_serving) on meal_ingredients to authenticated;

drop trigger if exists audit_meal_ingredients on meal_ingredients;
create trigger audit_meal_ingredients after insert or update or delete on meal_ingredients
  for each row execute procedure public.audit_change('meal_id', 'food_id');

-- ------------------------------------------------------------
-- set_meal_ingredients(): replaces a dish's serving.
-- p_items: [{"food_id": "...", "amount": 100}, ...]
-- Runs with the caller's permissions; all or nothing.
-- ------------------------------------------------------------
create or replace function public.set_meal_ingredients(p_meal_id uuid, p_items jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select school_id into v_school_id from meals where meal_id = p_meal_id;
  if v_school_id is null or not public.has_school_permission(v_school_id, 'manage_meals') then
    raise exception 'You don''t have permission to change this dish' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'The serving must be a list of foods' using errcode = '22023';
  end if;

  delete from meal_ingredients where meal_id = p_meal_id;
  insert into meal_ingredients (meal_id, food_id, school_id, amount_per_serving)
  select p_meal_id, (i ->> 'food_id')::uuid, v_school_id, (i ->> 'amount')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as i;
end;
$$;

revoke all on function public.set_meal_ingredients(uuid, jsonb) from public;
grant execute on function public.set_meal_ingredients(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------
-- expected_food_use(): the food one day's meal should have used,
-- from that day's dish and the students who attended. Quantities
-- are in the food's stock unit (kg or litres). Runs with the
-- caller's permissions.
-- ------------------------------------------------------------
create or replace function public.expected_food_use(p_school_id uuid, p_date date, p_meal_type text)
returns table (food_id uuid, item_name text, unit text, amount_per_serving numeric,
               students int, quantity numeric, meal_name text)
language sql stable set search_path = public, pg_temp as $$
  with served as (
    select count(*)::int as n from meal_attendance
    where school_id = p_school_id and attendance_date = p_date and meal_type = p_meal_type
  ),
  dish as (
    select ms.meal_id, m.name from meal_schedules ms join meals m on m.meal_id = ms.meal_id
    where ms.school_id = p_school_id and ms.meal_type = p_meal_type
      and ms.weekday = extract(isodow from p_date)::int
  )
  select f.food_id, f.item_name, f.unit, mi.amount_per_serving, served.n,
         round(served.n * mi.amount_per_serving / 1000.0, 3), dish.name
  from dish
  join meal_ingredients mi on mi.meal_id = dish.meal_id
  join food_items f on f.food_id = mi.food_id
  cross join served
  order by f.item_name;
$$;

revoke all on function public.expected_food_use(uuid, date, text) from public;
grant execute on function public.expected_food_use(uuid, date, text) to authenticated;

commit;

-- Each dish's serving (shown in the results panel; empty until servings are set).
select s.name as school, m.name as dish,
       string_agg(f.item_name || ' ' || mi.amount_per_serving
                  || case when f.unit = 'litres' then ' ml' else ' g' end, ', ' order by f.item_name) as per_student
from meal_ingredients mi
join meals m using (meal_id)
join food_items f using (food_id)
join schools s on s.school_id = mi.school_id
group by s.name, m.name
order by s.name, m.name;
