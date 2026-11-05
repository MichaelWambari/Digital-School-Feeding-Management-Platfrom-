// ============================================================
// manage-staff: Supabase Edge Function (Deno)
//
// Creates logins and resets passwords. Creating a login needs the
// service role key, which must never be inside the app, so the app
// calls this function instead:
//
// A headteacher, for their own school's staff:
//   { "action": "create", "email", "password", "full_name", "role" }
//   { "action": "set_password", "user_id", "password" }
//
// The platform admin, to onboard a school with its first headteacher:
//   { "action": "onboard_school",
//     "school": { "name", "location", "county", "phone", "email", "registration_no", "timezone" },
//     "headteacher": { "full_name", "email", "password" } }
//
// Logins made here must choose a new password at their first sign-in.
// Listing and editing staff don't need this function: the app calls
// the list_staff() and update_staff() database functions directly.
//
// Deploy: Supabase Dashboard > Edge Functions > manage-staff > Code,
// paste this file and deploy (Verify JWT off: it checks the login
// itself). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set
// automatically.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SCHOOL_ROLES = ['headteacher', 'coordinator', 'inventory_officer', 'staff'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

type Caller = { user_id: string; role: string | null; school_id: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  try {
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const { data: auth } = await admin.auth.getUser(token);
    if (!auth.user) return reply(401, { error: 'Sign in again and retry.' });
    const { data: caller } = await admin
      .from('users')
      .select('user_id, role, school_id, status, schools(status)')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!caller || caller.status !== 'active') {
      return reply(403, { error: 'Your account is not active.' });
    }
    if (!(await sessionVerified(token, auth.user.id))) {
      return reply(403, { error: 'Finish signing in with your emailed code, then try again.' });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action === 'onboard_school') {
      if (caller.role !== 'platform_admin') {
        return reply(403, { error: 'Only the platform admin can onboard schools.' });
      }
      return await onboardSchool(body);
    }

    // Everything else is a headteacher managing their own (active) school.
    const schoolStatus = (caller.schools as { status?: string } | null)?.status;
    if (caller.role !== 'headteacher' || !caller.school_id || schoolStatus !== 'active') {
      return reply(403, { error: 'Only the headteacher can manage staff.' });
    }
    if (body.action === 'create') return await createStaff(body, caller as Caller);
    if (body.action === 'set_password') return await setPassword(body, caller as Caller);
    return reply(400, { error: 'Unknown action.' });
  } catch (e) {
    return reply(500, { error: e instanceof Error ? e.message : 'Something went wrong.' });
  }
});

async function createStaff(body: Record<string, unknown>, caller: Caller) {
  const role = String(body.role ?? '');
  if (!SCHOOL_ROLES.includes(role)) return reply(400, { error: 'Choose a role.' });
  const login = readLogin(body);
  if ('error' in login) return reply(400, login);
  return await createLogin(login, role, caller.school_id!);
}

async function setPassword(body: Record<string, unknown>, caller: Caller) {
  const userId = String(body.user_id ?? '');
  const password = String(body.password ?? '');
  if (password.length < 8) return reply(400, { error: 'The password must be at least 8 characters.' });

  const { data: target } = await admin
    .from('users')
    .select('school_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!target || target.school_id !== caller.school_id) {
    return reply(404, { error: 'Staff member not found.' });
  }

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return reply(400, { error: error.message });
  // Someone else chose this password, so they must pick their own next time.
  if (userId !== caller.user_id) {
    await admin.from('users').update({ must_change_password: true }).eq('user_id', userId);
  }
  return reply(200, { user_id: userId });
}

async function onboardSchool(body: Record<string, unknown>) {
  const s = (body.school ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const name = text(s.name);
  if (!name) return reply(400, { error: 'The school name is required.' });
  const timezone = text(s.timezone) ?? 'Africa/Nairobi';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return reply(400, { error: `Unknown timezone ${timezone}.` });
  }
  const login = readLogin((body.headteacher ?? {}) as Record<string, unknown>);
  if ('error' in login) return reply(400, login);

  const { data: school, error: schoolError } = await admin
    .from('schools')
    .insert({
      name,
      location: text(s.location),
      county: text(s.county),
      phone: text(s.phone),
      email: text(s.email),
      registration_no: text(s.registration_no),
      timezone,
    })
    .select('school_id')
    .single();
  if (schoolError || !school) {
    const taken = schoolError?.code === '23505';
    return reply(taken ? 409 : 400, {
      error: taken ? 'A school with that name already exists.' : schoolError?.message ?? 'Could not add the school.',
    });
  }

  const created = await createLogin(login, 'headteacher', school.school_id);
  if (created.status !== 200) {
    // Don't leave a school behind without its headteacher.
    await admin.from('schools').delete().eq('school_id', school.school_id);
    return created;
  }
  const { user_id } = await created.clone().json();
  return reply(200, { school_id: school.school_id, user_id });
}

type Login = { email: string; password: string; fullName: string };

function readLogin(body: Record<string, unknown>): Login | { error: string } {
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const fullName = String(body.full_name ?? '').trim();
  if (!fullName) return { error: 'Full name is required.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' };
  if (password.length < 8) return { error: 'The password must be at least 8 characters.' };
  return { email, password, fullName };
}

// Creates the login, then gives it its role and school. The
// on_auth_user_created trigger adds the users row with no role.
async function createLogin(login: Login, role: string, schoolId: string) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: login.email,
    password: login.password,
    email_confirm: true,
    user_metadata: { full_name: login.fullName },
  });
  if (error || !created.user) {
    const taken = error?.message.toLowerCase().includes('already');
    return reply(taken ? 409 : 400, {
      error: taken ? 'A login with that email already exists.' : error?.message ?? 'Could not create the login.',
    });
  }

  const { error: profileError } = await admin
    .from('users')
    .update({ full_name: login.fullName, role, school_id: schoolId, must_change_password: true })
    .eq('user_id', created.user.id);
  if (profileError) {
    // Don't leave a login behind with the wrong role.
    await admin.auth.admin.deleteUser(created.user.id);
    return reply(500, { error: profileError.message });
  }
  return reply(200, { user_id: created.user.id });
}

// The same rule as the database's session_verified(): a Google login, or
// a password login whose emailed code was entered (fix 006).
async function sessionVerified(token: string, userId: string) {
  const claims = readClaims(token);
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  if (amr.some((m: { method?: string }) => m?.method === 'oauth')) return true;
  const { data, error } = await admin
    .from('login_codes')
    .select('verified_at')
    .eq('session_id', String(claims.session_id ?? ''))
    .eq('user_id', userId)
    .maybeSingle();
  // Before fix 006 there is no login_codes table and no second step.
  if (error) return error.code === 'PGRST205' || error.code === '42P01';
  return Boolean(data?.verified_at);
}

function readClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
