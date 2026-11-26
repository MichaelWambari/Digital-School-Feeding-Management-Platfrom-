// Fix 032: grace period for late taps.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test032.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(32);
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`);
};
const q = async (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const err = async (uid, sql, params = []) => {
  try { await q(uid, sql, params); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`; }
};

const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Jasiri', 'Head A')`);
const coord = await newUser(db, 'coord@x.com', 'Coord A');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord]);
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id) values ($1, $2, $3, 12, $4)`;
for (const [i, n] of ['Brian', 'Faith', 'Kevin', 'Amina', 'Joy'].entries()) {
  await q(head, add, [school, `${n} Test`, `JAS-00${i}`, `CARD000${i}`]);
}
await q(null, `insert into nfc_devices (device_id, school_id) values ('reader-a1', $1)`, [school]);
// Lunch 12:00-14:00 and supper 22:00-23:50, every day.
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(null, `insert into meal_schedules (school_id, weekday, meal_type, start_time, end_time)
  select $1, d, m.t, m.s, m.e from generate_series(1, 7) d,
  (values ('lunch', time '12:00', time '14:00'), ('supper', time '22:00', time '23:50')) m(t, s, e)`, [school]);

const at = async (days, hhmm) => (await q(null,
  `select (((now() at time zone timezone)::date - $2::int + $3::time) at time zone timezone)::text t from schools where school_id = $1`,
  [school, days, hhmm]))[0].t;
const dateAgo = async (days) => (await q(null,
  `select ((now() at time zone timezone)::date - $2::int)::text d from schools where school_id = $1`, [school, days]))[0].d;
const scan = async (tag, scannedAt) => {
  await db.exec('set role anon');
  try {
    return (await db.query(`select record_nfc_scan(p_nfc_tag_id => $1, p_device_id => 'reader-a1', p_scanned_at => $2) r`, [tag, scannedAt])).rows[0].r;
  } finally { await db.exec('reset role'); }
};
const grace = (m) => q(null, `update schools set scan_grace_minutes = $2 where school_id = $1`, [school, m]);

// ---------- default: no grace ----------
let r = await scan('CARD0000', await at(1, '14:05'));
ok('no grace: 5 min after lunch ends -> outside_meal_time', r.error === 'outside_meal_time', JSON.stringify(r));

// ---------- 15 minutes ----------
await grace(15);
r = await scan('CARD0000', await at(1, '14:05'));
ok('grace 15: 5 min late -> recorded as lunch', r.success === true && r.meal_type === 'lunch', JSON.stringify(r));
const [row] = await q(null, `select attendance_date::text d, meal_type from meal_attendance where nfc_tag_id = 'CARD0000'`);
ok('filed under that day', row.d === (await dateAgo(1)), JSON.stringify(row));
r = await scan('CARD0001', await at(1, '14:14'));
ok('14 min late -> recorded', r.success === true, JSON.stringify(r));
r = await scan('CARD0002', await at(1, '14:15'));
ok('exactly 15 min late -> outside_meal_time', r.error === 'outside_meal_time', JSON.stringify(r));
r = await scan('CARD0002', await at(1, '13:59'));
ok('inside the window still works', r.success === true, JSON.stringify(r));

// ---------- across midnight ----------
await grace(30);
r = await scan('CARD0003', await at(0, '00:10'));
ok('supper ends 23:50; a tap at 00:10 counts for supper', r.success === true && r.meal_type === 'supper', JSON.stringify(r));
const [mid] = await q(null, `select attendance_date::text d from meal_attendance where nfc_tag_id = 'CARD0003'`);
ok("...filed under the previous day's supper", mid.d === (await dateAgo(1)), JSON.stringify(mid));
r = await scan('CARD0004', await at(0, '00:25'));
ok('00:25 is past the 30 min grace -> outside_meal_time', r.error === 'outside_meal_time', JSON.stringify(r));

// ---------- meals close after the grace period ----------
await q(null, `update schools set meal_close_since = now() - interval '10 days' where school_id = $1`, [school]);
await grace(0);
await q(null, `select close_due_meals()`);
const closedNoGrace = await q(null, `select count(*)::int c from meal_closures where school_id = $1 and closure_date = $2 and meal_type = 'lunch'`, [school, await dateAgo(1)]);
ok("yesterday's lunch closes", closedNoGrace[0].c === 1);
// A meal that ended 20 minutes ago: closed without grace, waits with 60 min.
const [{ local }] = await q(null, `select to_char(now() at time zone timezone, 'HH24:MI') local from schools where school_id = $1`, [school]);
if (local >= '02:00') {
  await q(null, `delete from meal_closures where school_id = $1`, [school]);
  await q(null, `delete from meal_schedules where school_id = $1`, [school]);
  await q(null, `insert into meal_schedules (school_id, weekday, meal_type, start_time, end_time)
    select $1, extract(isodow from (now() at time zone timezone)::date)::int, 'breakfast',
           ((now() at time zone timezone) - interval '80 minutes')::time,
           ((now() at time zone timezone) - interval '20 minutes')::time
    from schools where school_id = $1`, [school]);
  await grace(60);
  await q(null, `select close_due_meals()`);
  const waiting = await q(null, `select count(*)::int c from meal_closures where school_id = $1`, [school]);
  ok('with 60 min grace, a meal that ended 20 min ago is not closed yet', waiting[0].c === 0);
  const live = await scan('CARD0004', null);
  ok('and a live tap now still counts for it', live.success === true && live.meal_type === 'breakfast', JSON.stringify(live));
  await grace(10);
  await q(null, `select close_due_meals()`);
  const closed = await q(null, `select count(*)::int c from meal_closures where school_id = $1`, [school]);
  ok('with 10 min grace it is closed', closed[0].c === 1);
} else {
  console.log('skip close-after-grace checks (too close to midnight)');
}

// ---------- who can set it ----------
await grace(0);
const coordSet = await q(coord, `update schools set scan_grace_minutes = 10 where school_id = $1 returning school_id`, [school]);
ok('a coordinator cannot change the grace period', coordSet.length === 0);
const headSet = await q(head, `update schools set scan_grace_minutes = 10 where school_id = $1 returning scan_grace_minutes`, [school]);
ok('the headteacher can', headSet[0]?.scan_grace_minutes === 10);
const tooLong = await err(head, `update schools set scan_grace_minutes = 90 where school_id = $1`, [school]);
ok('more than 60 minutes is refused', tooLong?.includes('23514'), tooLong);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
