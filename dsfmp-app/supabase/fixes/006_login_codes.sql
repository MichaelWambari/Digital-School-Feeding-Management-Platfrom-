-- ============================================================
-- Fix 006: sign-in codes
--
-- Signing in with a password now takes a second step: a 6-digit
-- code is emailed to the user, and until it is entered that login
-- can't see or change anything. Signing in with Google skips the
-- code. The database enforces this, not just the app:
--
--   * login_codes: one row per login session, written only by the
--     login-code Edge Function (supabase/functions/login-code).
--   * session_verified(): true for Google logins and for password
--     logins whose code was entered.
--   * is_network_admin(), can_view_school() and has_school_role(),
--     which every permission rule uses, now also require it, and
--     so does reading the food list.
--
-- IMPORTANT: deploy the login-code Edge Function and set its
-- email secrets BEFORE running this. Otherwise nobody who signs
-- in with a password can get a code, and only Google sign-ins
-- will work. See "Sign-in codes" in the README.
--
-- Run it once, after fixes 001-005. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- LOGIN_CODES: the second sign-in step. After signing in with a
-- password, a 6-digit code is emailed to the user and must be
-- entered before that login session can see or change anything
-- (see session_verified()). One row per login session; only the
-- login-code Edge Function reads or writes it.
-- ------------------------------------------------------------
create table if not exists login_codes (
  session_id uuid primary key,             -- the session_id claim of the login's JWT
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,                 -- sha-256 of session_id:code, never the code itself
  expires_at timestamptz not null,
  attempts int not null default 0,
  sent_at timestamptz not null default now(),
  verified_at timestamptz
);

-- No policies: only the login-code Edge Function (service role) uses it.
alter table login_codes enable row level security;
revoke all on login_codes from anon, authenticated;

-- Has the current login finished signing in? Google sign-ins have
-- (Google already checked the user); password sign-ins have once
-- the emailed code was entered for this session. Every permission
-- check below requires it.
create or replace function public.session_verified()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(auth.jwt() -> 'amr', '[]'::jsonb) @> '[{"method": "oauth"}]'::jsonb
    or exists (
      select 1 from public.login_codes
      where session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
        and user_id = auth.uid() and verified_at is not null
    );
$$;

create or replace function public.is_network_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active' and role = 'network_admin'
  );
$$;

-- Can the current user see this school's data?
create or replace function public.can_view_school(p_school_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active'
      and (role = 'network_admin' or school_id = p_school_id)
  );
$$;

-- Does the current user hold one of these roles at this school?
-- Network admins don't: they only view school records.
create or replace function public.has_school_role(p_school_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.session_verified() and exists (
    select 1 from public.users
    where user_id = auth.uid() and status = 'active'
      and school_id = p_school_id and role = any(p_roles)
  );
$$;

revoke all on function public.session_verified() from public;
revoke all on function public.is_network_admin() from public;
revoke all on function public.can_view_school(uuid) from public;
revoke all on function public.has_school_role(uuid, text[]) from public;
grant execute on function public.session_verified() to anon, authenticated;
grant execute on function public.is_network_admin() to anon, authenticated;
grant execute on function public.can_view_school(uuid) to anon, authenticated;
grant execute on function public.has_school_role(uuid, text[]) to anon, authenticated;

drop policy if exists "Signed-in users can read the food list" on food_items;
create policy "Signed-in users can read the food list"
  on food_items for select using (public.session_verified());

commit;
