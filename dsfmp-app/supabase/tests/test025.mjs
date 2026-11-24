// Fix 025: import students from a CSV. Checks the app's CSV reader
// (src/lib/studentCsv.ts) and the database's import_students().
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test025.mjs
import { freshDb, as, newUser } from './db.mjs';
import { parseStudentCsv, normaliseDate } from '../../src/lib/studentCsv.ts';
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`);
};

// ---------- the CSV reader ----------
let p = parseStudentCsv('﻿Adm No,First name,Surname,DOB,Gender,Class,Card\r\n' +
  'JAS-011,Jane,Wanjiku,21/03/2014,F,4 East,\r\n' +
  '"JAS-012","Peter ""Pete""",Otieno,2013-7-2,boy,4 West,04 a1 b2 c3\r\n\r\n');
ok('reads headers by their usual names, ignores Class', p.problem === null &&
  p.columns.map((c) => c.field).join(',') === 'admission_no,first_name,last_name,date_of_birth,sex,,nfc_tag_id',
  JSON.stringify(p.columns));
ok('joins first name and surname; handles quotes and BOM', p.rows[0].full_name === 'Jane Wanjiku' && p.rows[1].full_name === 'Peter "Pete" Otieno');
ok('dates to YYYY-MM-DD, day first', p.rows[0].date_of_birth === '2014-03-21' && p.rows[1].date_of_birth === '2013-07-02');
ok('sex words tidied', p.rows[0].sex === 'female' && p.rows[1].sex === 'male');
ok('card IDs tidied, empty cells left out', p.rows[1].nfc_tag_id === '04A1B2C3' && !('nfc_tag_id' in p.rows[0]));
ok('line numbers count from the header (line 1)', p.rows[0].row === 2 && p.rows[1].row === 3);
p = parseStudentCsv('Admission number;Name;Status\nJAS-1;A B;left\n');
ok('semicolon files (Excel in many regions)', p.rows[0].admission_no === 'JAS-1' && p.rows[0].status === 'inactive');
p = parseStudentCsv('Adm\tStudent name\nJAS-1\tA B\n');
ok('tab-separated (cells pasted from a spreadsheet)', p.rows[0].full_name === 'A B');
p = parseStudentCsv('Adm,Name\n"JAS-1","Line\nbreak"\nJAS-2,C\n');
ok('a line break inside quotes keeps the line count right', p.rows[1].row === 4 && p.rows[0].full_name === 'Line break');
ok('no admission column -> a clear problem', parseStudentCsv('Name,Age\nA,10\n').problem?.includes('admission'));
ok('no name column -> a clear problem', parseStudentCsv('Adm,Age\nX,10\n').problem?.includes('name'));
ok('odd dates passed on for the database to report', normaliseDate('March 2014') === 'March 2014' && normaliseDate('21/03/2014 00:00') === '2014-03-21');

// ---------- the database ----------
const db = await freshDb(25);
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
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, sex, date_of_birth, nfc_tag_id) values ($1,$2,$3,$4,$5,$6,$7)`;
await q(head, add, [school, 'Brian Otieno', 'JAS-001', null, 'male', '2014-05-01', 'F3C069E7']);
await q(head, add, [school, 'Faith Wanjiru', 'JAS-002', 11, 'female', null, '35D5898E']);
await q(head, add, [school, 'Kevin Mutua', 'JAS-003', 12, 'male', null, null]);
await q(headB, add, [schoolB, 'Bee Student', 'UP-001', 9, null, null, 'BBBB0001']);

const imp = (uid, rows, { deactivate = false, dry = true } = {}) =>
  q(uid, `select import_students($1, $2::jsonb, $3, $4) r`, [school, JSON.stringify(rows), deactivate, dry]).then((r) => r[0].r);
const student = async (adm) => (await q(null, `select * from beneficiaries where school_id = $1 and admission_no = $2`, [school, adm]))[0];
const count = async () => Number((await q(null, `select count(*) c from beneficiaries where school_id = $1`, [school]))[0].c);

// Permissions
const notAllowed = await err(headB, `select import_students($1, '[{"admission_no":"X","full_name":"Y"}]'::jsonb)`, [school]);
ok("another school's headteacher can't import here", notAllowed?.includes('42501'), notAllowed);
await q(null, `delete from school_role_permissions where school_id = $1 and role = 'coordinator' and permission = 'manage_students'`, [school]);
const noPerm = await err(coord, `select import_students($1, '[{"admission_no":"X","full_name":"Y"}]'::jsonb)`, [school]);
ok('a coordinator without manage_students cannot import', noPerm?.includes('42501'), noPerm);
await q(null, `insert into school_role_permissions (school_id, role, permission) values ($1, 'coordinator', 'manage_students')`, [school]);

// A clean file: 2 new, 1 update, 1 unchanged.
const clean = [
  { row: 2, admission_no: 'JAS-011', full_name: 'Jane Wanjiku', date_of_birth: '2014-03-21', sex: 'female' },
  { row: 3, admission_no: 'jas-012', full_name: 'Peter Otieno', age: '12', sex: 'male', nfc_tag_id: '04A1B2C3' },
  { row: 4, admission_no: 'jas-003', full_name: 'Kevin Mutua', date_of_birth: '2013-01-10' },
  { row: 5, admission_no: 'JAS-002', full_name: 'Faith Wanjiru' },
];
let r = await imp(coord, clean);
ok('dry run counts: 2 new, 1 updated, 1 unchanged, no errors',
  r.inserted === 2 && r.updated === 1 && r.unchanged === 1 && r.error_count === 0 && r.applied === false, JSON.stringify(r));
ok('dry run saves nothing', (await count()) === 3);
r = await imp(coord, clean, { dry: false });
ok('import applied', r.applied === true && (await count()) === 5, JSON.stringify(r));
const jane = await student('JAS-011');
ok('new student has name, DOB, age from DOB, sex, active', jane.full_name === 'Jane Wanjiku' && jane.age !== null && jane.sex === 'female' && jane.status === 'active');
ok('admission number matched ignoring case (jas-003 = JAS-003)', (await student('JAS-003')).date_of_birth !== null && !(await student('jas-003')));
ok('a column not in the file is left alone (Faith keeps her card)', (await student('JAS-002')).nfc_tag_id === '35D5898E');
ok('new student with a card', (await student('jas-012')).nfc_tag_id === '04A1B2C3');
r = await imp(coord, clean);
ok('importing the same file again changes nothing', r.inserted === 0 && r.updated === 0 && r.unchanged === 4, JSON.stringify(r));

// Errors: all or nothing.
const bad = [
  { row: 2, admission_no: 'JAS-020', full_name: 'Good Row' },
  { row: 3, full_name: 'No Number' },
  { row: 4, admission_no: 'JAS-021' },
  { row: 5, admission_no: 'JAS-022', full_name: 'Bad Date', date_of_birth: '2014-02-30' },
  { row: 6, admission_no: 'JAS-023', full_name: 'Future', date_of_birth: '2099-01-01' },
  { row: 7, admission_no: 'JAS-024', full_name: 'Text date', date_of_birth: 'March 2014' },
  { row: 8, admission_no: 'JAS-025', full_name: 'Bad sex', sex: 'x' },
  { row: 9, admission_no: 'jas-020', full_name: 'Dup number' },
  { row: 10, admission_no: 'JAS-026', full_name: 'Brians card', nfc_tag_id: 'F3C069E7' },
  { row: 11, admission_no: 'JAS-027', full_name: 'Other school card', nfc_tag_id: 'BBBB0001' },
  { row: 12, admission_no: 'JAS-028', full_name: 'Dup card A', nfc_tag_id: 'DDDD0001' },
  { row: 13, admission_no: 'JAS-029', full_name: 'Dup card B', nfc_tag_id: 'DDDD0001' },
  { row: 14, admission_no: 'JAS-030', full_name: 'Bad age', age: 'ten' },
  { row: 15, admission_no: 'JAS-031', full_name: 'Bad status', status: 'maybe' },
];
r = await imp(coord, bad, { dry: false });
const msgs = Object.fromEntries(r.errors.map((e) => [e.row, e.messages.join(' | ')]));
ok('a file with errors saves nothing at all', r.applied === false && (await count()) === 5 && !(await student('JAS-020')));
ok('missing admission number', msgs[3]?.includes('Admission number is missing'), msgs[3]);
ok('missing name for a new student', msgs[4]?.includes('Full name is missing'), msgs[4]);
ok('impossible date', msgs[5]?.includes('not a real date'), msgs[5]);
ok('date in the future', msgs[6]?.includes('future'), msgs[6]);
ok('unreadable date', msgs[7]?.includes('not a date'), msgs[7]);
ok('bad sex', msgs[8]?.includes('female or male'), msgs[8]);
ok('admission number twice in the file names the first line', msgs[9]?.includes('also on line 2'), msgs[9]);
ok("card already on a student here names them", msgs[10]?.includes('Brian Otieno (JAS-001)'), msgs[10]);
ok("card at another school doesn't reveal who", msgs[11]?.includes('another school') && !msgs[11].includes('Bee'), msgs[11]);
ok('same card twice in the file', msgs[13]?.includes('also on line 12'), msgs[13]);
ok('bad age', msgs[14]?.includes('not a whole number'), msgs[14]);
ok('bad status', msgs[15]?.includes('active or inactive'), msgs[15]);
ok('the good row is not flagged', !msgs[2]);
ok('error count adds up', r.error_count === 12, r.error_count);

// Card swap within one file is fine.
r = await imp(coord, [
  { row: 2, admission_no: 'JAS-001', nfc_tag_id: '35D5898E' },
  { row: 3, admission_no: 'JAS-002', nfc_tag_id: 'F3C069E7' },
], { dry: false });
ok('two students swapping cards in one file', r.applied && (await student('JAS-001')).nfc_tag_id === '35D5898E' && (await student('JAS-002')).nfc_tag_id === 'F3C069E7', JSON.stringify(r));
r = await imp(coord, [{ row: 2, admission_no: 'JAS-003', nfc_tag_id: '35D5898E' }]);
ok("taking another student's card is refused", r.error_count === 1, JSON.stringify(r.errors));

// Mark missing students inactive.
r = await imp(coord, [{ row: 2, admission_no: 'JAS-001' }, { row: 3, admission_no: 'JAS-002' }], { deactivate: true });
ok('dry run counts who would be made inactive', r.deactivated === 3 && (await student('JAS-003')).status === 'active', JSON.stringify(r));
r = await imp(coord, [{ row: 2, admission_no: 'JAS-001' }, { row: 3, admission_no: 'JAS-002' }], { deactivate: true, dry: false });
ok('students missing from the file are made inactive, not deleted', r.applied && (await student('JAS-003')).status === 'inactive' && (await count()) === 5);
r = await imp(coord, [{ row: 2, admission_no: 'JAS-003', status: 'active' }], { dry: false });
ok('a returning student can be made active again', (await student('JAS-003')).status === 'active');
ok("the other school's students are untouched", (await q(null, `select status from beneficiaries where admission_no = 'UP-001'`))[0].status === 'active');

const empty = await err(coord, `select import_students($1, '[]'::jsonb)`, [school]);
ok('an empty file is refused', empty?.includes('no students'), empty);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
