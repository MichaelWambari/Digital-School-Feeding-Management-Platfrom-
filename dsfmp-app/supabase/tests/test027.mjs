// Fix 027: link a card that was just tapped and refused as unknown.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test027.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(27);
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
const headB = await newUser(db, 'headb@x.com', 'Head B');
const [{ create_my_school: schoolB }] = await q(headB, `select create_my_school('Upendo', 'Head B')`);
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id) values ($1, $2, $3, 12, $4) returning beneficiary_id`;
const [{ beneficiary_id: brian }] = await q(head, add, [school, 'Brian Otieno', 'JAS-001', null]);
const [{ beneficiary_id: faith }] = await q(head, add, [school, 'Faith Wanjiru', 'JAS-002', 'OLD00001']);
const [{ beneficiary_id: kevin }] = await q(head, add, [school, 'Kevin Mutua', 'JAS-003', 'K0000001']);
const [{ beneficiary_id: bee }] = await q(headB, add, [schoolB, 'Bee Student', 'UP-001', null]);
await q(null, `insert into nfc_devices (device_id, school_id, device_name) values ('reader-a1', $1, 'Dining hall reader')`, [school]);
await q(null, `insert into nfc_devices (device_id, school_id) values ('reader-b1', $1)`, [schoolB]);

const scan = async (tag, dev = 'reader-a1') => {
  await db.exec('set role anon');
  try { return (await db.query(`select record_nfc_scan(p_nfc_tag_id => $1, p_device_id => $2) r`, [tag, dev])).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const unknown = (uid = coord, s = school) => q(uid, `select * from recent_unknown_cards($1)`, [s]);
const link = (tag, student, uid = coord, s = school) => q(uid, `select link_unknown_card($1, $2, $3) r`, [s, tag, student]).then((r) => r[0].r);
const tagOf = async (id) => (await q(null, `select nfc_tag_id from beneficiaries where beneficiary_id = $1`, [id]))[0].nfc_tag_id;

ok('nothing unknown yet', (await unknown()).length === 0);
await scan('04AAAA01');
await scan('04AAAA01');
await scan('04BBBB02');
await scan('K0000001'); // Kevin's card: known, not listed
await scan('04CCCC03', 'reader-b1'); // tapped at the other school
let list = await unknown();
ok('unknown cards tapped here are listed, newest first, known cards left out',
  list.length === 2 && list[0].nfc_tag_id === '04BBBB02' && list[1].nfc_tag_id === '04AAAA01', JSON.stringify(list));
ok('with the reader name and the number of taps', list[1].device_name === 'Dining hall reader' && list[1].taps === 2);
ok('the other school sees only its own unknown card', (await unknown(headB, schoolB)).map((c) => c.nfc_tag_id).join() === '04CCCC03');

// Permissions
const otherSchool = await err(headB, `select * from recent_unknown_cards($1)`, [school]);
ok("another school can't list this school's unknown cards", otherSchool?.includes('42501'), otherSchool);
await q(null, `delete from school_role_permissions where school_id = $1 and role = 'coordinator' and permission = 'manage_students'`, [school]);
const noPerm = await err(coord, `select * from recent_unknown_cards($1)`, [school]);
ok('a coordinator without manage_students cannot see them', noPerm?.includes('42501'), noPerm);
await q(null, `insert into school_role_permissions (school_id, role, permission) values ($1, 'coordinator', 'manage_students')`, [school]);
const anonCall = await (async () => { await db.exec('set role anon'); try { await db.query(`select * from recent_unknown_cards($1)`, [school]); return null; } catch (e) { return e.message; } finally { await db.exec('reset role'); } })();
ok('the anon key cannot call it', anonCall !== null, anonCall);

// Linking
let r = await link('04aaaa01', brian);
ok('link an unknown card to a student (any case)', r.first_name === 'Brian' && (await tagOf(brian)) === '04AAAA01', JSON.stringify(r));
ok('a linked card drops off the list', (await unknown()).map((c) => c.nfc_tag_id).join() === '04BBBB02');
r = await scan('04AAAA01');
ok('the reader now knows the card', r.error !== 'unknown_tag', JSON.stringify(r));
r = await link('04BBBB02', faith);
ok("linking replaces the student's old card and says which", r.replaced === 'OLD00001' && (await tagOf(faith)) === '04BBBB02', JSON.stringify(r));

const notTapped = await err(coord, `select link_unknown_card($1, 'NEVER001', $2)`, [school, kevin]);
ok('a card never tapped here cannot be linked this way', notTapped?.includes('not tapped'), notTapped);
const elsewhere = await err(coord, `select link_unknown_card($1, '04CCCC03', $2)`, [school, kevin]);
ok("a card tapped only at another school's reader cannot be linked here", elsewhere?.includes('not tapped'), elsewhere);
const wrongStudent = await err(coord, `select link_unknown_card($1, '04BBBB02', $2)`, [school, bee]);
ok("another school's student cannot be picked", wrongStudent?.includes('not at this school'), wrongStudent);
await scan('04DDDD04');
await q(null, `update beneficiaries set nfc_tag_id = '04DDDD04' where beneficiary_id = $1`, [kevin]); // linked meanwhile
const inUse = await err(coord, `select link_unknown_card($1, '04DDDD04', $2)`, [school, brian]);
ok('a card linked meanwhile to someone else is refused, naming them', inUse?.includes('Kevin Mutua (JAS-003)'), inUse);
r = await link('04DDDD04', kevin);
ok("linking a student's own card again is harmless", r.first_name === 'Kevin' && r.replaced === null);
const crossLink = await err(headB, `select link_unknown_card($1, '04BBBB02', $2)`, [school, brian]);
ok("another school can't link cards here", crossLink?.includes('42501'), crossLink);

// Ignoring
await scan('04EEEE05');
await q(coord, `select ignore_unknown_card($1, $2)`, [school, '04EEEE05']);
ok('an ignored card drops off the list', !(await unknown()).some((c) => c.nfc_tag_id === '04EEEE05'));
await q(null, `update nfc_tag_logs set created_at = created_at - interval '1 minute' where action_type = 'card_ignored'`);
await scan('04EEEE05');
ok('it comes back if tapped again after being ignored', (await unknown()).some((c) => c.nfc_tag_id === '04EEEE05'));

// Old taps
await scan('04FFFF06');
await q(null, `update nfc_tag_logs set created_at = now() - interval '2 days' where nfc_tag_id = '04FFFF06'`);
ok('taps older than the window are not listed', !(await unknown()).some((c) => c.nfc_tag_id === '04FFFF06'));
ok('...but can still be listed with a longer window', (await q(coord, `select * from recent_unknown_cards($1, 72)`, [school])).some((c) => c.nfc_tag_id === '04FFFF06'));

const logs = await q(null, `select action_type, count(*)::int c from nfc_tag_logs where action_type in ('card_linked','card_ignored') group by 1 order by 1`);
// Brian and Faith; re-linking Kevin's own card changed nothing, so isn't logged.
ok('links and ignores are logged', logs.length === 2 && logs.find((l) => l.action_type === 'card_linked').c === 2, JSON.stringify(logs));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
