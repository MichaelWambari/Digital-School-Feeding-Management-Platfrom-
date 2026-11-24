-- ============================================================
-- Fix 027: link a card that was just tapped and refused as unknown
--
-- When a student taps a card nobody has linked yet, the reader
-- refuses it ('unknown_tag') and the tap is logged with the card's
-- UID. Staff who may manage students now see those cards in the app
-- ("Unknown card 04A1B2C3, tapped 2 min ago on Dining hall reader")
-- and can link one to a student, or ignore it. This complements
-- "Link card by tapping" (fix 024) for cards that turn up at a meal.
--
--   * recent_unknown_cards(school, hours): unknown cards tapped on
--     the school's readers recently, leaving out cards that are now
--     linked or were ignored after their last tap.
--   * link_unknown_card(school, card, student): only a card refused
--     at this school's readers in the last 7 days; refused if the card
--     is on another student. Replaces the student's old card, if any.
--   * ignore_unknown_card(school, card): hides it (until tapped again).
--   * Links and ignores are written to nfc_tag_logs
--     ('card_linked', 'card_ignored').
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run more than once.
-- ============================================================

begin;

create index if not exists idx_nfc_tag_logs_school_action_time
  on nfc_tag_logs (school_id, action_type, created_at desc);

create or replace function public.recent_unknown_cards(p_school_id uuid, p_hours int default 24)
returns table (nfc_tag_id text, device_id text, device_name text, last_tap timestamptz, taps int)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_school_permission(p_school_id, 'manage_students') then
    raise exception 'You do not have permission to manage students' using errcode = '42501';
  end if;

  return query
  with taps as (
    select l.nfc_tag_id, l.device_id, l.created_at
    from nfc_tag_logs l
    where l.school_id = p_school_id
      and l.action_type = 'unknown_tag'
      and l.created_at > now() - make_interval(hours => least(greatest(p_hours, 1), 168))
      and l.nfc_tag_id is not null
  ),
  per_card as (
    select t.nfc_tag_id, max(t.created_at) as last_tap, count(*)::int as taps,
           (array_agg(t.device_id order by t.created_at desc))[1] as device_id
    from taps t
    group by t.nfc_tag_id
  )
  select c.nfc_tag_id, c.device_id, coalesce(d.device_name, c.device_id), c.last_tap, c.taps
  from per_card c
  left join nfc_devices d on d.device_id = c.device_id
  where not exists (select 1 from beneficiaries b where b.nfc_tag_id = c.nfc_tag_id)
    and not exists (select 1 from nfc_tag_logs i
                    where i.school_id = p_school_id and i.nfc_tag_id = c.nfc_tag_id
                      and i.action_type = 'card_ignored' and i.created_at >= c.last_tap)
  order by c.last_tap desc
  limit 50;
end;
$$;

revoke all on function public.recent_unknown_cards(uuid, int) from public, anon;
grant execute on function public.recent_unknown_cards(uuid, int) to authenticated;

create or replace function public.link_unknown_card(p_school_id uuid, p_nfc_tag_id text, p_beneficiary_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_card text := upper(btrim(p_nfc_tag_id));
  v_student beneficiaries%rowtype;
  v_holder beneficiaries%rowtype;
  v_device text;
  v_old text;
begin
  if not public.has_school_permission(p_school_id, 'manage_students') then
    raise exception 'You do not have permission to manage students' using errcode = '42501';
  end if;

  select * into v_student from beneficiaries
    where beneficiary_id = p_beneficiary_id and school_id = p_school_id;
  if not found then
    raise exception 'That student is not at this school' using errcode = 'P0002';
  end if;

  -- Only a card that was really tapped on this school's reader.
  select device_id into v_device from nfc_tag_logs
    where school_id = p_school_id and nfc_tag_id = v_card and action_type = 'unknown_tag'
      and created_at > now() - interval '7 days'
    order by created_at desc
    limit 1;
  if v_device is null then
    raise exception 'Card % was not tapped on this school''s readers in the last 7 days', v_card
      using errcode = 'P0002';
  end if;

  select * into v_holder from beneficiaries where nfc_tag_id = v_card;
  if found then
    if v_holder.beneficiary_id = v_student.beneficiary_id then
      return json_build_object('first_name', split_part(v_student.full_name, ' ', 1), 'replaced', null);
    end if;
    raise exception '%', case
      when v_holder.school_id = p_school_id
        then format('Card %s already belongs to %s (%s)', v_card, v_holder.full_name, v_holder.admission_no)
      else format('Card %s already belongs to a student at another school', v_card)
    end using errcode = '23505';
  end if;

  v_old := v_student.nfc_tag_id;
  update beneficiaries set nfc_tag_id = v_card where beneficiary_id = v_student.beneficiary_id;
  insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
    values (v_card, v_device, p_school_id, 'card_linked');

  return json_build_object('first_name', split_part(v_student.full_name, ' ', 1), 'replaced', v_old);
end;
$$;

revoke all on function public.link_unknown_card(uuid, text, uuid) from public, anon;
grant execute on function public.link_unknown_card(uuid, text, uuid) to authenticated;

create or replace function public.ignore_unknown_card(p_school_id uuid, p_nfc_tag_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_school_permission(p_school_id, 'manage_students') then
    raise exception 'You do not have permission to manage students' using errcode = '42501';
  end if;
  insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
    values (upper(btrim(p_nfc_tag_id)), null, p_school_id, 'card_ignored');
end;
$$;

revoke all on function public.ignore_unknown_card(uuid, text) from public, anon;
grant execute on function public.ignore_unknown_card(uuid, text) to authenticated;

commit;
