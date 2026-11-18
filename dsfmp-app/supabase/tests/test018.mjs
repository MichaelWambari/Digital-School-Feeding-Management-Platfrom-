// Fix 018: students' daily micronutrient needs (FAO/WHO 2004) and % met.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test018.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(18);
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
const headB = await newUser(db, 'headb@x.com', 'Head B');
const [{ create_my_school: schoolB }] = await q(headB, `select create_my_school('Upendo', 'Head B')`);

// Vitamin A in RE
const kale = (await q(null, `select vitamin_a_ug, vitamin_a_re_ug from food_nutrition where kfct_code = '04020' and school_id is null`))[0];
ok('kale: 177 µg RAE and 355 µg RE (KFCT)', num(kale?.vitamin_a_ug) === 177 && num(kale?.vitamin_a_re_ug) === 355);
ok('every KFCT food has an RE value', (await q(null, `select count(*)::int n from food_nutrition where school_id is null and kfct_code is not null and vitamin_a_re_ug is null`))[0].n === 0);

// Requirements table
const rni = async (nutrient, sex, age, variant = '') => num((await q(head,
  `select amount from nutrient_requirements where nutrient = $1 and (sex is null or sex = $2) and $3 between age_min and age_max and variant = $4`,
  [nutrient, sex, age, variant]))[0]?.amount);
ok('7-9 years: calcium 700, folate 300, vitamin A 500 RE', (await rni('calcium_mg', null, 8)) === 700 && (await rni('folate_ug', null, 8)) === 300 && (await rni('vitamin_a_re_ug', null, 8)) === 500);
ok('girls 13: iron at 5% = 65 mg (menstruating)', (await rni('iron_mg', 'female', 13, 'iron_5')) === 65);
ok('girls 11: iron at 5% = 28 mg', (await rni('iron_mg', 'female', 11, 'iron_5')) === 28);
ok('boys 12: zinc low bioavailability = 19.2 mg', (await rni('zinc_mg', 'male', 12, 'zinc_low')) === 19.2);
ok('requirements read-only', (await err(head, `insert into nutrient_requirements (nutrient, age_min, age_max, amount, unit) values ('x', 1, 2, 3, 'mg')`)) !== null);

// Sex on students
const add = `insert into beneficiaries (school_id, full_name, admission_no, age, sex) values ($1, $2, $3, $4, $5) returning beneficiary_id`;
const [{ beneficiary_id: amina }] = await q(head, add, [school, 'Amina', 'TUM-001', 13, 'female']);
const [{ beneficiary_id: otieno }] = await q(head, add, [school, 'Otieno', 'TUM-002', 8, null]);
const [{ beneficiary_id: juma }] = await q(head, add, [school, 'Juma', 'TUM-003', 12, null]);
const badSex = await err(head, add, [school, 'X', 'TUM-009', 9, 'boy']);
ok('sex must be female or male', badSex?.includes('23514'), badSex);

// Githeri: 150 g whole maize + 75 g beans, lunch today.
const maize = await foodId('Maize');
const beans = await foodId('Beans');
const [{ meal_id }] = await q(head, `insert into meals (school_id, name) values ($1, 'Githeri') returning meal_id`, [school]);
await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([{ food_id: maize, amount: 150 }, { food_id: beans, amount: 75 }])]);
const [{ d, dt }] = await q(null, `select extract(isodow from now() at time zone timezone)::int d, (now() at time zone timezone)::date::text dt from schools where school_id = $1`, [school]);
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '00:00', '23:59:59', $2)`, [d, meal_id]);
for (const b of [amina, otieno, juma]) {
  await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [b, dt]);
}

const rec = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [amina]))[0];
ok('meal record: iron 8.7, zinc 4.91 (rounded to 2), folate 310.5', num(rec?.iron_mg) === 8.7 && num(rec?.zinc_mg) === 4.91 && num(rec?.folate_ug) === 310.5);
ok('meal record: vitamin A 0.75 RE (beans 1 RE x 75 g)', num(rec?.vitamin_a_re_ug) === 0.75, rec?.vitamin_a_re_ug);
ok('meal record complete, all nutrients stored', rec?.complete === true && rec?.phytate_mg !== null && rec?.energy_kcal !== null);

const adequacy = async (uid, b) => Object.fromEntries((await q(uid,
  `select * from student_nutrient_adequacy($1, $2::date - 6, $2::date)`, [b, dt])).map((r) => [r.nutrient, r]));
const a = await adequacy(head, amina);
// phytate 1389.75 mg / 660 = 2.106 mmol; zinc 4.91 / 65.4 = 0.0751 mmol -> 28.0
ok('phytate:zinc ratio = 28', num(a.zinc_mg?.phytate_zinc) === 28, a.zinc_mg?.phytate_zinc);
ok('zinc judged at low bioavailability (15.5 mg for a girl)', a.zinc_mg?.variant === 'zinc_low' && num(a.zinc_mg?.requirement) === 15.5);
ok('zinc: 4.91 / 15.5 = 32%', num(a.zinc_mg?.percent) === 32, a.zinc_mg?.percent);
ok('iron judged at 5% bioavailability: 8.7 / 65 = 13%', a.iron_mg?.variant === 'iron_5' && num(a.iron_mg?.percent) === 13, a.iron_mg?.percent);
ok('folate: 310.5 / 400 = 78%', num(a.folate_ug?.percent) === 78, a.folate_ug?.percent);
ok('vitamin B12: 0%', num(a.vitamin_b12_ug?.percent) === 0);
ok('one day of meals', a.iron_mg?.days === 1);

const o = await adequacy(head, otieno);
ok('8-year-old without sex is still assessed (folate 310.5 / 300 = 104%)', num(o.folate_ug?.percent) === 104 && o.folate_ug?.missing === null, o.folate_ug?.percent);
const j = await adequacy(head, juma);
ok('12-year-old without sex is not assessed and asks for sex', j.iron_mg?.percent === null && j.iron_mg?.missing === 'sex');

ok("another school can't see a student's adequacy", (await q(headB, `select * from student_nutrient_adequacy($1, $2::date - 6, $2::date)`, [amina, dt])).every((r) => r.days === 0));

// School summary at a 30% target
const s = Object.fromEntries((await q(head, `select * from school_nutrient_adequacy($1, $2::date - 6, $2::date, 30)`, [school, dt])).map((r) => [r.nutrient, r]));
ok('school: 2 students assessed for iron, 1 not (missing sex)', s.iron_mg?.students === 2 && s.iron_mg?.not_assessed === 1, JSON.stringify(s.iron_mg));
// Amina (girl, 13) 8.7 / 65 = 13%; Otieno (8) 8.7 / 18 = 48%.
ok('school: 1 of 2 below 30% of iron need, median 31%', s.iron_mg?.below_target === 1 && num(s.iron_mg?.median_percent) === 31);
ok('school: nobody below 30% of folate', s.folate_ug?.below_target === 0);
ok('school: everyone below 30% of vitamin A and B12', s.vitamin_a_re_ug?.below_target === 2 && s.vitamin_b12_ug?.below_target === 2);

// Own values with the new key still work
const milk = await foodId('Milk');
await q(head, `select set_food_nutrition($1, $2, 'Packet')`, [milk, JSON.stringify({ vitamin_a_re_ug: 50, calcium_mg: 120 })]);
const mv = (await q(head, `select * from school_food_nutrition($1)`, [school])).find((v) => v.food_id === milk);
ok('school can set vitamin A RE; other values fall back to KFCT', num(mv.vitamin_a_re_ug) === 50 && num(mv.calcium_mg) === 120 && num(mv.vitamin_b12_ug) === 0.59);
ok('unknown nutrient still rejected', (await err(head, `select set_food_nutrition($1, $2, 'x')`, [milk, JSON.stringify({ iodine_ug: 5 })]))?.includes('22023'));

console.log(`\n${failed === 0 ? 'All passed' : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
