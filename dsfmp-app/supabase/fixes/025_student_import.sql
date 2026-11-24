-- ============================================================
-- Fix 025: import students from a spreadsheet (CSV)
--
-- The app reads the school's CSV, turns each row into JSON and calls
-- import_students() twice: first as a dry run, to show what would
-- change and any row errors, then for real once the user confirms.
--
--   * Rows are matched to students on admission number (ignoring
--     upper/lower case). A new number adds a student; an existing one
--     updates only the columns the file has, so a file without dates
--     of birth leaves them as they are.
--   * All or nothing: if any row has an error, nothing is saved, and
--     every error is listed by row number.
--   * Optionally, active students missing from the file are marked
--     inactive (left the school). They are never deleted.
--   * A card (nfc_tag_id) in the file must not belong to another
--     student, at this school or any other.
--
-- Row fields (missing, null or "" = not in the file):
--   row (the line number, for messages), admission_no, full_name,
--   date_of_birth (YYYY-MM-DD), age, sex (female/male),
--   nfc_tag_id, status (active/inactive)
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run more than once.
-- ============================================================

create or replace function public.import_students(
  p_school_id uuid,
  p_rows jsonb,
  p_deactivate_missing boolean default false,
  p_dry_run boolean default true
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v jsonb;
  v_line int;
  v_adm text;
  v_name text;
  v_dob_text text;
  v_dob date;
  v_age_text text;
  v_age int;
  v_sex text;
  v_card text;
  v_status text;
  v_existing beneficiaries%rowtype;
  v_holder beneficiaries%rowtype;
  v_row_errors text[];
  v_errors jsonb := '[]'::jsonb;
  v_error_count int := 0;
  v_plan jsonb := '[]'::jsonb;
  v_adms text[] := '{}';
  v_adm_lines int[] := '{}';
  v_cards text[] := '{}';
  v_card_lines int[] := '{}';
  v_card_adms text[] := '{}'; -- the student each card in the file goes to
  v_idx int;
  v_inserted int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_deactivate int := 0;
  v_step jsonb;
begin
  if not public.has_school_permission(p_school_id, 'manage_students') then
    raise exception 'You do not have permission to manage students' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no students in it' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Import at most 5000 students at a time' using errcode = '22023';
  end if;

  for v_item in select value, ordinality from jsonb_array_elements(p_rows) with ordinality loop
    v := v_item.value;
    -- The header is line 1, so the first student is line 2.
    v_line := coalesce(nullif(v->>'row', '')::int, v_item.ordinality::int + 1);
    v_row_errors := '{}';

    v_adm := nullif(btrim(v->>'admission_no'), '');
    v_name := nullif(btrim(regexp_replace(coalesce(v->>'full_name', ''), '\s+', ' ', 'g')), '');
    v_dob_text := nullif(btrim(v->>'date_of_birth'), '');
    v_age_text := nullif(btrim(v->>'age'), '');
    v_sex := lower(nullif(btrim(v->>'sex'), ''));
    v_card := upper(nullif(btrim(v->>'nfc_tag_id'), ''));
    v_status := lower(nullif(btrim(v->>'status'), ''));
    v_dob := null;
    v_age := null;
    v_existing := null;

    -- Admission number: required, once per file.
    if v_adm is null then
      v_row_errors := v_row_errors || 'Admission number is missing'::text;
    else
      v_idx := array_position(v_adms, upper(v_adm));
      if v_idx is not null then
        v_row_errors := v_row_errors || format('Admission number %s is also on line %s', v_adm, v_adm_lines[v_idx]);
      else
        v_adms := v_adms || upper(v_adm);
        v_adm_lines := v_adm_lines || v_line;
      end if;
      select * into v_existing from beneficiaries
        where school_id = p_school_id and upper(admission_no) = upper(v_adm)
        limit 1;
    end if;

    if v_name is null and v_existing.beneficiary_id is null then
      v_row_errors := v_row_errors || 'Full name is missing'::text;
    end if;

    if v_dob_text is not null then
      if v_dob_text !~ '^\d{4}-\d{2}-\d{2}$' then
        v_row_errors := v_row_errors || format('Date of birth "%s" is not a date (use YYYY-MM-DD or DD/MM/YYYY)', v_dob_text);
      else
        begin
          v_dob := v_dob_text::date;
        exception when others then
          v_row_errors := v_row_errors || format('Date of birth "%s" is not a real date', v_dob_text);
        end;
        if v_dob > current_date then
          v_row_errors := v_row_errors || 'Date of birth is in the future'::text;
          v_dob := null;
        elsif v_dob is not null and extract(year from age(current_date, v_dob)) > 30 then
          v_row_errors := v_row_errors || format('Date of birth %s makes the student over 30', v_dob_text);
          v_dob := null;
        end if;
      end if;
    end if;

    if v_age_text is not null then
      if v_age_text !~ '^\d{1,3}$' or v_age_text::int > 120 then
        v_row_errors := v_row_errors || format('Age "%s" is not a whole number', v_age_text);
      else
        v_age := v_age_text::int;
      end if;
    end if;

    if v_sex is not null and v_sex not in ('female', 'male') then
      v_row_errors := v_row_errors || format('Sex "%s" should be female or male', v->>'sex');
      v_sex := null;
    end if;

    if v_status is not null and v_status not in ('active', 'inactive') then
      v_row_errors := v_row_errors || format('Status "%s" should be active or inactive', v->>'status');
      v_status := null;
    end if;

    -- Card: once per file, and not on another student anywhere.
    if v_card is not null then
      v_idx := array_position(v_cards, v_card);
      if v_idx is not null then
        v_row_errors := v_row_errors || format('Card %s is also on line %s', v_card, v_card_lines[v_idx]);
      else
        v_cards := v_cards || v_card;
        v_card_lines := v_card_lines || v_line;
        v_card_adms := v_card_adms || upper(v_adm);
      end if;
      v_holder := null;
      select * into v_holder from beneficiaries where nfc_tag_id = v_card limit 1;
      if v_holder.beneficiary_id is not null
         and v_holder.beneficiary_id is distinct from v_existing.beneficiary_id
         -- Fine if the file also gives the card's current holder a
         -- different card (cards being swapped round).
         and not (v_holder.school_id = p_school_id
                  and exists (select 1 from jsonb_array_elements(p_rows) o
                              where upper(btrim(o->>'admission_no')) = upper(v_holder.admission_no)
                                and nullif(btrim(o->>'nfc_tag_id'), '') is not null
                                and upper(btrim(o->>'nfc_tag_id')) <> v_card)) then
        v_row_errors := v_row_errors || case
          when v_holder.school_id = p_school_id
            then format('Card %s already belongs to %s (%s)', v_card, v_holder.full_name, v_holder.admission_no)
          else format('Card %s already belongs to a student at another school', v_card)
        end;
      end if;
    end if;

    if cardinality(v_row_errors) > 0 then
      v_error_count := v_error_count + cardinality(v_row_errors);
      if jsonb_array_length(v_errors) < 200 then
        v_errors := v_errors || jsonb_build_object('row', v_line, 'admission_no', v_adm,
                                                   'messages', to_jsonb(v_row_errors));
      end if;
      continue;
    end if;

    if v_existing.beneficiary_id is null then
      v_inserted := v_inserted + 1;
      v_plan := v_plan || jsonb_build_object('op', 'insert', 'adm', v_adm, 'name', v_name,
        'dob', v_dob, 'age', v_age, 'sex', v_sex, 'card', v_card, 'status', coalesce(v_status, 'active'));
    elsif (v_name is not null and v_name is distinct from v_existing.full_name)
       or (v_dob is not null and v_dob is distinct from v_existing.date_of_birth)
       or (v_age is not null and v_dob is null and v_existing.date_of_birth is null
           and v_age is distinct from v_existing.age)
       or (v_sex is not null and v_sex is distinct from v_existing.sex)
       or (v_card is not null and v_card is distinct from v_existing.nfc_tag_id)
       or (v_status is not null and v_status is distinct from v_existing.status) then
      v_updated := v_updated + 1;
      v_plan := v_plan || jsonb_build_object('op', 'update', 'id', v_existing.beneficiary_id,
        'name', v_name, 'dob', v_dob, 'age', v_age, 'sex', v_sex, 'card', v_card, 'status', v_status);
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  if p_deactivate_missing then
    select count(*) into v_deactivate from beneficiaries
      where school_id = p_school_id and status = 'active'
        and not (upper(admission_no) = any (v_adms));
  end if;

  if v_error_count = 0 and not p_dry_run then
    -- Cards moving between students: free them all first, so the
    -- unique index never sees one card on two students.
    update beneficiaries b set nfc_tag_id = null
      from unnest(v_cards, v_card_adms) as c(card, adm)
      where b.school_id = p_school_id
        and b.nfc_tag_id = c.card
        and upper(b.admission_no) <> c.adm;

    for v_step in select value from jsonb_array_elements(v_plan) loop
      if v_step->>'op' = 'insert' then
        insert into beneficiaries (school_id, admission_no, full_name, date_of_birth, age, sex, nfc_tag_id, status)
          values (p_school_id, v_step->>'adm', v_step->>'name', (v_step->>'dob')::date,
                  (v_step->>'age')::int, v_step->>'sex', v_step->>'card', v_step->>'status');
      else
        update beneficiaries set
          full_name = coalesce(v_step->>'name', full_name),
          date_of_birth = coalesce((v_step->>'dob')::date, date_of_birth),
          age = coalesce((v_step->>'age')::int, age),
          sex = coalesce(v_step->>'sex', sex),
          nfc_tag_id = coalesce(v_step->>'card', nfc_tag_id),
          status = coalesce(v_step->>'status', status)
        where beneficiary_id = (v_step->>'id')::uuid;
      end if;
    end loop;

    if p_deactivate_missing then
      update beneficiaries set status = 'inactive'
        where school_id = p_school_id and status = 'active'
          and not (upper(admission_no) = any (v_adms));
    end if;
  end if;

  return json_build_object(
    'applied', v_error_count = 0 and not p_dry_run,
    'inserted', v_inserted,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'deactivated', v_deactivate,
    'error_count', v_error_count,
    'errors', v_errors
  );
end;
$$;

revoke all on function public.import_students(uuid, jsonb, boolean, boolean) from public, anon;
grant execute on function public.import_students(uuid, jsonb, boolean, boolean) to authenticated;
