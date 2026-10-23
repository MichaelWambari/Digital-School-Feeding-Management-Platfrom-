-- ============================================================
-- Fix 005: Staff screen
--
-- Lets the network admin manage staff from the app instead of the
-- Supabase dashboard:
--
--   * list_staff(): every staff member with their email, role,
--     school, status and last sign-in.
--   * update_staff(): change a staff member's name, role, school or
--     status (suspended staff can't see or change anything).
--
-- New logins are created by the manage-staff Edge Function in
-- supabase/functions/manage-staff, which must be deployed
-- separately (see the README).
--
-- Run it once, after fixes 001-004. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- list_staff() / update_staff(): the network admin's Staff screen.
-- Logins themselves are created by the manage-staff Edge Function
-- (supabase/functions), which needs the service role key.
-- ------------------------------------------------------------
create or replace function public.list_staff()
returns table (user_id uuid, email text, full_name text, role text, school_id uuid,
               status text, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_network_admin() then
    raise exception 'Only network admins can manage staff' using errcode = '42501';
  end if;
  return query
    select u.user_id, a.email::text, u.full_name, u.role, u.school_id, u.status,
           a.last_sign_in_at
    from public.users u
    join auth.users a on a.id = u.user_id
    order by u.full_name;
end;
$$;

create or replace function public.update_staff(p_user_id uuid, p_full_name text, p_role text,
                                    p_school_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_network_admin() then
    raise exception 'Only network admins can manage staff' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() and (p_role <> 'network_admin' or p_status <> 'active') then
    raise exception 'You can''t remove your own network admin access' using errcode = '22023';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'Full name is required' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('network_admin', 'admin', 'coordinator', 'inventory_officer') then
    raise exception 'Unknown role %', p_role using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  if p_role <> 'network_admin'
     and not exists (select 1 from schools where school_id = p_school_id) then
    raise exception 'Choose a school for this role' using errcode = '22023';
  end if;

  update users
    set full_name = trim(p_full_name), role = p_role, status = p_status,
        school_id = case when p_role = 'network_admin' then null else p_school_id end
    where user_id = p_user_id;
  if not found then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.list_staff() from public;
revoke all on function public.update_staff(uuid, text, text, uuid, text) from public;
grant execute on function public.list_staff() to authenticated;
grant execute on function public.update_staff(uuid, text, text, uuid, text) to authenticated;

commit;
