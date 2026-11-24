// Fix 024: link a student's card by tapping it on a reader.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test024.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(24);
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`);
};
const q = async (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const err = async (uid, sql, params = []) => {
  try { await q(uid, sql, params); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`; }
};

// School A: headteacher, coordinator, two students without cards, one with, two readers.
const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Jasiri', 'Head A')`);
const coord = await newUser(db, 'coord@x.com', 'Coord A');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord]);
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id) values ($1, $2, $3, 12, $4) returning beneficiary_id`;
const [{ beneficiary_id: brian }] = await q(head, add, [school, 'Brian Otieno', 'JAS-001', null]);
const [{ beneficiary_id: faith }] = await q(head, add, [school, 'Faith Wanjiru', 'JAS-002', null]);
const [{ beneficiary_id: kevin }] = await q(head, add, [school, 'Kevin Mutua', 'JAS-003', 'K0000001']);
await q(null, `insert into nfc_devices (device_id, school_id) values ('reader-a1', $1), ('reader-a2', $1)`, [school]);
await q(null, `insert into nfc_devices (device_id, school_id, status) values ('reader-a3', $1, 'inactive')`, [school]);

// School B: its own headteacher, student and reader.
const headB = await newUser(db, 'headb@x.com', 'Head B');
const [{ create_my_school: schoolB }] = await q(headB, `select create_my_school('Upendo', 'Head B')`);
const [{ beneficiary_id: bStudent }] = await q(headB, add, [schoolB, 'Bee Student', 'UP-001', null]);
await q(null, `insert into nfc_devices (device_id, school_id) values ('reader-b1', $1)`, [schoolB]);

// No meal is being served (empty timetable), so a link must work outside meal times.
await q(null, `delete from meal_schedules where school_id = $1`, [school]);

const scan = async (tag, dev = 'reader-a1') => {
  await db.exec('set role anon');
  try { return (await db.query(`select record_nfc_scan(p_nfc_tag_id => $1, p_device_id => $2) r`, [tag, dev])).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const start = async (uid, student, dev = 'reader-a1') =>
  (await q(uid, `select start_card_link($1, $2) r`, [student, dev]))[0].r;
const request = async (id) => (await q(null, `select * from card_link_requests where request_id = $1`, [id]))[0];
const tagOf = async (id) => (await q(null, `select nfc_tag_id from beneficiaries where beneficiary_id = $1`, [id]))[0].nfc_tag_id;

// ---------- who may start a link ----------
let r = await scan('04AAAA01');
ok('without a link, an unlinked card is unknown_tag', r.error === 'unknown_tag');
const req1 = await start(coord, brian);
ok('a coordinator (manage_students) can start a link', !!req1.request_id, JSON.stringify(req1));
const crossStudent = await err(headB, `select start_card_link($1, 'reader-b1')`, [brian]);
ok("another school's headteacher cannot link this school's student", crossStudent?.includes('42501'), crossStudent);
const crossReader = await err(head, `select start_card_link($1, 'reader-b1')`, [brian]);
ok("a reader from another school is refused", crossReader?.includes('P0002'), crossReader);
const inactive = await err(head, `select start_card_link($1, 'reader-a3')`, [brian]);
ok('an inactive reader is refused', inactive?.includes('22023'), inactive);
const anonCall = await (async () => { await db.exec('set role anon'); try { await db.query(`select start_card_link($1, 'reader-a1')`, [brian]); return null; } catch (e) { return e.message; } finally { await db.exec('reset role'); } })();
ok('the anon key cannot start a link', anonCall !== null, anonCall);
const peek = await q(headB, `select count(*)::int c from card_link_requests`);
ok("another school can't read this school's link requests", peek[0].c === 0);

// ---------- the tap links the card ----------
r = await scan('04AAAA01');
ok('tap while waiting -> success, linked, first name', r.success === true && r.linked === true && r.first_name === 'Brian', JSON.stringify(r));
ok('the card is now on the student', (await tagOf(brian)) === '04AAAA01');
let row = await request(req1.request_id);
ok('the request is marked linked with the card', row.status === 'linked' && row.nfc_tag_id === '04AAAA01' && row.completed_at !== null);
ok('no attendance was recorded by the link tap', (await q(null, `select count(*)::int c from meal_attendance`))[0].c === 0);
r = await scan('04AAAA02');
ok('the next tap is not a link any more', r.error === 'unknown_tag', JSON.stringify(r));
r = await scan('04AAAA01');
ok('the linked card now goes through the normal checks', r.error === 'outside_meal_time', JSON.stringify(r));

// ---------- card already on someone else ----------
const req2 = await start(coord, faith);
r = await scan('K0000001');
ok("Kevin's card on Faith's link -> card_in_use", r.error === 'card_in_use', JSON.stringify(r));
ok('Kevin keeps his card, Faith gets none', (await tagOf(kevin)) === 'K0000001' && (await tagOf(faith)) === null);
row = await request(req2.request_id);
ok('the request is marked failed: card_in_use', row.status === 'failed' && row.error === 'card_in_use' && row.nfc_tag_id === 'K0000001');

// ---------- relinking a student's own card, and replacing a card ----------
const req3 = await start(coord, brian);
r = await scan('04AAAA01');
ok("tapping a student's own card again is fine", r.linked === true && (await request(req3.request_id)).status === 'linked');
await start(coord, brian);
r = await scan('04BBBB09');
ok('a new card replaces a lost one', r.linked === true && (await tagOf(brian)) === '04BBBB09');
r = await scan('04AAAA01', 'reader-a2');
ok('the old card is unknown again', r.error === 'unknown_tag');

// ---------- one pending request per reader, readers are separate ----------
const old = await start(coord, faith);
const newer = await start(coord, brian);
ok('a new request cancels the pending one on the same reader', (await request(old.request_id)).status === 'cancelled');
r = await scan('04CCCC01', 'reader-a2');
ok("a tap on another reader doesn't use this reader's request", r.error === 'unknown_tag' && (await request(newer.request_id)).status === 'pending');
await q(coord, `select cancel_card_link($1)`, [newer.request_id]);
ok('cancel_card_link cancels it', (await request(newer.request_id)).status === 'cancelled');
r = await scan('04CCCC01');
ok('after cancelling, the tap is not a link', r.error === 'unknown_tag');
const cancelOther = await err(headB, `select cancel_card_link($1)`, [newer.request_id]);
ok("another school can't cancel this school's request", cancelOther?.includes('42501'), cancelOther);

// ---------- expiry ----------
const exp = await start(coord, faith);
await q(null, `update card_link_requests set expires_at = now() - interval '1 second' where request_id = $1`, [exp.request_id]);
r = await scan('04DDDD01');
ok('an expired request is ignored', r.error === 'unknown_tag' && (await tagOf(faith)) === null);

// ---------- reader secret still applies ----------
const [{ set_device_secret: secret }] = await q(null, `select set_device_secret('reader-a1')`);
await start(coord, faith);
r = await scan('04EEEE01');
ok('a reader with a secret still needs it to link', r.error === 'bad_device_secret' && (await tagOf(faith)) === null);
await db.exec('set role anon');
r = (await db.query(`select record_nfc_scan(p_nfc_tag_id => '04EEEE01', p_device_id => 'reader-a1', p_device_secret => $1) r`, [secret])).rows[0].r;
await db.exec('reset role');
ok('with the secret, the link works', r.linked === true && (await tagOf(faith)) === '04EEEE01');

// ---------- logging ----------
const logs = await q(null, `select action_type, count(*)::int c from nfc_tag_logs where action_type in ('card_linked', 'card_in_use') group by 1 order by 1`);
ok('links and refusals are logged', logs.length === 2, JSON.stringify(logs));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
