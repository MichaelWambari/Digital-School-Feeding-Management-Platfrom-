// Fix 026: the learner's NEMIS UPI.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test026.mjs
import { freshDb, as, newUser } from './db.mjs';
import { parseStudentCsv } from '../../src/lib/studentCsv.ts';
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`);
};

// ---------- CSV reader ----------
const p = parseStudentCsv('Adm No,Name,NEMIS UPI\nJAS-1,A B,a1b 2c3\n');
ok('a "NEMIS UPI" column is read, in capitals without spaces', p.columns[2].field === 'upi' && p.rows[0].upi === 'A1B2C3', JSON.stringify(p.rows));

// ---------- database ----------
const db = await freshDb(26);
const q = async (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const err = async (uid, sql, params = []) => {
  try { await q(uid, sql, params); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`; }
};
const headA = await newUser(db, 'a@x.com', 'Head A');
const [{ create_my_school: jasiri }] = await q(headA, `select create_my_school('Jasiri', 'Head A')`);
const headB = await newUser(db, 'b@x.com', 'Head B');
const [{ create_my_school: tumaini }] = await q(headB, `select create_my_school('Tumaini', 'Head B')`);
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, upi) values ($1, $2, $3, 12, $4) returning beneficiary_id, upi`;

const [brian] = await q(headA, add, [jasiri, 'Brian Otieno', 'JAS-001', ' a1b2 c3d ']);
ok('UPI stored in capitals without spaces', brian.upi === 'A1B2C3D', brian.upi);
ok('UPI is optional', (await err(headA, add, [jasiri, 'No Upi', 'JAS-002', null])) === null);
ok('an empty UPI is stored as none', (await q(headA, add, [jasiri, 'Empty Upi', 'JAS-003', '  ']))[0].upi === null);
const bad = await err(headA, add, [jasiri, 'Bad', 'JAS-004', 'A1-B2']);
ok('a UPI with punctuation is refused', bad?.includes('beneficiaries_upi_format'), bad);
const dupHere = await err(headA, add, [jasiri, 'Twin', 'JAS-005', 'a1b2c3d']);
ok('the same UPI twice at one school is refused', dupHere?.includes('23505'), dupHere);

// Transfer: blocked while Brian is active at Jasiri, allowed once he has left.
const early = await err(headB, add, [tumaini, 'Brian Otieno', 'TUM-050', 'A1B2C3D']);
ok('another school cannot add an active learner with the same UPI', early?.includes('beneficiaries_active_upi_key'), early);
await q(headA, `update beneficiaries set status = 'inactive' where beneficiary_id = $1`, [brian.beneficiary_id]);
ok('after Jasiri marks him left, Tumaini can add him', (await err(headB, add, [tumaini, 'Brian Otieno', 'TUM-050', 'A1B2C3D'])) === null);
const back = await err(headA, `update beneficiaries set status = 'active' where beneficiary_id = $1`, [brian.beneficiary_id]);
ok('Jasiri cannot reactivate him while he is active at Tumaini', back?.includes('beneficiaries_active_upi_key'), back);

await q(headB, add, [tumaini, 'Tumaini kid', 'TUM-099', 'TUM0099']);

// ---------- import ----------
const imp = (uid, school, rows, { deactivate = false, dry = true } = {}) =>
  q(uid, `select import_students($1, $2::jsonb, $3, $4) r`, [school, JSON.stringify(rows), deactivate, dry]).then((r) => r[0].r);
const one = async (school, adm) => (await q(null, `select * from beneficiaries where school_id = $1 and admission_no = $2`, [school, adm]))[0];

let r = await imp(headA, jasiri, [
  { row: 2, admission_no: 'JAS-002', upi: 'zz9 9zz' },
  { row: 3, admission_no: 'JAS-010', full_name: 'New Kid', upi: 'NEW0001' },
], { dry: false });
ok('import adds a UPI to an existing student and a new one', r.applied && (await one(jasiri, 'JAS-002')).upi === 'ZZ99ZZ' && (await one(jasiri, 'JAS-010')).upi === 'NEW0001', JSON.stringify(r));

r = await imp(headA, jasiri, [
  { row: 2, admission_no: 'JAS-011', full_name: 'A', upi: 'NEW0001' },
  { row: 3, admission_no: 'JAS-012', full_name: 'B', upi: 'DUP0001' },
  { row: 4, admission_no: 'JAS-013', full_name: 'C', upi: 'dup0001' },
  { row: 5, admission_no: 'JAS-014', full_name: 'D', upi: 'TUM0099' },
  { row: 6, admission_no: 'JAS-015', full_name: 'E', upi: 'A-1' },
  { row: 7, admission_no: 'JAS-016', full_name: 'F', upi: 'A1B2C3D' },
]);
const msgs = Object.fromEntries(r.errors.map((e) => [e.row, e.messages.join(' | ')]));
ok('UPI already on a student here names them', msgs[2]?.includes('New Kid (JAS-010)'), msgs[2]);
ok('UPI twice in the file', msgs[4]?.includes('also on line 3'), msgs[4]);
ok('UPI active at another school is refused without naming the child', msgs[5]?.includes('another school') && !msgs[5].includes('Tumaini kid'), msgs[5]);
ok('bad UPI format', msgs[6]?.includes('3-20 letters'), msgs[6]);
ok("a UPI kept on a former student's record here stays theirs", msgs[7]?.includes('Brian Otieno (JAS-001)'), msgs[7]);
ok('the rest of the rows are fine', !msgs[3]);
r = await imp(headA, jasiri, [{ row: 2, admission_no: 'JAS-017', full_name: 'G', upi: 'TUM0099', status: 'inactive' }]);
ok('a UPI active elsewhere may be added as an inactive (past) record', r.error_count === 0, JSON.stringify(r.errors));

// Students leaving in the same import free their UPI... at the same school a UPI is still once per school.
r = await imp(headA, jasiri, [{ row: 2, admission_no: 'JAS-002' }], { deactivate: true });
ok('dry run with "make missing inactive" still works', r.error_count === 0 && r.deactivated > 0, JSON.stringify(r));

const cross = await err(headB, `select import_students($1, '[{"admission_no":"X","full_name":"Y","upi":"QQQ111"}]'::jsonb)`, [jasiri]);
ok("another school can't import into this one", cross?.includes('42501'), cross);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
