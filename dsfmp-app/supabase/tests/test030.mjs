// Fix 030: data protection terms and erasing a student.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test030.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(30);
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

// ---------- terms ----------
ok('a new school has not accepted the terms', (await q(null, `select data_terms_accepted_at from schools where school_id = $1`, [school]))[0].data_terms_accepted_at === null);
let e = await err(coord, `select accept_data_terms($1)`, [school]);
ok('a coordinator cannot accept the terms', e?.includes('42501'), e);
e = await err(headB, `select accept_data_terms($1)`, [school]);
ok("another school's headteacher cannot accept them", e?.includes('42501'), e);
await q(head, `select accept_data_terms($1)`, [school]);
const [terms] = await q(null, `select data_terms_accepted_at, data_terms_accepted_by from schools where school_id = $1`, [school]);
ok('the headteacher accepts: time and person recorded', terms.data_terms_accepted_at !== null && terms.data_terms_accepted_by === head);
const [seen] = await q(coord, `select data_terms_accepted_at from schools where school_id = $1`, [school]);
ok('staff can see that the terms were accepted', seen?.data_terms_accepted_at !== null);

// ---------- erasing ----------
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, nfc_tag_id, upi) values ($1, $2, $3, 12, $4, $5) returning beneficiary_id`;
const [{ beneficiary_id: brian }] = await q(head, add, [school, 'Brian Otieno', 'JAS-001', 'CARD0001', 'ABC123']);
const [{ beneficiary_id: faith }] = await q(head, add, [school, 'Faith Wanjiru', 'JAS-002', 'CARD0002', null]);
await q(head, `update beneficiaries set full_name = 'Brian O. Otieno' where beneficiary_id = $1`, [brian]);
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date) values ($1, 'lunch', current_date), ($2, 'lunch', current_date)`, [brian, faith]);

e = await err(coord, `select erase_student($1)`, [brian]);
ok('a coordinator cannot erase a student', e?.includes('42501'), e);
const coordDelete = await q(coord, `delete from beneficiaries where beneficiary_id = $1 returning beneficiary_id`, [brian]);
ok('a coordinator cannot delete a student directly either', coordDelete.length === 0);
e = await err(headB, `select erase_student($1)`, [brian]);
ok("another school's headteacher cannot erase this school's student", e?.includes('42501'), e);

const before = await q(null, `select count(*)::int c from audit_logs where table_name = 'beneficiaries' and record_id = $1`, [brian]);
ok('the audit log has copies of the student before erasing', before[0].c >= 2, JSON.stringify(before));

await q(head, `select erase_student($1)`, [brian]);
ok('the student is gone', (await q(null, `select count(*)::int c from beneficiaries where beneficiary_id = $1`, [brian]))[0].c === 0);
ok('their attendance is gone', (await q(null, `select count(*)::int c from meal_attendance where beneficiary_id = $1`, [brian]))[0].c === 0);
ok("other students' attendance stays", (await q(null, `select count(*)::int c from meal_attendance where beneficiary_id = $1`, [faith]))[0].c === 1);
const leftovers = await q(null, `select count(*)::int c from audit_logs where changes::text ilike '%Brian%' or changes::text ilike '%ABC123%' or changes::text ilike '%JAS-001%'`);
ok('no personal data is left in the audit log', leftovers[0].c === 0, JSON.stringify(leftovers));
const erased = await q(null, `select actor_id from audit_logs where action = 'erase' and record_id = $1`, [brian]);
ok('the erasure itself is logged, with who did it', erased.length === 1 && erased[0].actor_id === head);
const faithLog = await q(null, `select count(*)::int c from audit_logs where changes::text ilike '%Faith%'`);
ok("other students' audit entries are untouched", faithLog[0].c >= 1);
e = await err(head, `select erase_student($1)`, [brian]);
ok('erasing again says not found', e?.includes('P0002'), e);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
