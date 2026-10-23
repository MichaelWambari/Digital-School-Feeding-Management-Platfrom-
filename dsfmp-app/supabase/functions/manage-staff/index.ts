// ============================================================
// manage-staff: Supabase Edge Function (Deno)
//
// Creates staff logins and resets their passwords for the app's
// Staff screen. Creating a login needs the service role key, which
// must never be inside the app, so the app calls this function
// instead, signed in as a network admin:
//
//   { "action": "create", "email", "password", "full_name", "role", "school_id" }
//   { "action": "set_password", "user_id", "password" }
//
// Listing and editing staff don't need it: the app calls the
// list_staff() and update_staff() database functions directly.
//
// Deploy: Supabase Dashboard > Edge Functions > Deploy a new function
// > Via Editor, name it manage-staff, paste this file and deploy.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set automatically.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const ROLES = ['network_admin', 'admin', 'coordinator', 'inventory_officer'];

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  try {
    // Only an active network admin may manage staff.
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const { data: auth } = await admin.auth.getUser(token);
    if (!auth.user) return reply(401, { error: 'Sign in again and retry.' });
    const { data: caller } = await admin
      .from('users')
      .select('role, status')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (caller?.role !== 'network_admin' || caller.status !== 'active') {
      return reply(403, { error: 'Only network admins can manage staff.' });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action === 'create') return await createStaff(body);
    if (body.action === 'set_password') return await setPassword(body);
    return reply(400, { error: 'Unknown action.' });
  } catch (e) {
    return reply(500, { error: e instanceof Error ? e.message : 'Something went wrong.' });
  }
});

async function createStaff(body: Record<string, unknown>) {
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const fullName = String(body.full_name ?? '').trim();
  const role = String(body.role ?? '');
  const schoolId = role === 'network_admin' ? null : (body.school_id as string | null) ?? null;

  if (!fullName) return reply(400, { error: 'Full name is required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'Enter a valid email address.' });
  if (password.length < 8) return reply(400, { error: 'The password must be at least 8 characters.' });
  if (!ROLES.includes(role)) return reply(400, { error: 'Choose a role.' });
  if (role !== 'network_admin') {
    if (!schoolId) return reply(400, { error: 'Choose a school.' });
    const { data: school } = await admin
      .from('schools')
      .select('school_id')
      .eq('school_id', schoolId)
      .maybeSingle();
    if (!school) return reply(400, { error: 'That school was not found.' });
  }

  // The on_auth_user_created trigger adds the users row (as a coordinator
  // with no school); the role and school are set straight after.
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !created.user) {
    const taken = error?.message.toLowerCase().includes('already');
    return reply(taken ? 409 : 400, {
      error: taken ? 'A login with that email already exists.' : error?.message ?? 'Could not create the login.',
    });
  }

  const { error: profileError } = await admin
    .from('users')
    .update({ full_name: fullName, role, school_id: schoolId })
    .eq('user_id', created.user.id);
  if (profileError) {
    // Don't leave a login behind with the wrong role.
    await admin.auth.admin.deleteUser(created.user.id);
    return reply(500, { error: profileError.message });
  }
  return reply(200, { user_id: created.user.id });
}

async function setPassword(body: Record<string, unknown>) {
  const userId = String(body.user_id ?? '');
  const password = String(body.password ?? '');
  if (password.length < 8) return reply(400, { error: 'The password must be at least 8 characters.' });

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return reply(400, { error: error.message });
  return reply(200, { user_id: userId });
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
