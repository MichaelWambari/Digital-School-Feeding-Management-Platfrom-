// ============================================================
// login-code: Supabase Edge Function (Deno)
//
// The second sign-in step. After a user signs in with their
// password, the app calls this function with that login's session:
//
//   { "action": "send" }                    emails a 6-digit code
//   { "action": "verify", "code": "123456" } checks it
//
// Once the code is verified, session_verified() is true for that
// login session and the database lets it see and change data.
// Codes expire after 10 minutes and allow 5 tries; a new code can
// be requested every 30 seconds.
//
// Email is sent with Brevo (brevo.com, free for 300 emails a day).
// Set these secrets under Edge Functions > Secrets:
//   BREVO_API_KEY    an API key from Brevo > SMTP & API > API keys
//   LOGIN_CODE_FROM  the sender address, verified in Brevo > Senders
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set automatically.
//
// Deploy: Supabase Dashboard > Edge Functions > Deploy a new function
// > Via Editor, name it login-code, replace the sample code with this
// file and deploy. Then turn off "Verify JWT" in its settings.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const CODE_MINUTES = 10;
const RESEND_SECONDS = 30;
const MAX_ATTEMPTS = 5;

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
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const { data: auth } = await admin.auth.getUser(token);
    if (!auth.user) return reply(401, { error: 'Sign in again and retry.' });
    // getUser() has checked the token, so its claims can be trusted.
    const sessionId = String(readClaims(token).session_id ?? '');
    if (!sessionId) return reply(400, { error: 'This login has no session. Sign in again.' });

    const { data: profile } = await admin
      .from('users')
      .select('status')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (profile?.status !== 'active') {
      return reply(403, { error: 'Your account is suspended. Ask the network admin to restore it.' });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action === 'send') return await sendCode(auth.user.id, auth.user.email ?? '', sessionId);
    if (body.action === 'verify') return await verifyCode(sessionId, String(body.code ?? ''));
    return reply(400, { error: 'Unknown action.' });
  } catch (e) {
    return reply(500, { error: e instanceof Error ? e.message : 'Something went wrong.' });
  }
});

async function sendCode(userId: string, email: string, sessionId: string) {
  const { data: existing } = await admin
    .from('login_codes')
    .select('sent_at, verified_at')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (existing?.verified_at) return reply(200, { verified: true });
  if (existing && Date.now() - Date.parse(existing.sent_at) < RESEND_SECONDS * 1000) {
    return reply(429, { error: `Wait ${RESEND_SECONDS} seconds before asking for another code.` });
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const { error } = await admin.from('login_codes').upsert({
    session_id: sessionId,
    user_id: userId,
    code_hash: await hashCode(sessionId, code),
    expires_at: new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
    attempts: 0,
    sent_at: new Date().toISOString(),
    verified_at: null,
  });
  if (error) return reply(500, { error: error.message });

  await sendEmail(email, code);
  return reply(200, { sent_to: maskEmail(email) });
}

async function verifyCode(sessionId: string, code: string) {
  const { data: row } = await admin
    .from('login_codes')
    .select('code_hash, expires_at, attempts, verified_at')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (row?.verified_at) return reply(200, { verified: true });
  if (!row) return reply(400, { error: 'Ask for a code first.' });
  if (Date.parse(row.expires_at) < Date.now()) {
    return reply(400, { error: 'That code has expired. Ask for a new one.' });
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return reply(429, { error: 'Too many wrong codes. Ask for a new one.' });
  }

  if ((await hashCode(sessionId, code.trim())) !== row.code_hash) {
    await admin
      .from('login_codes')
      .update({ attempts: row.attempts + 1 })
      .eq('session_id', sessionId);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return reply(400, {
      error: left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. Ask for a new one.',
    });
  }

  await admin
    .from('login_codes')
    .update({ verified_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  return reply(200, { verified: true });
}

async function sendEmail(to: string, code: string) {
  const apiKey = Deno.env.get('BREVO_API_KEY');
  const from = Deno.env.get('LOGIN_CODE_FROM');
  if (!apiKey || !from) {
    throw new Error('Sign-in codes are not set up yet: set BREVO_API_KEY and LOGIN_CODE_FROM for the login-code function.');
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'DSFMP', email: from },
      to: [{ email: to }],
      subject: `Your DSFMP sign-in code is ${code}`,
      textContent:
        `Your DSFMP sign-in code is ${code}\n\n` +
        `It expires in ${CODE_MINUTES} minutes. If you didn't just sign in, ` +
        `change your password: someone else knows it.`,
      htmlContent:
        `<p>Your DSFMP sign-in code is</p>` +
        `<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>` +
        `<p>It expires in ${CODE_MINUTES} minutes. If you didn't just sign in, ` +
        `change your password: someone else knows it.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Could not send the code email (Brevo ${res.status}): ${await res.text()}`);
}

async function hashCode(sessionId: string, code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sessionId}:${code}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
}

// j***@gmail.com, so the screen can say where the code went.
function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
