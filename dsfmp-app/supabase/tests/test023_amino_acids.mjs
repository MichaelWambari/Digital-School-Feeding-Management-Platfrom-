// Fix 023 (amino acids): essential amino acids (KFCT 2018 Table 3a) for protein quality.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test023_amino_acids.mjs
import { freshDb, as, newUser, read } from './db.mjs';
const db = await freshDb(22); // the amino acid fix is run below, after a record exists
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`);
};
const q = async (uid, sql, params = []) => as(db, uid, async () => (await db.query(sql, params)).rows);
const err = async (uid, sql, params = []) => {
  try { await q(uid, sql, params); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`; }
};
const num = (v) => (v === null || v === undefined ? null : Number(v));
const foodId = async (name) => (await q(null, `select food_id from food_items where school_id is null and lower(item_name) = lower($1)`, [name]))[0]?.food_id;

const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Tumaini', 'Head A')`);
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, sex) values ($1, $2, $3, $4, $5) returning beneficiary_id`;
const [{ beneficiary_id: amina }] = await q(head, add, [school, 'Amina', 'TUM-001', 13, 'female']);
const [{ beneficiary_id: otieno }] = await q(head, add, [school, 'Otieno', 'TUM-002', 8, 'male']);

// Githeri: 150 g whole maize + 75 g beans, at lunch today, recorded before the fix.
const maize = await foodId('Maize');
const beans = await foodId('Beans');
const cabbage = await foodId('Cabbage');
const [{ meal_id }] = await q(head, `insert into meals (school_id, name) values ($1, 'Githeri') returning meal_id`, [school]);
await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([{ food_id: maize, amount: 150 }, { food_id: beans, amount: 75 }])]);
const [{ d, dt }] = await q(null, `select extract(isodow from now() at time zone timezone)::int d, (now() at time zone timezone)::date::text dt from schools where school_id = $1`, [school]);
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '00:00', '23:59:59', $2)`, [d, meal_id]);
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [amina, dt]);
const before = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [amina]))[0];

await db.exec(read('fixes/023_amino_acids.sql'));
await db.exec(read('fixes/023_amino_acids.sql'));
ok('fix runs twice without error', true);

// Food values
const fv = async (name) => (await q(head, `select * from school_food_nutrition($1) where item_name = $2`, [school, name]))[0];
const b = await fv('Beans');
ok('beans: lysine 1430, histidine 525, tryptophan 190 (KFCT 3a)', num(b?.lys_mg) === 1430 && num(b?.his_mg) === 525 && num(b?.trp_mg) === 190);
const m = await fv('Maize');
ok('maize: lysine 330; trace Met/Cys/Trp filled as 132/94/46', num(m?.lys_mg) === 330 && num(m?.met_mg) === 132 && num(m?.cys_mg) === 94 && num(m?.trp_mg) === 46);
ok('oil has no protein: amino acids 0', num((await fv('Cooking oil'))?.lys_mg) === 0);
ok('cabbage has no amino acid data', (await fv('Cabbage'))?.lys_mg === null);
const n = (await q(null, `select count(*)::int n from food_nutrition where school_id is null and lys_mg is not null`))[0].n;
ok('16 shared foods have amino acids', n === 16, n);
ok('amino acids are kept in cooking', (await q(head, `select cooking_retention('beef_stewed') r`))[0].r.lys_mg === 1);

// The earlier record got its amino acids.
const rec = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [amina]))[0];
// 330*1.5 + 1430*0.75; 132*1.5 + 271*0.75
ok('earlier record: lysine 1567.5, methionine 401.25', num(rec?.lys_mg) === 1567.5 && num(rec?.met_mg) === 401.25, `${rec?.lys_mg} ${rec?.met_mg}`);
// 7.94*1.5 + 20.5*0.75 = 27.285
ok('earlier record: protein with amino acid data 27.29', num(rec?.amino_protein_g) === 27.29, rec?.amino_protein_g);
ok('earlier record: other nutrients unchanged', num(rec?.iron_mg) === num(before?.iron_mg) && num(rec?.folate_ug) === num(before?.folate_ug) && rec?.complete === before?.complete);
ok('earlier record: foods keep their amino acids per 100 g', rec?.ingredients.every((i) => i.per_100.lys_mg != null));
// Lysine per g protein: 1567.5 / 27.29 = 57.4 mg/g, above FAO's 48
ok('githeri lysine 57 mg per g protein (FAO pattern 48)', Math.round(num(rec.lys_mg) / num(rec.amino_protein_g)) === 57);

// A new meal with a food that has no amino acid data.
await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([{ food_id: maize, amount: 150 }, { food_id: cabbage, amount: 50 }])]);
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [otieno, dt]);
const r2 = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [otieno]))[0];
ok('new record: lysine 495 from the maize only', num(r2?.lys_mg) === 495, r2?.lys_mg);
ok('new record: protein with data 11.91 (cabbage left out), total protein higher',
  num(r2?.amino_protein_g) === 11.91 && num(r2?.protein_g) > 11.91, `${r2?.amino_protein_g} ${r2?.protein_g}`);
ok('missing amino acids don\'t make the record incomplete', r2?.complete === true);
// Maize alone: 330 / 7.94 = 41.6 mg lysine per g protein, below 48
ok('maize alone: lysine 42 mg per g protein, short of 48', Math.round(num(r2.lys_mg) / num(r2.amino_protein_g)) === 42);

// A school can set its own amino acid values.
await q(head, `select set_food_nutrition($1, $2, 'Lab test')`, [cabbage, JSON.stringify({ protein_g: 1.1, lys_mg: 60 })]);
ok('school override shows its lysine', num((await fv('Cabbage'))?.lys_mg) === 60);
ok('unknown amino acid refused', (await err(head, `select set_food_nutrition($1, $2, 'x')`, [cabbage, JSON.stringify({ arg_mg: 5 })]))?.includes('22023'));

// The needs assessment still works.
const a = await q(head, `select * from student_nutrient_adequacy($1, $2::date - 6, $2::date)`, [amina, dt]);
ok('needs assessment still returns 16 nutrients', a.length === 16, a.length);

console.log(failed ? `${failed} FAILED` : 'All passed');
process.exit(failed ? 1 : 0);
