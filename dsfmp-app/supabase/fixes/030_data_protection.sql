-- ============================================================
-- Fix 030: data protection (Kenya Data Protection Act, 2019).
--
-- The app keeps personal data about children (name, admission
-- number, NEMIS UPI, date of birth, sex, card, meals eaten and their
-- nutrition), so:
--
--   * schools.data_terms_accepted_at / _by: when the headteacher
--     confirmed the school has told parents or guardians how the data
--     is used and has their consent (accept_data_terms()). The app's
--     privacy notice explains the terms.
--   * erase_student(): the headteacher can erase a learner (right to
--     erasure). The student row, attendance, nutrition records and
--     card link requests go (they cascade), and the copies of the row
--     that the audit log kept are replaced by a note, so no personal
--     data is left behind. The audit log records who erased whom by
--     id only. Meal closures keep their head counts.
--   * Only the headteacher can delete students at all (a restrictive
--     policy), so a coordinator can't remove a learner's records.
--
-- Safe to run twice. Needs fix 009 (audit log, roles).
-- ============================================================

alter table schools add column if not exists data_terms_accepted_at timestamptz;
alter table schools add column if not exists data_terms_accepted_by uuid references users(user_id) on delete set null;

-- ------------------------------------------------------------
-- accept_data_terms(): the headteacher confirms the terms.
-- ------------------------------------------------------------
create or replace function public.accept_data_terms(p_school_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_at timestamptz := now();
begin
  if not public.has_school_role(p_school_id, array['headteacher']) then
    raise exception 'Only the headteacher can confirm the data protection terms' using errcode = '42501';
  end if;
  update schools
    set data_terms_accepted_at = v_at, data_terms_accepted_by = auth.uid()
    where school_id = p_school_id;
  return v_at;
end;
$$;
revoke all on function public.accept_data_terms(uuid) from public, anon;
grant execute on function public.accept_data_terms(uuid) to authenticated;

-- ------------------------------------------------------------
-- erase_student(): permanently removes a learner and their records.
-- ------------------------------------------------------------
create or replace function public.erase_student(p_beneficiary_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select school_id into v_school_id from beneficiaries where beneficiary_id = p_beneficiary_id;
  if v_school_id is null then
    raise exception 'Student not found' using errcode = 'P0002';
  end if;
  if not public.has_school_role(v_school_id, array['headteacher']) then
    raise exception 'Only the headteacher can erase a student' using errcode = '42501';
  end if;

  -- Cascades to meal_attendance, attendance_nutrition and
  -- card_link_requests. The audit trigger logs the delete.
  delete from beneficiaries where beneficiary_id = p_beneficiary_id;

  -- The audit log kept copies of the row (on adding, each change and
  -- this delete). Keep that something happened, not what it said.
  update audit_logs
    set changes = jsonb_build_object('erased', true)
    where table_name = 'beneficiaries' and record_id = p_beneficiary_id::text;

  insert into audit_logs (school_id, actor_id, action, table_name, record_id, changes)
    values (v_school_id, auth.uid(), 'erase', 'beneficiaries', p_beneficiary_id::text,
            jsonb_build_object('erased', true));
end;
$$;
revoke all on function public.erase_student(uuid) from public, anon;
grant execute on function public.erase_student(uuid) to authenticated;

-- ------------------------------------------------------------
-- Deleting students directly: headteachers only.
-- ------------------------------------------------------------
drop policy if exists "Only headteachers delete students" on beneficiaries;
create policy "Only headteachers delete students"
  on beneficiaries as restrictive for delete
  using (public.has_school_role(school_id, array['headteacher']));
