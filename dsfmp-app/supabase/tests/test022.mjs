// Fix 022: a secret for each NFC reader.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test022.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(22);
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`);
};
const q = async (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const err = async (uid, sql, params = []) => {
  try { await q(uid, sql, params); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`; }
};

// One school, a headteacher, a coordinator, a student with a card, a reader.
const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Tumaini', 'Head A')`);
const coord = await newUser(db, 'coord@x.com', 'Coord A');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord]);
const headB = await newUser(db, 'headb@x.com', 'Head B');
await q(headB, `select create_my_school('Upendo', 'Head B')`);
await q(head, `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id) values ($1, 'Brian Otieno', 'TUM-001', 12, 'A1000001')`, [school]);
await q(head, `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id) values ($1, 'Faith Wanjiru', 'TUM-002', 11, 'A1000002')`, [school]);
await q(null, `insert into nfc_devices (device_id, school_id, device_name) values ('reader-test-01', $1, 'Test reader')`, [school]);

// Lunch open all day today, so taps fall inside a meal window.
const [{ d }] = await q(null, `select extract(isodow from now() at time zone timezone)::int d from schools where school_id = $1`, [school]);
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '00:00', '23:59:59')`, [d]);

// Taps as the reader does them: the anon role, named arguments.
const scan = async (tag, secret) => {
  await db.exec('set role anon');
  try {
    const sql = secret === undefined
      ? `select record_nfc_scan(p_nfc_tag_id => $1, p_device_id => 'reader-test-01', p_mode => 'attendance') r`
      : `select record_nfc_scan(p_nfc_tag_id => $1, p_device_id => 'reader-test-01', p_mode => 'attendance', p_device_secret => $2) r`;
    return (await db.query(sql, secret === undefined ? [tag] : [tag, secret])).rows[0].r;
  } finally { await db.exec('reset role'); }
};

// ---------- a reader with no secret works as before ----------
let r = await scan('A1000001');
ok('reader with no secret: tap without a secret is recorded', r.success === true, JSON.stringify(r));

const fns = await q(null, `select pg_get_function_identity_arguments(oid) a from pg_proc where proname = 'record_nfc_scan'`);
ok('only one record_nfc_scan (no ambiguous overloads)', fns.length === 1, JSON.stringify(fns));

// ---------- making a secret ----------
const denied = await err(coord, `select set_device_secret('reader-test-01')`);
ok('a coordinator cannot set a reader secret', denied?.includes('42501'), denied);
const otherSchool = await err(headB, `select set_device_secret('reader-test-01')`);
ok("another school's headteacher cannot set it", otherSchool?.includes('42501'), otherSchool);
const anonCall = await (async () => { await db.exec('set role anon'); try { await db.query(`select set_device_secret('reader-test-01')`); return null; } catch (e) { return e.message; } finally { await db.exec('reset role'); } })();
ok('the anon key cannot call set_device_secret', anonCall !== null, anonCall);
const missing = await err(head, `select set_device_secret('reader-nope')`);
ok('unknown reader -> error', missing?.includes('P0002'), missing);

const [{ set_device_secret: secret }] = await q(head, `select set_device_secret('reader-test-01')`);
ok('headteacher gets a 64-character secret', /^[0-9a-f]{64}$/.test(secret), secret);
const [{ secret_hash: hash }] = await q(null, `select secret_hash from nfc_devices where device_id = 'reader-test-01'`);
ok('only the hash is stored, not the secret', hash && hash !== secret && hash.length === 64);
const [{ set_device_secret: fromEditor }] = await q(null, `select set_device_secret('reader-test-01')`);
ok('SQL Editor (no signed-in user) can set it too, and it changes', fromEditor !== secret);

// ---------- a reader with a secret ----------
r = await scan('A1000002');
ok('tap without the secret -> bad_device_secret', r.error === 'bad_device_secret', JSON.stringify(r));
r = await scan('A1000002', secret);
ok('tap with the old (replaced) secret -> bad_device_secret', r.error === 'bad_device_secret', JSON.stringify(r));
r = await scan('A1000002', 'guess');
ok('tap with a wrong secret -> bad_device_secret', r.error === 'bad_device_secret');
const none = await q(null, `select count(*)::int c from meal_attendance where nfc_tag_id = 'A1000002'`);
ok('refused taps record no attendance', none[0].c === 0);
const logged = await q(null, `select count(*)::int c from nfc_tag_logs where action_type = 'bad_device_secret'`);
ok('refused taps are logged', logged[0].c === 3, JSON.stringify(logged));
r = await scan('A1000002', fromEditor);
ok('tap with the right secret is recorded', r.success === true && r.first_name === 'Faith', JSON.stringify(r));
r = await scan('A1000002', fromEditor);
ok('repeat tap with the right secret -> already_recorded', r.error === 'already_recorded');

// ---------- taking the secret away ----------
await q(head, `update nfc_devices set secret_hash = null where device_id = 'reader-test-01'`);
r = await scan('A1000001');
ok('secret removed: tap without one is accepted again', r.error === 'already_recorded', JSON.stringify(r));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
