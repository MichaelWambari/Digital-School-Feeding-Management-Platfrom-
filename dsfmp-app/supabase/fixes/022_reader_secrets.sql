-- ============================================================
-- Fix 022: a secret for each NFC reader
--
-- Until now a reader proved who it was with its device ID and the
-- public anon key alone, and anyone who knew both could record
-- attendance from a laptop. Now each reader can carry its own
-- secret, which it sends with every tap as p_device_secret.
--
--   * nfc_devices.secret_hash keeps the SHA-256 of the secret (hex).
--     The secret itself is never stored, only shown once when it is
--     made.
--   * record_nfc_scan() rejects a tap with 'bad_device_secret' when
--     the reader has a secret and the tap's secret is missing or
--     wrong. Rejected taps are logged like every other tap.
--   * A reader with no secret (secret_hash is null) works as before,
--     so running this fix breaks no reader. Give each reader a secret,
--     then flash it into that reader's firmware (DEVICE_SECRET).
--
-- Making a reader's secret (shown once; copy it into the firmware):
--
--   select set_device_secret('reader-jasiri-01');
--
-- From the SQL Editor this works for any reader. Through the API,
-- only the headteacher of the reader's school may call it. Calling
-- it again makes a new secret and the old one stops working. To
-- take a reader's secret away (back to no secret):
--
--   update nfc_devices set secret_hash = null where device_id = 'reader-jasiri-01';
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

alter table nfc_devices add column if not exists secret_hash text;

-- ------------------------------------------------------------
-- set_device_secret(): makes a new secret for a reader, keeps its
-- hash and returns the secret. 64 hex characters from two random
-- UUIDs (244 random bits).
-- ------------------------------------------------------------
create or replace function public.set_device_secret(p_device_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_id uuid;
  v_secret text;
begin
  select school_id into v_school_id from nfc_devices where device_id = p_device_id;
  if not found then
    raise exception 'No reader with device ID %', p_device_id using errcode = 'P0002';
  end if;

  -- auth.uid() is null in the SQL Editor; an API caller must be the
  -- headteacher of the reader's school.
  if auth.uid() is not null and not public.has_school_role(v_school_id, array['headteacher']) then
    raise exception 'Only the headteacher of this reader''s school can set its secret'
      using errcode = '42501';
  end if;

  v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update nfc_devices
    set secret_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex')
    where device_id = p_device_id;
  return v_secret;
end;
$$;

revoke all on function public.set_device_secret(text) from public, anon;
grant execute on function public.set_device_secret(text) to authenticated;

-- ------------------------------------------------------------
-- record_nfc_scan(): same as fix 010, plus the reader's secret.
-- The old five-argument version is dropped so the API has a single
-- function to call; readers that send no secret still match this
-- one, because p_device_secret defaults to null.
-- ------------------------------------------------------------
drop function if exists public.record_nfc_scan(text, text, text, uuid, numeric);

create or replace function public.record_nfc_scan(
  p_nfc_tag_id text,
  p_device_id text,
  -- Readers used to issue food per tap too. Only 'attendance' is
  -- accepted now; the unused parameters keep older readers working.
  p_mode text default 'attendance',
  p_item_id uuid default null,
  p_quantity numeric default 1,
  p_device_secret text default null
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

  -- A reader with a secret must send it. Readers without one (not
  -- yet given a secret) are accepted as before.
  if v_device.secret_hash is not null
     and (p_device_secret is null
          or encode(sha256(convert_to(p_device_secret, 'UTF8')), 'hex') <> v_device.secret_hash) then
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_device.school_id, 'bad_device_secret');
    return json_build_object('success', false, 'error', 'bad_device_secret');
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

grant execute on function public.record_nfc_scan(text, text, text, uuid, numeric, text) to anon, authenticated;

commit;

-- Which readers have a secret (shown in the results panel).
select device_id, s.name as school, d.status,
       case when d.secret_hash is null then 'no secret yet' else 'has a secret' end as secret
from nfc_devices d join schools s on s.school_id = d.school_id
order by s.name, device_id;
