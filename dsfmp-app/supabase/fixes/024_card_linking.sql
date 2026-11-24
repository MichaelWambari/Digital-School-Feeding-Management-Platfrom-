-- ============================================================
-- Fix 024: link a student's card by tapping it
--
-- Instead of typing a card's UID, a coordinator opens the student
-- in the app and presses "Link card", picks the reader, and the
-- student taps their card on it within 60 seconds:
--
--   app:    start_card_link(student, reader)  -> a pending request
--   reader: record_nfc_scan(card, reader)     -> sees the request,
--           saves the card on the student instead of recording
--           attendance, and replies { success, linked: true, first_name }
--   app:    reads the request until it is 'linked' or 'failed'
--
--   * card_link_requests keeps every request and how it ended.
--     Staff who may manage students can read their school's.
--   * Only one request per reader is pending at a time; a new one
--     cancels the old. A request expires after 60 seconds.
--   * While a request is pending, the reader's next tap is used for
--     it, whatever the time, so link cards away from the meal queue.
--   * A card already on another student is refused ('card_in_use')
--     and left where it is. Tapping a student's own card again is
--     fine.
--   * Every link is logged in nfc_tag_logs as 'card_linked' (or
--     'card_in_use').
--
-- Needs fix 022 (reader secrets) first: record_nfc_scan keeps the
-- reader secret check.
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run more than once.
-- ============================================================

begin;

create table if not exists card_link_requests (
  request_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id),
  device_id text not null references nfc_devices(device_id) on delete cascade,
  beneficiary_id uuid not null references beneficiaries(beneficiary_id) on delete cascade,
  requested_by uuid default auth.uid(),
  status text not null default 'pending'
    check (status in ('pending', 'linked', 'failed', 'cancelled')),
  nfc_tag_id text, -- the card that was tapped, once there is one
  error text,      -- why it failed, e.g. 'card_in_use'
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz
);

create index if not exists idx_card_link_requests_pending
  on card_link_requests (device_id) where status = 'pending';

alter table card_link_requests enable row level security;

-- Read only; requests are made, ended and used by the functions below.
drop policy if exists "Student managers read their school's card links" on card_link_requests;
create policy "Student managers read their school's card links"
  on card_link_requests for select
  using (public.has_school_permission(school_id, 'manage_students'));

-- ------------------------------------------------------------
-- start_card_link(): the next tap on this reader, within 60
-- seconds, links that card to this student.
-- ------------------------------------------------------------
create or replace function public.start_card_link(p_beneficiary_id uuid, p_device_id text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_id uuid;
  v_device nfc_devices%rowtype;
  v_request card_link_requests%rowtype;
begin
  select school_id into v_school_id from beneficiaries where beneficiary_id = p_beneficiary_id;
  if not found then
    raise exception 'No such student' using errcode = 'P0002';
  end if;
  if not public.has_school_permission(v_school_id, 'manage_students') then
    raise exception 'You do not have permission to manage students' using errcode = '42501';
  end if;

  select * into v_device from nfc_devices where device_id = p_device_id;
  if not found or v_device.school_id <> v_school_id then
    raise exception 'That reader is not one of this school''s readers' using errcode = 'P0002';
  end if;
  if v_device.status <> 'active' then
    raise exception 'That reader is inactive' using errcode = '22023';
  end if;

  update card_link_requests
    set status = 'cancelled', completed_at = now()
    where device_id = p_device_id and status = 'pending';

  insert into card_link_requests (school_id, device_id, beneficiary_id, expires_at)
    values (v_school_id, p_device_id, p_beneficiary_id, now() + interval '60 seconds')
    returning * into v_request;

  return json_build_object('request_id', v_request.request_id, 'expires_at', v_request.expires_at);
end;
$$;

revoke all on function public.start_card_link(uuid, text) from public, anon;
grant execute on function public.start_card_link(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- cancel_card_link(): stop waiting for a tap.
-- ------------------------------------------------------------
create or replace function public.cancel_card_link(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_id uuid;
begin
  select school_id into v_school_id from card_link_requests where request_id = p_request_id;
  if not found then
    return;
  end if;
  if not public.has_school_permission(v_school_id, 'manage_students') then
    raise exception 'You do not have permission to manage students' using errcode = '42501';
  end if;
  update card_link_requests
    set status = 'cancelled', completed_at = now()
    where request_id = p_request_id and status = 'pending';
end;
$$;

revoke all on function public.cancel_card_link(uuid) from public, anon;
grant execute on function public.cancel_card_link(uuid) to authenticated;

-- ------------------------------------------------------------
-- record_nfc_scan(): same as fix 022, plus card linking. After the
-- reader, its secret and its school are checked, a pending link
-- request on the reader takes the tap.
-- ------------------------------------------------------------
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
  v_link card_link_requests%rowtype;
  v_holder uuid;
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

  -- Card linking: a coordinator is waiting for a tap on this reader.
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
