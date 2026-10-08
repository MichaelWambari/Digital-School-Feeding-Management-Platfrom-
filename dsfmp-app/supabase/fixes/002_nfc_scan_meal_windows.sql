-- ============================================================
-- Fix 002: file NFC attendance scans under the right meal
--
-- record_nfc_scan() used to save every attendance scan as
-- 'lunch' with the server's UTC date. It now picks the meal from
-- the serving window the scan falls in (Nairobi time):
--   breakfast 06:00-07:00, lunch 12:00-14:00, supper 18:00-20:00
-- (end times exclusive) and records the Nairobi date. Scans
-- outside every window are rejected with 'outside_meal_time'
-- and logged to nfc_tag_logs. Distribution scans are unchanged.
--
-- The function signature is unchanged, so the ESP32 readers need
-- no update. Safe to run on a live database: it replaces the
-- function in place and touches no existing data.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

create or replace function record_nfc_scan(
  p_nfc_tag_id text,
  p_device_id text,
  p_mode text default 'attendance', -- 'attendance' or 'distribution'
  p_item_id uuid default null,      -- required when p_mode = 'distribution'
  p_quantity numeric default 1
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_beneficiary beneficiaries%rowtype;
  v_device_status text;
  -- Serving windows are in school (Nairobi) time, not the server's UTC clock.
  v_local_now timestamp := now() at time zone 'Africa/Nairobi';
  v_meal_type text;
begin
  if p_nfc_tag_id is null or btrim(p_nfc_tag_id) = '' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'invalid_tag');
    return json_build_object('success', false, 'error', 'invalid_tag');
  end if;

  select status into v_device_status from nfc_devices where device_id = p_device_id;
  if v_device_status is null or v_device_status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'inactive_device');
    return json_build_object('success', false, 'error', 'unregistered_or_inactive_device');
  end if;

  if p_mode is null or p_mode not in ('attendance', 'distribution') then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'invalid_mode');
    return json_build_object('success', false, 'error', 'invalid_mode');
  end if;

  select * into v_beneficiary from beneficiaries where nfc_tag_id = p_nfc_tag_id;
  if v_beneficiary.beneficiary_id is null then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'unknown_tag');
    return json_build_object('success', false, 'error', 'unknown_tag');
  end if;

  if v_beneficiary.status <> 'active' then
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'not_eligible');
    return json_build_object('success', false, 'error', 'not_eligible');
  end if;

  if p_mode = 'distribution' then
    if p_item_id is null or p_quantity is null or p_quantity <= 0
      or not exists (select 1 from inventory_items where item_id = p_item_id) then
      insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
        values (p_nfc_tag_id, p_device_id, 'invalid_distribution');
      return json_build_object('success', false, 'error', 'invalid_distribution');
    end if;

    begin
    insert into food_distribution (beneficiary_id, item_id, device_id, quantity_issued)
      values (v_beneficiary.beneficiary_id, p_item_id, p_device_id, p_quantity);
    exception when check_violation then
      insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
        values (p_nfc_tag_id, p_device_id, 'insufficient_stock');
      return json_build_object('success', false, 'error', 'insufficient_stock');
    end;
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'distribution_recorded');
  else
    -- The meal is decided by the serving window the scan falls in (end time exclusive).
    v_meal_type := case
      when v_local_now::time >= '06:00' and v_local_now::time < '07:00' then 'breakfast'
      when v_local_now::time >= '12:00' and v_local_now::time < '14:00' then 'lunch'
      when v_local_now::time >= '18:00' and v_local_now::time < '20:00' then 'supper'
    end;
    if v_meal_type is null then
      insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
        values (p_nfc_tag_id, p_device_id, 'outside_meal_time');
      return json_build_object('success', false, 'error', 'outside_meal_time');
    end if;

    insert into meal_attendance
        (beneficiary_id, nfc_tag_id, device_id, meal_type, attendance_date, status)
      values (v_beneficiary.beneficiary_id, p_nfc_tag_id, p_device_id,
              v_meal_type, v_local_now::date, 'present')
      on conflict (beneficiary_id, attendance_date, meal_type) do nothing;
    insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
      values (p_nfc_tag_id, p_device_id, 'attendance_recorded');
  end if;

  return json_build_object('success', true, 'first_name', split_part(v_beneficiary.full_name, ' ', 1));
end;
$$;

grant execute on function record_nfc_scan(text, text, text, uuid, numeric) to anon, authenticated;
