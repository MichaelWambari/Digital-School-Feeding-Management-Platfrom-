-- ============================================================
-- Fix 029: taps saved by a reader while it was offline.
--
-- When the reader has no Wi-Fi (or a request fails on the network)
-- it keeps the tap, with the time it was made, and sends it when
-- the connection is back. record_nfc_scan() gains p_scanned_at:
--
--   * null (a live tap): unchanged, the meal is the one being
--     served now.
--   * a time (a saved tap): the meal is the one that was being
--     served at that time. Saved taps never link cards. A time more
--     than 3 days old is refused ('stale_scan'), and so is one more
--     than 5 minutes in the future ('bad_scan_time').
--
-- Sending a saved tap twice is harmless: the second one is
-- 'already_recorded'.
--
-- If the meal was already closed when the saved tap arrives, the
-- closure is brought up to date (refresh_meal_closure()):
--   * 'closed': the student count and each food's served/unserved
--     split are recalculated (the stock deducted stays the same,
--     since that was the amount issued).
--   * 'not_served' (it had no students when it closed): the closure
--     is removed and the meal closed again, so its food is deducted.
--   * 'manual' / 'no_recipe': only the student count is updated.
--
-- meal_attendance and nfc_tag_logs get scanned_at (the tap's time on
-- the reader, null for live taps), so the app and reports can tell
-- saved taps apart.
--
-- Needs fixes 016 (meal close), 022 (reader secrets) and 024 (card
-- linking).
-- ============================================================

alter table meal_attendance add column if not exists scanned_at timestamptz;
alter table nfc_tag_logs add column if not exists scanned_at timestamptz;

comment on column meal_attendance.scanned_at is
  'When the reader read the card, for a tap it saved while offline; null for a live tap.';
comment on column nfc_tag_logs.scanned_at is
  'When the reader read the card, for a tap it saved while offline; null for a live tap.';

-- ------------------------------------------------------------
-- refresh_meal_closure(): brings an already-closed meal up to date
-- after attendance was added late. Internal (record_nfc_scan only).
-- ------------------------------------------------------------
create or replace function public.refresh_meal_closure(p_school_id uuid, p_date date, p_meal_type text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_closure meal_closures%rowtype;
  v_students int;
begin
  select * into v_closure from meal_closures
  where school_id = p_school_id and closure_date = p_date and meal_type = p_meal_type
  for update;
  if not found then
    return;  -- not closed yet: close_due_meals() will count everyone
  end if;

  select count(*)::int into v_students from meal_attendance
  where school_id = p_school_id and attendance_date = p_date and meal_type = p_meal_type;

  if v_closure.status = 'not_served' then
    delete from meal_closures
    where school_id = p_school_id and closure_date = p_date and meal_type = p_meal_type;
    perform public.close_meal(p_school_id, p_date, p_meal_type);
    return;
  end if;

  update meal_closures set students = v_students
  where school_id = p_school_id and closure_date = p_date and meal_type = p_meal_type;

  if v_closure.status = 'closed' then
    update food_consumption fc
    set served_quantity = s.served,
        unserved_quantity = fc.issued_quantity - s.served
    from (
      select fc2.consumption_id,
             least(fc2.issued_quantity,
                   round(v_students * mi.amount_per_serving / 1000.0, 3)) as served
      from food_consumption fc2
      join inventory_items ii on ii.item_id = fc2.item_id
      join meal_ingredients mi on mi.meal_id = v_closure.meal_id and mi.food_id = ii.food_id
      where fc2.school_id = p_school_id and fc2.consumption_date = p_date
        and fc2.meal_type = p_meal_type and fc2.source = 'meal_close'
    ) s
    where fc.consumption_id = s.consumption_id;
  end if;
end;
$$;

revoke all on function public.refresh_meal_closure(uuid, date, text) from public, authenticated, anon;

-- ------------------------------------------------------------
-- record_nfc_scan(): as fix 024, plus p_scanned_at.
-- ------------------------------------------------------------
drop function if exists public.record_nfc_scan(text, text, text, uuid, numeric, text);

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

  -- The meal whose window, in that day's timetable, the tap falls in.
  select * into v_meal from public.current_meal(v_school.school_id, coalesce(p_scanned_at, now()));
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

  -- A saved tap can arrive after its meal was closed.
  if v_saved then
    perform public.refresh_meal_closure(v_school.school_id, v_meal.local_date, v_meal.meal_type);
  end if;

  return json_build_object('success', true,
                           'first_name', split_part(v_beneficiary.full_name, ' ', 1),
                           'meal_type', v_meal.meal_type,
                           'meal_name', v_meal.meal_name);
end;
$$;

grant execute on function public.record_nfc_scan(text, text, text, uuid, numeric, text, timestamptz) to anon, authenticated;
