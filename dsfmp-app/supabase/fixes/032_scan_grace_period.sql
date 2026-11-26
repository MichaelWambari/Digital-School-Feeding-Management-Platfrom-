-- ============================================================
-- Fix 032: a grace period for late taps (#4).
--
-- schools.scan_grace_minutes (0-60, default 0 = as before): a card
-- tapped up to that many minutes after a meal's window ends still
-- counts for that meal. A meal is closed (food used worked out) only
-- once its grace period is over too.
--
--   scan_meal(school, at): the meal being served at that moment, or
--     else the one whose window ended less than the grace period ago
--     (also yesterday's, for a supper ending near midnight).
--   record_nfc_scan(): as fix 029, using scan_meal(); and any tap
--     recorded for a meal already closed brings the closure up to date.
--   close_due_meals(): as fix 016, waiting for the grace period.
--
-- The headteacher sets it on the Timetable screen. Safe to run twice.
-- Needs fixes 016 and 029.
-- ============================================================

alter table schools add column if not exists scan_grace_minutes int not null default 0;
alter table schools drop constraint if exists schools_scan_grace_minutes_range;
alter table schools add constraint schools_scan_grace_minutes_range
  check (scan_grace_minutes between 0 and 60);
grant update (scan_grace_minutes) on schools to authenticated;

-- ------------------------------------------------------------
-- scan_meal()
-- ------------------------------------------------------------
create or replace function public.scan_meal(p_school_id uuid, p_at timestamptz default now())
returns table (schedule_id uuid, meal_type text, meal_id uuid, meal_name text,
               start_time time, end_time time, local_date date)
language sql stable set search_path = public, pg_temp as $$
  select * from (
    select * from public.current_meal(p_school_id, p_at)
    union all
    select m.schedule_id, m.meal_type, m.meal_id, d.name, m.start_time, m.end_time, day.local_date
    from schools s
    cross join lateral (
      select (p_at at time zone s.timezone)::date - g as local_date from generate_series(0, 1) g
    ) day
    join meal_schedules m on m.school_id = s.school_id
                         and m.weekday = extract(isodow from day.local_date)::int
    left join meals d on d.meal_id = m.meal_id
    where s.school_id = p_school_id
      and s.scan_grace_minutes > 0
      and p_at >= ((day.local_date + m.end_time) at time zone s.timezone)
      and p_at < ((day.local_date + m.end_time) at time zone s.timezone)
                 + make_interval(mins => s.scan_grace_minutes)
  ) found
  limit 1;
$$;
revoke all on function public.scan_meal(uuid, timestamptz) from public, anon;
grant execute on function public.scan_meal(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- record_nfc_scan(): as fix 029, with scan_meal().
-- ------------------------------------------------------------
create or replace function public.record_nfc_scan(
  p_nfc_tag_id text,
  p_device_id text,
  -- Readers used to issue food per tap too. Only 'attendance' is
  -- accepted now; the unused parameters keep older readers working.
  p_mode text default 'attendance',
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_device_secret text default null,
  p_scanned_at timestamptz default null
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
  v_link card_link_requests%rowtype;
  v_holder uuid;
  v_meal record;
  v_attendance_id uuid;
  v_saved boolean := p_scanned_at is not null;
begin
  if p_nfc_tag_id is null or btrim(p_nfc_tag_id) = '' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, 'invalid_tag', p_scanned_at);
    return json_build_object('success', false, 'error', 'invalid_tag');
  end if;

  select * into v_device from nfc_devices where device_id = p_device_id;
  if not found or v_device.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_device.school_id, 'inactive_device', p_scanned_at);
    return json_build_object('success', false, 'error', 'unregistered_or_inactive_device');
  end if;

  -- A reader with a secret must send it. Readers without one (not
  -- yet given a secret) are accepted as before.
  if v_device.secret_hash is not null
     and (p_device_secret is null
          or encode(sha256(convert_to(p_device_secret, 'UTF8')), 'hex') <> v_device.secret_hash) then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_device.school_id, 'bad_device_secret', p_scanned_at);
    return json_build_object('success', false, 'error', 'bad_device_secret');
  end if;

  select * into v_school from schools where school_id = v_device.school_id;
  if v_school.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'inactive_school', p_scanned_at);
    return json_build_object('success', false, 'error', 'inactive_school');
  end if;

  if p_mode is null or p_mode <> 'attendance' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'invalid_mode', p_scanned_at);
    return json_build_object('success', false, 'error', 'invalid_mode');
  end if;

  -- A saved tap must be recent and not in the future (the reader's
  -- clock comes from the internet, so a little drift is allowed).
  if v_saved and p_scanned_at > now() + interval '5 minutes' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'bad_scan_time', p_scanned_at);
    return json_build_object('success', false, 'error', 'bad_scan_time');
  end if;
  if v_saved and p_scanned_at < now() - interval '3 days' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'stale_scan', p_scanned_at);
    return json_build_object('success', false, 'error', 'stale_scan');
  end if;

  -- Card linking: a coordinator is waiting for a tap on this reader.
  -- Only live taps link; a saved tap was made before the request.
  if not v_saved then
    select * into v_link from card_link_requests
      where device_id = p_device_id and status = 'pending' and expires_at > now()
      order by created_at desc
      limit 1
      for update;
    if found then
      select * into v_beneficiary from beneficiaries where beneficiary_id = v_link.beneficiary_id;
      select beneficiary_id into v_holder from beneficiaries where nfc_tag_id = p_nfc_tag_id;

      if v_holder is not null and v_holder <> v_link.beneficiary_id then
        update card_link_requests
          set status = 'failed', error = 'card_in_use', nfc_tag_id = p_nfc_tag_id, completed_at = now()
          where request_id = v_link.request_id;
        insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
          values (p_nfc_tag_id, p_device_id, v_school.school_id, 'card_in_use');
        return json_build_object('success', false, 'error', 'card_in_use');
      end if;

      update beneficiaries set nfc_tag_id = p_nfc_tag_id
        where beneficiary_id = v_link.beneficiary_id;
      update card_link_requests
        set status = 'linked', nfc_tag_id = p_nfc_tag_id, completed_at = now()
        where request_id = v_link.request_id;
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'card_linked');
      return json_build_object('success', true, 'linked', true,
                               'first_name', split_part(v_beneficiary.full_name, ' ', 1));
    end if;
  end if;

  select * into v_beneficiary from beneficiaries where nfc_tag_id = p_nfc_tag_id;
  if not found then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'unknown_tag', p_scanned_at);
    return json_build_object('success', false, 'error', 'unknown_tag');
  end if;

  if v_beneficiary.school_id <> v_school.school_id then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'wrong_school', p_scanned_at);
    return json_build_object('success', false, 'error', 'wrong_school');
  end if;

  if v_beneficiary.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'not_eligible', p_scanned_at);
    return json_build_object('success', false, 'error', 'not_eligible');
  end if;

  -- The meal being served when the card was tapped, or the one that
  -- ended less than the school's grace period before.
  select * into v_meal from public.scan_meal(v_school.school_id, coalesce(p_scanned_at, now()));
  if v_meal.meal_type is null then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'outside_meal_time', p_scanned_at);
    return json_build_object('success', false, 'error', 'outside_meal_time');
  end if;

  insert into meal_attendance
      (beneficiary_id, nfc_tag_id, device_id, meal_type, attendance_date, status, scanned_at)
    values (v_beneficiary.beneficiary_id, p_nfc_tag_id, p_device_id,
            v_meal.meal_type, v_meal.local_date, 'present', p_scanned_at)
    on conflict (beneficiary_id, attendance_date, meal_type) do nothing
    returning attendance_id into v_attendance_id;

  if v_attendance_id is null then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'already_recorded', p_scanned_at);
    return json_build_object('success', false, 'error', 'already_recorded',
                             'first_name', split_part(v_beneficiary.full_name, ' ', 1),
                             'meal_type', v_meal.meal_type);
  end if;

  insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type, scanned_at)
    values (p_nfc_tag_id, p_device_id, v_school.school_id, 'attendance_recorded', p_scanned_at);

  -- A saved or late tap can arrive after its meal was closed.
  perform public.refresh_meal_closure(v_school.school_id, v_meal.local_date, v_meal.meal_type);

  return json_build_object('success', true,
                           'first_name', split_part(v_beneficiary.full_name, ' ', 1),
                           'meal_type', v_meal.meal_type,
                           'meal_name', v_meal.meal_name);
end;
$$;

grant execute on function public.record_nfc_scan(text, text, text, uuid, numeric, text, timestamptz) to anon, authenticated;

-- ------------------------------------------------------------
-- close_due_meals(): as fix 016, after the grace period.
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
      -- the meal's end plus the grace period, as a moment in time
      and ((d.day + ms.end_time) at time zone s.timezone)
          + make_interval(mins => s.scan_grace_minutes) <= now()
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
