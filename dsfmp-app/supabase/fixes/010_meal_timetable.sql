-- ============================================================
-- Fix 010: meal timetable
--
-- Each school sets its own feeding timetable: for every day of
-- the week, which meals it serves (breakfast, lunch, supper),
-- when each one's attendance window opens and closes (school
-- local time, end exclusive), and which dish is on the menu.
--
--   * meals: the school's dishes, e.g. "Rice and beans". Their
--     ingredients and nutrition values come in the next fix.
--   * meal_schedules: one row per weekday and meal. No row means
--     that meal isn't served that day. Windows on the same day
--     can't overlap.
--   * Each school's current serving windows (schools.breakfast_start
--     and so on) are copied into all seven days, so nothing changes
--     until the school edits its timetable. The old columns stay
--     but are no longer used.
--   * NFC scans now use the timetable for today's weekday, and a
--     second scan for the same meal is rejected as
--     'already_recorded' instead of silently succeeding.
--
-- Staff with the 'manage_meals' permission (the headteacher, and
-- coordinators by default) edit the timetable; all staff can see it.
--
-- Run it once, after fix 009. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- MEALS: the dishes a school serves
-- ------------------------------------------------------------
create table if not exists meals (
  meal_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  description text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists meals_school_name_key on meals (school_id, lower(btrim(name)));

-- ------------------------------------------------------------
-- MEAL_SCHEDULES: the weekly timetable
-- weekday is ISO: 1 = Monday ... 7 = Sunday.
-- ------------------------------------------------------------
create table if not exists meal_schedules (
  schedule_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'supper')),
  start_time time not null,
  end_time time not null,
  meal_id uuid references meals(meal_id) on delete set null, -- the dish; null = not chosen yet
  updated_by uuid references users(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_schedules_window check (start_time < end_time),
  constraint meal_schedules_once_per_day unique (school_id, weekday, meal_type)
);

create index if not exists idx_meal_schedules_school_day on meal_schedules(school_id, weekday);

-- A dish must belong to the same school, and two meals on the same
-- day can't have overlapping windows (a scan must map to one meal).
-- It runs with the caller's permissions, so it only ever looks at
-- (and reports on) the caller's own school's timetable.
create or replace function public.check_meal_schedule()
returns trigger as $$
declare
  v_clash text;
begin
  if new.meal_id is not null
     and not exists (select 1 from meals where meal_id = new.meal_id and school_id = new.school_id) then
    raise exception 'That dish belongs to another school' using errcode = '23514';
  end if;
  select meal_type into v_clash from meal_schedules
    where school_id = new.school_id and weekday = new.weekday
      and schedule_id <> new.schedule_id and meal_type <> new.meal_type
      and start_time < new.end_time and new.start_time < end_time
    limit 1;
  if v_clash is not null then
    raise exception 'The % window overlaps %. Meals on the same day can''t overlap.',
      new.meal_type, v_clash using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

drop trigger if exists check_meal_schedule on meal_schedules;
create trigger check_meal_schedule
  before insert or update on meal_schedules
  for each row execute procedure public.check_meal_schedule();

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

drop trigger if exists touch_meals on meals;
create trigger touch_meals before update on meals
  for each row execute procedure public.touch_updated_at();

-- Copy each school's current windows into all seven days (only for
-- schools that have no timetable yet).
insert into meal_schedules (school_id, weekday, meal_type, start_time, end_time)
select s.school_id, d.weekday, w.meal_type, w.start_time, w.end_time
from schools s
cross join generate_series(1, 7) as d(weekday)
cross join lateral (values
  ('breakfast', s.breakfast_start, s.breakfast_end),
  ('lunch', s.lunch_start, s.lunch_end),
  ('supper', s.supper_start, s.supper_end)
) as w(meal_type, start_time, end_time)
where w.start_time is not null and w.end_time is not null
  and not exists (select 1 from meal_schedules m where m.school_id = s.school_id)
on conflict do nothing;

-- New schools start with the usual Monday-Friday windows.
create or replace function public.add_default_timetable()
returns trigger as $$
begin
  insert into meal_schedules (school_id, weekday, meal_type, start_time, end_time)
  select new.school_id, d.weekday, w.meal_type, w.start_time, w.end_time
  from generate_series(1, 5) as d(weekday)
  cross join (values
    ('breakfast', time '06:00', time '07:00'),
    ('lunch', time '12:00', time '14:00'),
    ('supper', time '18:00', time '20:00')
  ) as w(meal_type, start_time, end_time)
  on conflict do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists on_school_created_timetable on schools;
create trigger on_school_created_timetable
  after insert on schools
  for each row execute procedure public.add_default_timetable();

-- ------------------------------------------------------------
-- Row level security
-- ------------------------------------------------------------
alter table meals enable row level security;
alter table meal_schedules enable row level security;

drop policy if exists "Staff read their school's meals" on meals;
drop policy if exists "Permitted staff manage their school's meals" on meals;
drop policy if exists "Staff read their school's timetable" on meal_schedules;
drop policy if exists "Permitted staff manage their school's timetable" on meal_schedules;

create policy "Staff read their school's meals"
  on meals for select using (public.can_view_school(school_id));
create policy "Permitted staff manage their school's meals"
  on meals for all
  using (public.has_school_permission(school_id, 'manage_meals'))
  with check (public.has_school_permission(school_id, 'manage_meals'));

create policy "Staff read their school's timetable"
  on meal_schedules for select using (public.can_view_school(school_id));
create policy "Permitted staff manage their school's timetable"
  on meal_schedules for all
  using (public.has_school_permission(school_id, 'manage_meals'))
  with check (public.has_school_permission(school_id, 'manage_meals'));

-- Rows can't be moved to another school or have their timestamps set.
revoke update on meals from authenticated;
revoke update on meal_schedules from authenticated;
grant update (name, description, status) on meals to authenticated;
grant update (start_time, end_time, meal_id, updated_by) on meal_schedules to authenticated;

drop trigger if exists audit_meals on meals;
create trigger audit_meals after insert or update or delete on meals
  for each row execute procedure public.audit_change('meal_id');
drop trigger if exists audit_meal_schedules on meal_schedules;
create trigger audit_meal_schedules after insert or update or delete on meal_schedules
  for each row execute procedure public.audit_change('weekday', 'meal_type');

-- ------------------------------------------------------------
-- set_meal_schedule(): sets one meal (window and dish) on several
-- days at once, e.g. lunch 12:30-14:00 Monday to Friday. All days
-- are saved or none is. Runs with the caller's permissions.
-- ------------------------------------------------------------
create or replace function public.set_meal_schedule(
  p_weekdays int[], p_meal_type text, p_start_time time, p_end_time time, p_meal_id uuid default null)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_permission(v_school_id, 'manage_meals') then
    raise exception 'You don''t have permission to change the timetable' using errcode = '42501';
  end if;
  if p_weekdays is null or cardinality(p_weekdays) = 0 then
    raise exception 'Choose at least one day' using errcode = '22023';
  end if;
  insert into meal_schedules (school_id, weekday, meal_type, start_time, end_time, meal_id, updated_by)
  select v_school_id, d, p_meal_type, p_start_time, p_end_time, p_meal_id, auth.uid()
  from (select distinct unnest(p_weekdays) as d) days
  on conflict (school_id, weekday, meal_type) do update
    set start_time = excluded.start_time, end_time = excluded.end_time,
        meal_id = excluded.meal_id, updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.set_meal_schedule(int[], text, time, time, uuid) from public;
grant execute on function public.set_meal_schedule(int[], text, time, time, uuid) to authenticated;

-- ------------------------------------------------------------
-- The meal being served at a school right now, if any (school
-- local time). Used by record_nfc_scan() and by the app. It runs
-- with the caller's permissions, so app users only see their own
-- school's timetable.
-- ------------------------------------------------------------
create or replace function public.current_meal(p_school_id uuid, p_at timestamptz default now())
returns table (schedule_id uuid, meal_type text, meal_id uuid, meal_name text,
               start_time time, end_time time, local_date date)
language sql stable set search_path = public, pg_temp as $$
  select m.schedule_id, m.meal_type, m.meal_id, d.name, m.start_time, m.end_time,
         (p_at at time zone s.timezone)::date
  from schools s
  join meal_schedules m on m.school_id = s.school_id
  left join meals d on d.meal_id = m.meal_id
  where s.school_id = p_school_id
    and m.weekday = extract(isodow from (p_at at time zone s.timezone))::int
    and (p_at at time zone s.timezone)::time >= m.start_time
    and (p_at at time zone s.timezone)::time < m.end_time
  limit 1;
$$;

revoke all on function public.current_meal(uuid, timestamptz) from public;
grant execute on function public.current_meal(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- record_nfc_scan(): the endpoint the ESP32 reader calls. Same as
-- before, except the meal now comes from today's timetable, and a
-- repeat scan for the same meal is rejected as 'already_recorded'.
-- ------------------------------------------------------------
create or replace function record_nfc_scan(
  p_nfc_tag_id text,
  p_device_id text,
  -- Readers used to issue food per tap too. Only 'attendance' is
  -- accepted now; the unused parameters keep older readers working.
  p_mode text default 'attendance',
  p_item_id uuid default null,
  p_quantity numeric default 1
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device nfc_devices%rowtype;
  v_school schools%rowtype;
  v_beneficiary beneficiaries%rowtype;
  v_meal record;
  v_attendance_id uuid;
begin
  if p_nfc_tag_id is null or btrim(p_nfc_tag_id) = '' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'invalid_tag');
    return json_build_object('success', false, 'error', 'invalid_tag');
  end if;

  select * into v_device from nfc_devices where device_id = p_device_id;
  if not found or v_device.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_device.school_id, 'inactive_device');
    return json_build_object('success', false, 'error', 'unregistered_or_inactive_device');
  end if;

  select * into v_school from schools where school_id = v_device.school_id;
  if v_school.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'inactive_school');
    return json_build_object('success', false, 'error', 'inactive_school');
  end if;

  if p_mode is null or p_mode <> 'attendance' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'invalid_mode');
    return json_build_object('success', false, 'error', 'invalid_mode');
  end if;

  select * into v_beneficiary from beneficiaries where nfc_tag_id = p_nfc_tag_id;
  if not found then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'unknown_tag');
    return json_build_object('success', false, 'error', 'unknown_tag');
  end if;

  if v_beneficiary.school_id <> v_school.school_id then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'wrong_school');
    return json_build_object('success', false, 'error', 'wrong_school');
  end if;

  if v_beneficiary.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'not_eligible');
    return json_build_object('success', false, 'error', 'not_eligible');
  end if;

  -- The meal whose window, in today's timetable, the scan falls in.
  select * into v_meal from public.current_meal(v_school.school_id);
  if v_meal.meal_type is null then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'outside_meal_time');
    return json_build_object('success', false, 'error', 'outside_meal_time');
  end if;

  insert into meal_attendance
      (beneficiary_id, nfc_tag_id, device_id, meal_type, attendance_date, status)
    values (v_beneficiary.beneficiary_id, p_nfc_tag_id, p_device_id,
            v_meal.meal_type, v_meal.local_date, 'present')
    on conflict (beneficiary_id, attendance_date, meal_type) do nothing
    returning attendance_id into v_attendance_id;

  if v_attendance_id is null then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'already_recorded');
    return json_build_object('success', false, 'error', 'already_recorded',
                             'first_name', split_part(v_beneficiary.full_name, ' ', 1),
                             'meal_type', v_meal.meal_type);
  end if;

  insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
    values (p_nfc_tag_id, p_device_id, v_school.school_id, 'attendance_recorded');

  return json_build_object('success', true,
                           'first_name', split_part(v_beneficiary.full_name, ' ', 1),
                           'meal_type', v_meal.meal_type,
                           'meal_name', v_meal.meal_name);
end;
$$;

grant execute on function record_nfc_scan(text, text, text, uuid, numeric) to anon, authenticated;

commit;

-- Each school's timetable (shown in the results panel).
select s.name as school, m.meal_type as meal,
       string_agg(m.weekday::text, ',' order by m.weekday) as days,
       to_char(min(m.start_time), 'HH24:MI') || '-' || to_char(max(m.end_time), 'HH24:MI') as window
from meal_schedules m join schools s using (school_id)
group by s.name, m.meal_type
order by s.name, min(m.start_time);
