// Fix 029: taps a reader saved while offline (record_nfc_scan p_scanned_at).
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test029.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(29);
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`);
};
const q = async (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// One school, a coordinator, three students with cards, one reader.
const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Jasiri', 'Head A')`);
const coord = await newUser(db, 'coord@x.com', 'Coord A');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord]);
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id) values ($1, $2, $3, 12, $4) returning beneficiary_id`;
const [{ beneficiary_id: brian }] = await q(head, add, [school, 'Brian Otieno', 'JAS-001', 'CARD0001']);
await q(head, add, [school, 'Faith Wanjiru', 'JAS-002', 'CARD0002']);
const [{ beneficiary_id: kevin }] = await q(head, add, [school, 'Kevin Mutua', 'JAS-003', null]);
await q(null, `insert into nfc_devices (device_id, school_id) values ('reader-a1', $1)`, [school]);

// Lunch 12:00-14:00 every day with Ugali (maize 200 g), 10 kg maize in stock.
const [{ food_id: maize }] = await q(null, `insert into food_items (item_name, unit) values ('Test maize', 'kg') returning food_id`);
const [{ item_id }] = await q(null, `insert into inventory_items (school_id, food_id) values ($1, $2) returning item_id`, [school, maize]);
await q(null, `insert into inventory_transactions (item_id, transaction_type, quantity) values ($1, 'received', 10)`, [item_id]);
const [{ meal_id: ugali }] = await q(head, `insert into meals (school_id, name) values ($1, 'Ugali') returning meal_id`, [school]);
await q(head, `select set_meal_ingredients($1, $2)`, [ugali, JSON.stringify([{ food_id: maize, amount: 200 }])]);
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(null, `insert into meal_schedules (school_id, weekday, meal_type, start_time, end_time, meal_id)
  select $1, d, 'lunch', '12:00', '14:00', $2 from generate_series(1, 7) d`, [school, ugali]);
await q(null, `update schools set meal_close_since = now() - interval '10 days' where school_id = $1`, [school]);
const stock = async () => num((await q(null, `select quantity_available from inventory_items where item_id = $1`, [item_id]))[0].quantity_available);

// Moments in the school's time zone, 'days' days ago at hh:mm.
const at = async (days, hhmm) => (await q(null,
  `select (((now() at time zone timezone)::date - $2::int + $3::time) at time zone timezone)::text t from schools where school_id = $1`,
  [school, days, hhmm]))[0].t;
const dateAgo = async (days) => (await q(null,
  `select ((now() at time zone timezone)::date - $2::int)::text d from schools where school_id = $1`, [school, days]))[0].d;

const scan = async (tag, scannedAt = null) => {
  await db.exec('set role anon');
  try {
    return (await db.query(`select record_nfc_scan(p_nfc_tag_id => $1, p_device_id => 'reader-a1', p_scanned_at => $2) r`,
      [tag, scannedAt])).rows[0].r;
  } finally { await db.exec('reset role'); }
};
const closure = async (date) => (await q(null,
  `select status, students from meal_closures where school_id = $1 and closure_date = $2 and meal_type = 'lunch'`, [school, date]))[0];
const used = async (date) => (await q(null,
  `select quantity, issued_quantity, served_quantity, unserved_quantity from food_consumption
   where school_id = $1 and consumption_date = $2 and meal_type = 'lunch' and source = 'meal_close'`, [school, date]))[0];

const d2 = await dateAgo(2);
const d1 = await dateAgo(1);

// ---------- a saved tap counts for the meal it was made in ----------
let r = await scan('CARD0001', await at(2, '12:30'));
ok('saved tap 2 days ago at 12:30 -> recorded', r.success === true && r.meal_type === 'lunch', JSON.stringify(r));
const [att] = await q(null, `select attendance_date::text d, scanned_at from meal_attendance where beneficiary_id = $1`, [brian]);
ok('filed under that day, with the reader time kept', att.d === d2 && att.scanned_at !== null, JSON.stringify(att));
r = await scan('CARD0001', await at(2, '12:30'));
ok('sending the same saved tap again -> already_recorded', r.error === 'already_recorded', JSON.stringify(r));
ok('still one attendance record', (await q(null, `select count(*)::int c from meal_attendance`))[0].c === 1);

// ---------- closing, then late saved taps ----------
await q(null, `select close_due_meals()`);
let c = await closure(d2);
ok('2 days ago lunch closed with 1 student', c?.status === 'closed' && c.students === 1, JSON.stringify(c));
const before = await used(d2);
ok('issued 3 students x 200 g = 0.6 kg, served 0.2 kg', num(before.issued_quantity) === 0.6 && num(before.served_quantity) === 0.2, JSON.stringify(before));
ok('yesterday lunch closed as not served', (await closure(d1))?.status === 'not_served');
const stockAfterClose = await stock();

r = await scan('CARD0002', await at(2, '13:10'));
ok('a late saved tap for a closed meal is recorded', r.success === true, JSON.stringify(r));
c = await closure(d2);
ok('the closure now counts 2 students', c.students === 2, JSON.stringify(c));
const after = await used(d2);
ok('served is now 0.4 kg and unserved 0.2 kg', num(after.served_quantity) === 0.4 && num(after.unserved_quantity) === 0.2, JSON.stringify(after));
ok('the stock taken stays the issued amount', num(after.quantity) === num(before.quantity) && (await stock()) === stockAfterClose);

r = await scan('CARD0001', await at(1, '12:05'));
ok('a saved tap for a meal closed as not served is recorded', r.success === true, JSON.stringify(r));
c = await closure(d1);
ok('that meal is closed again, as served, with 1 student', c?.status === 'closed' && c.students === 1, JSON.stringify(c));
const y = await used(d1);
ok('and its food is deducted (0.6 kg issued)', y && num(y.issued_quantity) === 0.6 && (await stock()) === +(stockAfterClose - 0.6).toFixed(3),
  JSON.stringify({ y, stock: await stock() }));

// ---------- refused saved taps ----------
r = await scan('CARD0002', await at(1, '03:00'));
ok('a saved tap outside meal times -> outside_meal_time', r.error === 'outside_meal_time', JSON.stringify(r));
r = await scan('CARD0002', await at(4, '12:30'));
ok('a saved tap older than 3 days -> stale_scan', r.error === 'stale_scan', JSON.stringify(r));
const [{ t: future }] = await q(null, `select (now() + interval '1 hour')::text t`);
r = await scan('CARD0002', future);
ok('a saved tap in the future -> bad_scan_time', r.error === 'bad_scan_time', JSON.stringify(r));
const [{ t: nearFuture }] = await q(null, `select (now() + interval '2 minutes')::text t`);
r = await scan('CARD0002', nearFuture);
ok('a little clock drift is allowed (not bad_scan_time)', r.error !== 'bad_scan_time', JSON.stringify(r));

// ---------- saved taps never link cards ----------
const [{ r: req }] = await q(coord, `select start_card_link($1, 'reader-a1') r`, [kevin]);
r = await scan('NEWCARD9', await at(1, '12:40'));
ok('a saved tap while a link is pending is not a link', r.error === 'unknown_tag', JSON.stringify(r));
const [pending] = await q(null, `select status from card_link_requests where request_id = $1`, [req.request_id]);
ok('the link request is still pending', pending.status === 'pending');
r = await scan('NEWCARD9');
ok('a live tap still links', r.linked === true, JSON.stringify(r));

// ---------- logs ----------
const logs = await q(null, `select count(*)::int c from nfc_tag_logs where scanned_at is not null`);
ok('saved taps are logged with their reader time', logs[0].c >= 8, JSON.stringify(logs));
const live = await q(null, `select scanned_at from nfc_tag_logs where action_type = 'card_linked'`);
ok('live taps have no reader time', live[0].scanned_at === null);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
