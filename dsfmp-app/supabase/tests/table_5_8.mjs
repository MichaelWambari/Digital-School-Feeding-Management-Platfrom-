// Report Chapter 5, Table 5.8: database-level checks for TC-03 to TC-13.
// Runs schema.sql + fixes 009-015 in PGlite, as real users under RLS.
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(15);
const results = [];
const ok = (tc, name, cond, detail = '') => {
  results.push({ tc, name, cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${tc} ${name}${detail ? ' -- ' + detail : ''}`);
};
const q = async (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const err = async (uid, sql, params = []) => {
  try { await q(uid, sql, params); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`; }
};
const n = (rows) => Number(Object.values(rows[0])[0]);

// Two schools, each with a headteacher; a coordinator at school A.
const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Tumaini', 'Head A')`);
const coord = await newUser(db, 'coord@x.com', 'Coord A');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord]);
const headB = await newUser(db, 'headb@x.com', 'Head B');
const [{ create_my_school: schoolB }] = await q(headB, `select create_my_school('Upendo', 'Head B')`);

// ---------- TC-04 / TC-05: registration ----------
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id) values ($1,$2,$3,$4,$5) returning beneficiary_id`;
const [{ beneficiary_id: amina }] = await q(coord, add, [school, 'Amina Test', 'TUM-001', 10, '04A1B2C3']);
const list = await q(coord, `select full_name from beneficiaries where school_id = $1`, [school]);
ok('TC-04', 'learner saved and listed', list.some((r) => r.full_name === 'Amina Test'));
const dupAdm = await err(coord, add, [school, 'Other', 'TUM-001', 9, '04FFFF01']);
ok('TC-05', 'duplicate admission number rejected', dupAdm?.includes('23505'), dupAdm);
await q(headB, add, [schoolB, 'B learner', 'UP-001', 9, '04BBBB01']);
const dupTag = await err(coord, add, [school, 'Other', 'TUM-002', 9, '04BBBB01']);
ok('TC-05', 'card UID already used at another school rejected', dupTag?.includes('23505'), dupTag);
const missing = await err(coord, `insert into beneficiaries (school_id, admission_no) values ($1, 'TUM-009')`, [school]);
ok('TC-05', 'missing required name rejected', missing?.includes('23502'), missing);
const [{ beneficiary_id: baraka }] = await q(coord, add, [school, 'Baraka Test', 'TUM-002', 11, '04A1B2C4']);
await q(coord, add, [school, 'Inactive Test', 'TUM-003', 11, '04A1B2C5']);
await q(coord, `update beneficiaries set status = 'inactive' where admission_no = 'TUM-003' and school_id = $1`, [school]);

// Timetable: lunch open all day today, so scans fall inside a window.
const today = (await q(null, `select extract(isodow from now() at time zone timezone)::int d, (now() at time zone timezone)::date dt from schools where school_id = $1`, [school]))[0];
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '00:00', '23:59:59')`, [today.d]);

// ---------- TC-06: app attendance ----------
await q(coord, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status, recorded_by) values ($1, 'lunch', $2, 'present', $3)`, [baraka, today.dt, coord]);
const appRec = await q(null, `select recorded_by, device_id, school_id from meal_attendance where beneficiary_id = $1`, [baraka]);
ok('TC-06', 'one record, recorded_by = coordinator, no device', appRec.length === 1 && appRec[0].recorded_by === coord && appRec[0].device_id === null && appRec[0].school_id === school);
const appDup = await err(coord, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status, recorded_by) values ($1, 'lunch', $2, 'present', $3)`, [baraka, today.dt, coord]);
ok('TC-06', 'second manual entry for the same meal rejected', appDup?.includes('23505'), appDup);

// ---------- TC-03: permission turned off ----------
await q(null, `delete from school_role_permissions where school_id = $1 and role = 'coordinator' and permission = 'record_attendance'`, [school]);
const blocked = await err(coord, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'breakfast', $2, 'present')`, [amina, today.dt]);
ok('TC-03', 'insert rejected by RLS once record_attendance is off', blocked?.includes('42501') || blocked?.includes('row-level security'), blocked);
const crossSchool = await err(headB, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'breakfast', $2, 'present')`, [amina, today.dt]);
ok('TC-03', "another school's headteacher cannot record for this school", crossSchool !== null, crossSchool);
ok('TC-03', "another school sees none of this school's learners", n(await q(headB, `select count(*) from beneficiaries where school_id = $1`, [school])) === 0);
await q(null, `insert into school_role_permissions (school_id, role, permission) values ($1, 'coordinator', 'record_attendance')`, [school]);

// ---------- TC-07 / TC-08 / TC-09: reader endpoint ----------
await q(null, `insert into nfc_devices (device_id, school_id, device_name) values ('reader-test-01', $1, 'Test reader')`, [school]);
const scan = async (tag, dev = 'reader-test-01') => { await db.exec('set role anon'); try { return (await db.query('select record_nfc_scan($1, $2) r', [tag, dev])).rows[0].r; } finally { await db.exec('reset role'); } };
let r = await scan('04A1B2C3');
const nfcRec = await q(null, `select device_id, recorded_by, nfc_tag_id from meal_attendance where beneficiary_id = $1`, [amina]);
ok('TC-07', 'registered card: success, one record with device_id', r.success === true && nfcRec.length === 1 && nfcRec[0].device_id === 'reader-test-01' && nfcRec[0].recorded_by === null, JSON.stringify(r));
let dupResults = [];
for (let i = 0; i < 10; i++) dupResults.push((await scan('04A1B2C3')).error);
const after = n(await q(null, `select count(*) from meal_attendance where beneficiary_id = $1`, [amina]));
ok('TC-08', '10 repeat taps -> already_recorded, still one record', dupResults.every((e) => e === 'already_recorded') && after === 1);
r = await scan('04DEAD99');
ok('TC-09', 'unregistered card -> unknown_tag, nothing stored', r.error === 'unknown_tag' && n(await q(null, `select count(*) from meal_attendance where nfc_tag_id = '04DEAD99'`)) === 0);
r = await scan('04A1B2C5');
ok('TC-09', 'inactive learner -> not_eligible', r.error === 'not_eligible');
r = await scan('04BBBB01');
ok('TC-09', "other school's card -> wrong_school", r.error === 'wrong_school');
r = await scan('04A1B2C3', 'reader-unknown');
ok('TC-09', 'unregistered reader rejected', r.error === 'unregistered_or_inactive_device');
const logs = await q(null, `select action_type, count(*)::int c from nfc_tag_logs group by 1 order by 1`);
ok('TC-09', 'every rejected attempt logged', ['already_recorded', 'unknown_tag', 'not_eligible', 'wrong_school', 'inactive_device'].every((a) => logs.some((l) => l.action_type === a)), JSON.stringify(logs));
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
r = await scan('04A1B2C4');
ok('TC-09', 'tap outside any meal window -> outside_meal_time', r.error === 'outside_meal_time');

// ---------- TC-10 / TC-11: stock ----------
const [{ food_id: food }] = await q(null, `select food_id from food_items where school_id is null order by item_name limit 1`);
await q(coord, `select record_stock_received($1, 100, 'Test supplier')`, [food]);
const [item] = await q(coord, `select item_id, quantity_available::numeric qty from inventory_items where school_id = $1 and food_id = $2`, [school, food]);
ok('TC-10', 'food received: stock 0 -> 100', Number(item.qty) === 100);
await q(head, `update inventory_items set reorder_level = 30 where item_id = $1`, [item.item_id]);
const use = `insert into food_consumption (item_id, meal_type, consumption_date, quantity, recorded_by) values ($1, 'lunch', $2, $3, $4)`;
await q(coord, use, [item.item_id, today.dt, 75, coord]);
const [low] = await q(coord, `select quantity_available::numeric qty, (quantity_available <= reorder_level) low from inventory_items where item_id = $1`, [item.item_id]);
ok('TC-10', 'food used 75: stock 25, at/below reorder level 30 (low stock)', Number(low.qty) === 25 && low.low === true);
const over = await err(coord, use, [item.item_id, today.dt, 25.5, coord]);
ok('TC-11', 'use 25.5 with 25 in stock rejected', over?.includes('23514'), over);
ok('TC-11', '...and stock unchanged', n(await q(null, `select quantity_available from inventory_items where item_id = $1`, [item.item_id])) === 25);
await q(coord, use, [item.item_id, today.dt, 25, coord]);
ok('TC-11', 'use exactly 25 accepted, stock becomes 0', n(await q(null, `select quantity_available from inventory_items where item_id = $1`, [item.item_id])) === 0);
const zero = await err(coord, use, [item.item_id, today.dt, 0, coord]);
ok('TC-11', 'zero amount rejected', zero !== null, zero);

// ---------- TC-12 / TC-13: report and dashboard totals ----------
// Known data: 7 days of attendance for school A (3 learners x lunch, 2 x breakfast
// on even days) and noise at school B that must not be counted.
await q(null, `delete from meal_attendance`);
const learners = (await q(null, `select beneficiary_id from beneficiaries where school_id = $1 and status = 'active'`, [school])).map((x) => x.beneficiary_id);
const extra = [];
for (let i = 0; i < 3; i++) extra.push((await q(coord, add, [school, `Extra ${i}`, `TUM-1${i}`, 10, `05000${i}`]))[0].beneficiary_id);
const all = [...learners, ...extra]; // 5 active learners
let expected = 0;
for (let d = 0; d < 7; d++) {
  for (const [meal, count] of [['lunch', 3], ['breakfast', d % 2 === 0 ? 2 : 0]]) {
    for (const b of all.slice(0, count)) {
      await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, $2, $3::date - $4::int, 'present')`, [b, meal, today.dt, d]);
      expected++;
    }
  }
}
const bId = (await q(null, `select beneficiary_id from beneficiaries where school_id = $1`, [schoolB]))[0].beneficiary_id;
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [bId, today.dt]);
// Same filter as ReportsScreen (last 7 days), run as the coordinator under RLS.
const rep = await q(coord, `select meal_type, count(*)::int c from meal_attendance where school_id = any($1) and attendance_date between $2::date - 6 and $2::date group by 1`, [[school], today.dt]);
const repTotal = rep.reduce((s, x) => s + x.c, 0);
const truth = n(await q(null, `select count(*) from meal_attendance where school_id = $1`, [school]));
ok('TC-12', `7-day report total ${repTotal} = database ${truth} = expected ${expected}`, repTotal === truth && truth === expected);
ok('TC-12', 'per-meal totals: lunch 21, breakfast 8', rep.find((x) => x.meal_type === 'lunch')?.c === 21 && rep.find((x) => x.meal_type === 'breakfast')?.c === 8);
// Dashboard counts (DashboardScreen: active students, stock items, coordinators).
const dash = (await q(head, `select
  (select count(*) from beneficiaries where school_id = $1 and status = 'active')::int students,
  (select count(*) from inventory_items where school_id = $1)::int items,
  (select count(*) from users where school_id = $1 and role = 'coordinator')::int coords`, [school]))[0];
ok('TC-13', `dashboard counts ${JSON.stringify(dash)} match the data`, dash.students === 5 && dash.items === 1 && dash.coords === 1);

const pass = results.filter((x) => x.cond).length;
console.log(`\n${pass} passed, ${results.length - pass} failed`);
process.exit(pass === results.length ? 0 : 1);
