-- ============================================================
-- Fix 016: issue sheets and automatic stock deduction
--
-- Before a meal, the kitchen gets an issue sheet: for each food in
-- the day's dish, the amount to take out of the store (expected
-- students x serving). The kitchen can change the amounts and save
-- them. Once the meal's window has closed, the meal is "closed":
--   * the issued amount of each food is taken out of stock,
--   * split into food served (students who attended x serving) and
--     estimated unserved food (issued - served),
--   * and recorded as one food_consumption row per food.
-- Closing happens at most once per school, day and meal, every 15
-- minutes from pg_cron, and also whenever the app opens the Food
-- used tab, so it still works where pg_cron isn't enabled.
--
-- Rules:
--   * Expected students = the school's active students.
--   * A meal with no attendance and no saved issue sheet wasn't
--     served: nothing is deducted ('not_served').
--   * A meal whose food was already entered by hand is left alone
--     ('manual'), and food can't be entered by hand for a meal that
--     has been closed automatically, so nothing is deducted twice.
--   * If the store has less than the issued amount, only what's in
--     stock is deducted; the rest shows as missing from stock.
--   * Only meals that end after this fix is installed (or after a
--     school is created) are closed, so past days are not touched.
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- When automatic closing starts for each school
-- ------------------------------------------------------------
alter table schools add column if not exists meal_close_since timestamptz;
update schools set meal_close_since = now() where meal_close_since is null;
alter table schools alter column meal_close_since set default now();
alter table schools alter column meal_close_since set not null;

-- ------------------------------------------------------------
-- FOOD_CONSUMPTION: what was issued and how it split
-- quantity is still what was taken out of stock. For rows written
-- by a meal close, issued_quantity is what the kitchen issued
-- (quantity is less only if the store ran short), served_quantity
-- is attendance x serving, and unserved_quantity the rest.
-- ------------------------------------------------------------
alter table food_consumption add column if not exists source text not null default 'manual';
alter table food_consumption drop constraint if exists food_consumption_source_check;
alter table food_consumption add constraint food_consumption_source_check
  check (source in ('manual', 'meal_close'));
alter table food_consumption add column if not exists issued_quantity numeric check (issued_quantity >= 0);
alter table food_consumption add column if not exists served_quantity numeric check (served_quantity >= 0);
alter table food_consumption add column if not exists unserved_quantity numeric check (unserved_quantity >= 0);

-- A meal close may take nothing out of stock (the store was empty)
-- but still records what was issued.
alter table food_consumption drop constraint if exists food_consumption_quantity_check;
alter table food_consumption add constraint food_consumption_quantity_check
  check (quantity > 0 or (source = 'meal_close' and quantity = 0));

create or replace function public.log_consumption_as_transaction()
returns trigger as $$
begin
  if new.quantity > 0 then
    insert into inventory_transactions
        (item_id, transaction_type, quantity, transaction_date, consumption_id, recorded_by)
      values (new.item_id, 'used', new.quantity, new.consumption_date,
              new.consumption_id, new.recorded_by);
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- ------------------------------------------------------------
-- MEAL_ISSUES: the kitchen's saved issue sheet
-- Only foods whose amount the kitchen saved have a row; the others
-- use the planned amount.
-- ------------------------------------------------------------
create table if not exists meal_issues (
  school_id uuid not null references schools(school_id) on delete cascade,
  issue_date date not null,
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'supper')),
  food_id uuid not null references food_items(food_id),
  issued_quantity numeric not null check (issued_quantity >= 0 and issued_quantity <= 100000),
  updated_by uuid references users(user_id),
  updated_at timestamptz not null default now(),
  primary key (school_id, issue_date, meal_type, food_id)
);

alter table meal_issues enable row level security;
drop policy if exists "Staff read their school's issue sheets" on meal_issues;
create policy "Staff read their school's issue sheets"
  on meal_issues for select
  using (public.has_school_permission(school_id, 'view_inventory'));
revoke insert, update, delete on meal_issues from authenticated, anon;

-- ------------------------------------------------------------
-- MEAL_CLOSURES: one row per school, day and meal once it's closed
-- ------------------------------------------------------------
create table if not exists meal_closures (
  school_id uuid not null references schools(school_id) on delete cascade,
  closure_date date not null,
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'supper')),
  meal_id uuid references meals(meal_id) on delete set null,
  students int not null default 0,
  status text not null check (status in ('closed', 'not_served', 'manual', 'no_recipe')),
  closed_by uuid references users(user_id), -- null = closed automatically
  closed_at timestamptz not null default now(),
  primary key (school_id, closure_date, meal_type)
);

alter table meal_closures enable row level security;
drop policy if exists "Staff read their school's closed meals" on meal_closures;
create policy "Staff read their school's closed meals"
  on meal_closures for select
  using (public.has_school_permission(school_id, 'view_inventory')
         or public.has_school_permission(school_id, 'view_reports'));
revoke insert, update, delete on meal_closures from authenticated, anon;

-- Food entered by hand can't be added to a meal already closed.
create or replace function public.check_manual_food_use()
returns trigger as $$
begin
  if new.source = 'manual' and exists (
    select 1 from meal_closures c
    join inventory_items i on i.school_id = c.school_id
    where i.item_id = new.item_id
      and c.closure_date = new.consumption_date
      and c.meal_type = new.meal_type
      and c.status = 'closed'
  ) then
    raise exception 'This meal has been closed and its food used worked out automatically'
      using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists check_manual_food_use on food_consumption;
create trigger check_manual_food_use
  before insert on food_consumption
  for each row execute procedure public.check_manual_food_use();

-- ------------------------------------------------------------
-- meal_issue_sheet(): the sheet for one day's meal, for the app.
-- One row per food in the day's dish: the planned amount, the
-- amount to issue (saved or planned), what's in stock, and once the
-- meal is closed, what was served and left unserved.
-- Runs with the caller's permissions.
-- ------------------------------------------------------------
create or replace function public.meal_issue_sheet(p_school_id uuid, p_date date, p_meal_type text)
returns table (food_id uuid, item_name text, unit text, pack_size numeric,
               amount_per_serving numeric, expected_students int, planned_quantity numeric,
               issued_quantity numeric, saved boolean, in_stock numeric,
               students int, taken_from_stock numeric, served_quantity numeric,
               unserved_quantity numeric, meal_name text, closure_status text)
language sql stable set search_path = public, pg_temp as $$
  with dish as (
    select ms.meal_id, m.name from meal_schedules ms join meals m on m.meal_id = ms.meal_id
    where ms.school_id = p_school_id and ms.meal_type = p_meal_type
      and ms.weekday = extract(isodow from p_date)::int
  ),
  expected as (
    select count(*)::int as n from beneficiaries
    where school_id = p_school_id and status = 'active'
  ),
  closure as (
    select * from meal_closures
    where school_id = p_school_id and closure_date = p_date and meal_type = p_meal_type
  ),
  used as (
    select i.food_id, sum(fc.quantity) as taken, sum(fc.issued_quantity) as issued,
           sum(fc.served_quantity) as served, sum(fc.unserved_quantity) as unserved
    from food_consumption fc join inventory_items i on i.item_id = fc.item_id
    where fc.school_id = p_school_id and fc.consumption_date = p_date
      and fc.meal_type = p_meal_type and fc.source = 'meal_close'
    group by i.food_id
  )
  select f.food_id, f.item_name, f.unit, f.pack_size, mi.amount_per_serving, expected.n,
         round(expected.n * mi.amount_per_serving / 1000.0, 3),
         coalesce(used.issued, mi2.issued_quantity, round(expected.n * mi.amount_per_serving / 1000.0, 3)),
         mi2.issued_quantity is not null,
         coalesce(inv.quantity_available, 0),
         closure.students, used.taken, used.served, used.unserved,
         dish.name, closure.status
  from dish
  join meal_ingredients mi on mi.meal_id = dish.meal_id
  join food_items f on f.food_id = mi.food_id
  cross join expected
  left join closure on true
  left join meal_issues mi2 on mi2.school_id = p_school_id and mi2.issue_date = p_date
                            and mi2.meal_type = p_meal_type and mi2.food_id = mi.food_id
  left join inventory_items inv on inv.school_id = p_school_id and inv.food_id = mi.food_id
  left join used on used.food_id = mi.food_id
  order by f.item_name;
$$;

revoke all on function public.meal_issue_sheet(uuid, date, text) from public;
grant execute on function public.meal_issue_sheet(uuid, date, text) to authenticated;

-- ------------------------------------------------------------
-- set_meal_issue(): the kitchen saves the amounts it will issue.
-- p_items: [{"food_id": "...", "quantity": 12.5}, ...] in kg or
-- litres. Only foods in that day's dish, and only before the meal
-- is closed. Headteacher or coordinator.
-- ------------------------------------------------------------
create or replace function public.set_meal_issue(
  p_school_id uuid, p_date date, p_meal_type text, p_items jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item jsonb;
  v_food uuid;
  v_qty numeric;
begin
  if not public.has_school_role(p_school_id, array['headteacher', 'coordinator']) then
    raise exception 'Only the headteacher or a coordinator can change the issue sheet'
      using errcode = '42501';
  end if;
  if exists (select 1 from meal_closures where school_id = p_school_id
             and closure_date = p_date and meal_type = p_meal_type) then
    raise exception 'This meal is already closed' using errcode = '23514';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items must be a JSON array' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_food := (v_item->>'food_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    if v_qty is null or v_qty < 0 then
      raise exception 'Enter an amount of zero or more' using errcode = '22023';
    end if;
    if not exists (
      select 1 from meal_schedules ms join meal_ingredients mi on mi.meal_id = ms.meal_id
      where ms.school_id = p_school_id and ms.meal_type = p_meal_type
        and ms.weekday = extract(isodow from p_date)::int and mi.food_id = v_food
    ) then
      raise exception 'That food is not in this meal''s dish' using errcode = '22023';
    end if;
    insert into meal_issues (school_id, issue_date, meal_type, food_id, issued_quantity, updated_by)
      values (p_school_id, p_date, p_meal_type, v_food, round(v_qty, 3), auth.uid())
      on conflict (school_id, issue_date, meal_type, food_id)
      do update set issued_quantity = excluded.issued_quantity,
                    updated_by = excluded.updated_by, updated_at = now();
  end loop;
end;
$$;

revoke all on function public.set_meal_issue(uuid, date, text, jsonb) from public;
grant execute on function public.set_meal_issue(uuid, date, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- close_meal(): closes one school's meal on one day. Internal: only
-- close_due_meals() calls it. Does nothing if already closed.
-- Returns the closure status, or null if it was already closed.
-- ------------------------------------------------------------
create or replace function public.close_meal(p_school_id uuid, p_date date, p_meal_type text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_meal_id uuid;
  v_students int;
  v_expected int;
  v_status text;
  v_row record;
  v_item_id uuid;
  v_in_stock numeric;
  v_issued numeric;
  v_served numeric;
  v_taken numeric;
begin
  select ms.meal_id into v_meal_id from meal_schedules ms
  where ms.school_id = p_school_id and ms.meal_type = p_meal_type
    and ms.weekday = extract(isodow from p_date)::int;

  select count(*)::int into v_students from meal_attendance
  where school_id = p_school_id and attendance_date = p_date and meal_type = p_meal_type;

  if exists (select 1 from food_consumption where school_id = p_school_id
             and consumption_date = p_date and meal_type = p_meal_type and source = 'manual') then
    v_status := 'manual';
  elsif v_meal_id is null
        or not exists (select 1 from meal_ingredients where meal_id = v_meal_id) then
    v_status := 'no_recipe';
  elsif v_students = 0 and not exists (
          select 1 from meal_issues where school_id = p_school_id
          and issue_date = p_date and meal_type = p_meal_type) then
    v_status := 'not_served';
  else
    v_status := 'closed';
  end if;

  -- Claim the meal first, so two runs can't both deduct it.
  insert into meal_closures (school_id, closure_date, meal_type, meal_id, students, status, closed_by)
    values (p_school_id, p_date, p_meal_type, v_meal_id, v_students, v_status, auth.uid())
    on conflict do nothing;
  if not found then
    return null;
  end if;
  if v_status <> 'closed' then
    return v_status;
  end if;

  select count(*)::int into v_expected from beneficiaries
  where school_id = p_school_id and status = 'active';

  for v_row in
    select mi.food_id, mi.amount_per_serving, iss.issued_quantity
    from meal_ingredients mi
    left join meal_issues iss on iss.school_id = p_school_id and iss.issue_date = p_date
                             and iss.meal_type = p_meal_type and iss.food_id = mi.food_id
    where mi.meal_id = v_meal_id
  loop
    v_issued := coalesce(v_row.issued_quantity, round(v_expected * v_row.amount_per_serving / 1000.0, 3));
    v_served := least(v_issued, round(v_students * v_row.amount_per_serving / 1000.0, 3));
    if v_issued <= 0 then
      continue;
    end if;

    -- The school's stock of this food, locked until the end of the
    -- transaction. A food the school has never stocked gets an empty item.
    select item_id, quantity_available into v_item_id, v_in_stock
    from inventory_items where school_id = p_school_id and food_id = v_row.food_id
    for update;
    if v_item_id is null then
      insert into inventory_items (school_id, food_id, quantity_available)
        values (p_school_id, v_row.food_id, 0)
        returning item_id, quantity_available into v_item_id, v_in_stock;
    end if;
    v_taken := greatest(least(v_issued, v_in_stock), 0);

    insert into food_consumption (item_id, school_id, meal_type, consumption_date, quantity,
                                  source, issued_quantity, served_quantity, unserved_quantity,
                                  recorded_by)
      values (v_item_id, p_school_id, p_meal_type, p_date, v_taken,
              'meal_close', v_issued, v_served, v_issued - v_served, auth.uid());
    v_item_id := null;
  end loop;

  return v_status;
end;
$$;

revoke all on function public.close_meal(uuid, date, text) from public, authenticated, anon;

-- ------------------------------------------------------------
-- close_due_meals(): closes every meal whose window has ended (in
-- the school's time zone) in the last three days and isn't closed
-- yet. pg_cron calls it with no school, for every school; the app
-- calls it for its own school when the Food used tab opens.
-- Returns how many meals it closed.
-- ------------------------------------------------------------
create or replace function public.close_due_meals(p_school_id uuid default null)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_due record;
  v_count int := 0;
begin
  if p_school_id is null then
    -- Every school: only for pg_cron and the database owner.
    if auth.uid() is not null then
      raise exception 'Pass your school' using errcode = '42501';
    end if;
  elsif not public.is_school_member(p_school_id) then
    raise exception 'Not a member of this school' using errcode = '42501';
  end if;

  for v_due in
    select s.school_id, d.day, ms.meal_type
    from schools s
    cross join lateral (
      select (now() at time zone s.timezone)::date - g as day from generate_series(0, 2) g
    ) d
    join meal_schedules ms on ms.school_id = s.school_id
                          and ms.weekday = extract(isodow from d.day)::int
    where (p_school_id is null or s.school_id = p_school_id)
      and s.status = 'active'
      -- the meal's end, as a moment in time
      and ((d.day + ms.end_time) at time zone s.timezone) <= now()
      and ((d.day + ms.end_time) at time zone s.timezone) > s.meal_close_since
      and not exists (select 1 from meal_closures c where c.school_id = s.school_id
                      and c.closure_date = d.day and c.meal_type = ms.meal_type)
    order by d.day, ms.end_time
  loop
    if public.close_meal(v_due.school_id, v_due.day, v_due.meal_type) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.close_due_meals(uuid) from public, anon;
grant execute on function public.close_due_meals(uuid) to authenticated;

commit;

-- ------------------------------------------------------------
-- Run close_due_meals() every 15 minutes with pg_cron. If pg_cron
-- isn't available, this just prints a notice; meals still close
-- whenever the app opens the Food used tab. (In Supabase you can
-- also turn pg_cron on under Database > Extensions.)
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('dsfmp-close-meals', '*/15 * * * *', 'select public.close_due_meals()');
    raise notice 'pg_cron: meals close every 15 minutes';
  else
    raise notice 'pg_cron is not available: meals close when the app opens Food used';
  end if;
exception when others then
  raise notice 'Could not schedule pg_cron (%): meals close when the app opens Food used', sqlerrm;
end;
$$;
