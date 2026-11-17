// Fix 017: KFCT 2018 micronutrients.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test017.mjs
import { freshDb, as, newUser, read } from './db.mjs';
const db = await freshDb(16);
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

// Before fix 017: the school uses its own values for milk.
const milk = await foodId('Milk');
await q(head, `select set_food_nutrition($1, $2, 'Packet')`, [milk, JSON.stringify({ energy_kcal: 99, calcium_mg: 111 })]);

// Run fix 017 (twice, to check it can be re-run).
await db.exec(read('fixes/017_micronutrients.sql'));
await db.exec(read('fixes/017_micronutrients.sql'));

const shared = async (name) => (await q(null,
  `select n.* from food_nutrition n join food_items f using (food_id) where n.school_id is null and f.school_id is null and lower(f.item_name) = lower($1)`, [name]))[0];

const maize = await shared('Maize');
ok('maize = KFCT 01018 whole white maize', maize?.kfct_code === '01018' && num(maize.iron_mg) === 2.6 && num(maize.zinc_mg) === 1.88 && num(maize.folate_ug) === 71 && num(maize.phytate_mg) === 615);
ok('maize has no vitamin A or B12 (unfortified)', num(maize.vitamin_a_ug) === 0 && num(maize.vitamin_b12_ug) === 0);
const flour = await shared('Maize flour');
ok('maize flour = KFCT 01022 whole maize flour', flour?.kfct_code === '01022' && num(flour.magnesium_mg) === 110);
const fort = await shared('Maize flour (fortified, packaged)');
ok('fortified flour added with folic acid counted (523 DFE)', fort?.kfct_code === '01020' && num(fort.folate_ug) === 523 && num(fort.zinc_mg) === 4.36);
for (const name of ['Maize (yellow)', 'Sweet potatoes (orange-fleshed)', 'Eggs', 'Omena (dried)']) {
  ok(`${name} added to the shared list`, !!(await foodId(name)) && !!(await shared(name)));
}
ok('orange sweet potato vitamin A 517', num((await shared('Sweet potatoes (orange-fleshed)')).vitamin_a_ug) === 517);
ok('beef uses lean beef 07002', (await shared('Beef'))?.kfct_code === '07002');
ok('kale phytate unknown (null), not 0', (await shared('Kale (sukuma wiki)')).phytate_mg === null);
ok('source cites KFCT and the food code', (await shared('Rice')).source.includes('Kenya Food Composition Tables 2018') && (await shared('Rice')).source.includes('01034'));
const dup = await q(null, `select lower(item_name) n, count(*)::int c from food_items where school_id is null group by 1 having count(*) > 1`);
ok('no duplicate shared foods after running twice', dup.length === 0);

// The school's own milk values were kept.
const values = await q(head, `select * from school_food_nutrition($1)`, [school]);
const myMilk = values.find((v) => v.food_id === milk);
ok("school's own milk values kept", num(myMilk?.energy_kcal) === 99 && num(myMilk?.calcium_mg) === 111 && myMilk?.is_school_value === true);
ok('own values fall back to KFCT for nutrients not set (B12)', num(myMilk?.vitamin_b12_ug) === 0.59);
ok("own values don't claim a KFCT code", myMilk?.kfct_code === null);
ok('school_food_nutrition returns the new nutrients', 'folate_ug' in values[0] && 'phytate_mg' in values[0] && 'kfct_code' in values[0]);

// Setting own values with the new nutrients.
await q(head, `select set_food_nutrition($1, $2, 'Lab test')`, [milk, JSON.stringify({ folate_ug: 10, vitamin_b12_ug: 0.4 })]);
const myMilk2 = (await q(head, `select * from school_food_nutrition($1)`, [school])).find((v) => v.food_id === milk);
ok('school can set folate and B12', num(myMilk2.folate_ug) === 10 && num(myMilk2.vitamin_b12_ug) === 0.4);
const bad = await err(head, `select set_food_nutrition($1, $2, 'x')`, [milk, JSON.stringify({ iodine_ug: 5 })]);
ok('unknown nutrient rejected', bad?.includes('22023'), bad);

// A student's meal record: githeri = 150 g maize + 75 g beans.
const beans = await foodId('Beans');
const mz = await foodId('Maize');
const [{ meal_id }] = await q(head, `insert into meals (school_id, name) values ($1, 'Githeri') returning meal_id`, [school]);
await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([{ food_id: mz, amount: 150 }, { food_id: beans, amount: 75 }])]);
const [{ d, dt }] = await q(null, `select extract(isodow from now() at time zone timezone)::int d, (now() at time zone timezone)::date::text dt from schools where school_id = $1`, [school]);
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '00:00', '23:59:59', $2)`, [d, meal_id]);
const [{ beneficiary_id }] = await q(null, `insert into beneficiaries (school_id, full_name, admission_no, age) values ($1, 'Amina', 'TUM-001', 10) returning beneficiary_id`, [school]);
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [beneficiary_id, dt]);
const rec = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [beneficiary_id]))[0];
ok('iron = 150 g x 2.6 + 75 g x 6.4 = 8.7 mg', num(rec?.iron_mg) === 8.7, rec?.iron_mg);
ok('zinc = 2.82 + 2.085 = 4.91 mg', num(rec?.zinc_mg) === 4.91, rec?.zinc_mg);
ok('folate = 106.5 + 204 = 310.5 µg DFE', num(rec?.folate_ug) === 310.5, rec?.folate_ug);
ok('phytate = 922.5 + 467.25 = 1390 mg', num(rec?.phytate_mg) === 1390, rec?.phytate_mg);
ok('whole-maize githeri: vitamin A 0.8 µg (beans only), B12 0', num(rec?.vitamin_a_ug) === 0.8 && num(rec?.vitamin_b12_ug) === 0, `${rec?.vitamin_a_ug} / ${rec?.vitamin_b12_ug}`);
ok('record is complete', rec?.complete === true);
ok('snapshot keeps the KFCT code of each food', rec?.ingredients.some((i) => i.kfct_code === '01018'));

// Kale has no phytate value, but the record is still complete.
const kale = await foodId('Kale (sukuma wiki)');
await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([{ food_id: mz, amount: 150 }, { food_id: kale, amount: 50 }])]);
const [{ beneficiary_id: baraka }] = await q(null, `insert into beneficiaries (school_id, full_name, admission_no, age) values ($1, 'Baraka', 'TUM-002', 11) returning beneficiary_id`, [school]);
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [baraka, dt]);
const rec2 = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [baraka]))[0];
ok('missing kale phytate does not make the record incomplete', rec2?.complete === true);
ok('kale adds vitamin A: 50 g x 177 = 88.5 µg RAE', num(rec2?.vitamin_a_ug) === 88.5, rec2?.vitamin_a_ug);

console.log(`\n${failed === 0 ? 'All passed' : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
