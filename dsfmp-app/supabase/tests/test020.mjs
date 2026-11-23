// Fix 020: cooking retention factors (KFCT 2018 Tables VI/VII) and dates of birth.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test020.mjs
import { freshDb, as, newUser, read } from './db.mjs';
const db = await freshDb(19); // fix 020 is run below, after a record exists
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

// Githeri: 150 g whole maize + 75 g beans, at lunch today.
const maize = await foodId('Maize');
const beans = await foodId('Beans');
const [{ meal_id }] = await q(head, `insert into meals (school_id, name) values ($1, 'Githeri') returning meal_id`, [school]);
await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([{ food_id: maize, amount: 150 }, { food_id: beans, amount: 75 }])]);
const [{ d, dt }] = await q(null, `select extract(isodow from now() at time zone timezone)::int d, (now() at time zone timezone)::date::text dt from schools where school_id = $1`, [school]);
await q(null, `delete from meal_schedules where school_id = $1`, [school]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '00:00', '23:59:59', $2)`, [d, meal_id]);
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [amina, dt]);
const before = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [amina]))[0];
ok('before fix 020: raw folate 310.5, phytate 1389.75', num(before?.folate_ug) === 310.5 && num(before?.phytate_mg) === 1389.75);

await db.exec(read('fixes/020_cooking_and_birth_dates.sql'));
await db.exec(read('fixes/020_cooking_and_birth_dates.sql'));
ok('fix 020 runs twice without error', true);

// Factors
const f = async (method) => (await q(head, `select * from retention_factors where method = $1`, [method]))[0];
const gs = await f('grain_stewed');
ok('grain, stewed: thiamin 0.75, folate 0.80, phytate 0.51 (KFCT VI/VII)', num(gs.thiamin_mg) === 0.75 && num(gs.folate_ug) === 0.8 && num(gs.phytate_mg) === 0.51);
const pb = await f('pulse_unsoaked_boiled');
ok('pulses boiled and drained: iron 0.85, zinc 0.90, phytate 0.81', num(pb.iron_mg) === 0.85 && num(pb.zinc_mg) === 0.9 && num(pb.phytate_mg) === 0.81);
const lb = await f('leafy_boiled');
ok('leafy vegetables boiled: vitamin C 0.40', num(lb.vitamin_c_mg) === 0.4);
ok('factors are read-only', (await err(head, `update retention_factors set iron_mg = 0.1`))?.includes('42501'));
const none = (await q(head, `select cooking_retention('none') r`))[0].r;
ok('not cooked: everything kept', Object.values(none).every((v) => Number(v) === 1) && Object.keys(none).length === 18);
const ret = (await q(head, `select cooking_retention('beef_stewed') r`))[0].r;
ok('beef stewed: vitamin A 0.75 for RAE and RE, energy unchanged', ret.vitamin_a_ug === 0.75 && ret.vitamin_a_re_ug === 0.75 && ret.energy_kcal === 1);

// Usual cooking
const dc = async (name) => (await q(head, `select default_cooking from food_items where school_id is null and item_name = $1`, [name]))[0]?.default_cooking;
ok('usual cooking: maize stewed, beans stewed, kale fried, rice boiled',
  (await dc('Maize')) === 'grain_stewed' && (await dc('Beans')) === 'pulse_unsoaked_stewed'
  && (await dc('Kale (sukuma wiki)')) === 'leafy_sauteed' && (await dc('Rice')) === 'grain_polished_boiled');
ok('every shared KFCT food has a usual cooking method', (await q(null,
  `select count(*)::int n from food_items f join food_nutrition n on n.food_id = f.food_id and n.school_id is null
   where f.school_id is null and n.kfct_code is not null and f.default_cooking is null`))[0].n === 0);

// The earlier record was worked out again.
const rec = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [amina]))[0];
// maize 150 g x 0.80, beans 75 g x 0.60: 71*1.5*0.8 + 272*0.75*0.6 = 85.2 + 122.4
ok('earlier record recalculated: folate 207.6 (was 310.5)', num(rec?.folate_ug) === 207.6, rec?.folate_ug);
// 615*1.5*0.51 + 623*0.75*0.81 = 470.475 + 378.4725
ok('phytate 848.95 (was 1389.75)', num(rec?.phytate_mg) === 848.95, rec?.phytate_mg);
ok('iron and zinc unchanged by stewing: 8.7 and 4.91', num(rec?.iron_mg) === 8.7 && num(rec?.zinc_mg) === 4.91);
ok('thiamin 0.49 (0.375 x 0.75 + 0.2625 x 0.80)', num(rec?.thiamin_mg) === 0.49, rec?.thiamin_mg);
ok('energy unchanged', num(rec?.energy_kcal) === num(before?.energy_kcal));
ok('record marked cooked, with each food\'s method', rec?.cooked === true
  && rec.ingredients.every((i) => i.cooking && i.retention), JSON.stringify(rec?.ingredients?.map((i) => i.cooking)));

const a = Object.fromEntries((await q(head, `select * from student_nutrient_adequacy($1, $2::date - 6, $2::date)`, [amina, dt])).map((r) => [r.nutrient, r]));
// (848.95/660) / (4.91/65.4) = 17.13
ok('phytate:zinc after cooking = 17.1 (raw was 28)', num(a.zinc_mg?.phytate_zinc) === 17.1, a.zinc_mg?.phytate_zinc);

// A dish can cook a food another way.
const badCook = await err(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([{ food_id: maize, amount: 150, cooking: 'microwaved' }])]);
ok('unknown cooking method refused', badCook?.includes('22023'), badCook);
await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify([
  { food_id: maize, amount: 150, cooking: 'grain_whole_boiled' }, { food_id: beans, amount: 75, cooking: 'pulse_unsoaked_boiled' }])]);
ok('dish stores the cooking method', (await q(head, `select cooking_method from meal_ingredients where meal_id = $1 and food_id = $2`, [meal_id, maize]))[0]?.cooking_method === 'grain_whole_boiled');
await q(null, `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, 'lunch', $2, 'present')`, [otieno, dt]);
const r2 = (await q(head, `select * from attendance_nutrition where beneficiary_id = $1`, [otieno]))[0];
// zinc 2.82*0.95 + 2.085*0.90 = 2.679 + 1.8765; iron 3.9*1 + 4.8*0.85
ok('new record uses the dish\'s methods: zinc 4.56, iron 7.98', num(r2?.zinc_mg) === 4.56 && num(r2?.iron_mg) === 7.98, `${r2?.zinc_mg} ${r2?.iron_mg}`);
ok('new record cooked = true', r2?.cooked === true);

// Dates of birth
const [{ dob10 }] = await q(null, `select ((now() at time zone 'Africa/Nairobi')::date - interval '10 years' + interval '1 day')::date::text dob10`);
const [{ beneficiary_id: juma }] = await q(head,
  `insert into beneficiaries (school_id, full_name, admission_no, date_of_birth) values ($1, 'Juma', 'TUM-003', $2) returning beneficiary_id`, [school, dob10]);
const juma1 = (await q(head, `select age from beneficiaries where beneficiary_id = $1`, [juma]))[0];
ok('age worked out from the date of birth (turns 10 tomorrow: 9)', juma1?.age === 9, juma1?.age);
await q(head, `update beneficiaries set age = 15 where beneficiary_id = $1`, [juma]);
ok('a typed age can\'t contradict the date of birth', (await q(head, `select age from beneficiaries where beneficiary_id = $1`, [juma]))[0]?.age === 9);
const future = await err(head, `update beneficiaries set date_of_birth = current_date + 3 where beneficiary_id = $1`, [juma]);
ok('date of birth in the future refused', future?.includes('22023'), future);
const old = await err(head, `update beneficiaries set date_of_birth = '1980-01-01' where beneficiary_id = $1`, [juma]);
ok('implausible date of birth refused', old?.includes('22023'), old);
// At today's date Juma is 9 (no sex needed); a week from now he is 10 and needs one.
const j0 = await q(head, `select * from student_nutrient_adequacy($1, $2::date - 6, $2::date)`, [juma, dt]);
const j1 = await q(head, `select * from student_nutrient_adequacy($1, $2::date, $2::date + 7)`, [juma, dt]);
ok('needs use the age at the end of the period', j0.every((r) => r.missing === null) && j1.every((r) => r.missing === 'sex'));
await q(head, `update beneficiaries set date_of_birth = null, age = 12 where beneficiary_id = $1`, [juma]);
ok('without a date of birth the typed age is kept', (await q(head, `select age from beneficiaries where beneficiary_id = $1`, [juma]))[0]?.age === 12);

console.log(failed ? `${failed} FAILED` : 'All passed');
process.exit(failed ? 1 : 0);
