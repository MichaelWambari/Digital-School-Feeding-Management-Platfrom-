// Fix 028: energy needs exactly as printed in FAO/WHO/UNU (2004) Tables 4.5 and 4.6.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test028.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(28);
let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ' -- ' + detail : ''}`); };
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const need = async (n, sex, age) => Number((await q(`select amount from nutrient_requirements where nutrient = $1 and sex is not distinct from $2 and $3 between age_min and age_max`, [n, sex, age]))[0]?.amount);

// Moderate physical activity, kcal/d, as printed (fao.org/4/y5686e/y5686e06.htm).
const boys = [1350, 1475, 1575, 1700, 1825, 1975, 2150, 2350, 2550, 2775, 3000, 3175, 3325, 3400];
const girls = [1250, 1325, 1425, 1550, 1700, 1850, 2000, 2150, 2275, 2375, 2450, 2500, 2500, 2500];
let mism = [];
for (let i = 0; i < 14; i++) {
  if ((await need('energy_kcal', 'male', 4 + i)) !== boys[i]) mism.push(`boy ${4 + i}`);
  if ((await need('energy_kcal', 'female', 4 + i)) !== girls[i]) mism.push(`girl ${4 + i}`);
}
ok('all 28 boys/girls energy needs equal the printed Tables 4.5 and 4.6', mism.length === 0, mism.join(', '));
ok('age 18 uses the 17-18 row', (await need('energy_kcal', 'male', 18)) === 3400 && (await need('energy_kcal', 'female', 18)) === 2500);
ok('under 10 with no sex: average of boys and girls', (await need('energy_kcal', null, 4)) === 1300 && (await need('energy_kcal', null, 9)) === 1912.5);
ok('fat need recalculated as 30% of energy (12-year-old boy: 2550 kcal -> 85 g)', (await need('fat_g', 'male', 12)) === 85);
const counts = await q(`select nutrient, count(*)::int c from nutrient_requirements where nutrient in ('energy_kcal','fat_g') group by 1 order by 1`);
ok('34 energy rows and 34 fat rows, no leftovers from fix 021', counts.length === 2 && counts.every((c) => c.c === 34), JSON.stringify(counts));

// The student report picks the new value.
const head = await newUser(db, 'h@x.com', 'Head');
const [{ create_my_school: school }] = await as(db, head, async () => (await db.query(`select create_my_school('S', 'Head')`)).rows);
const [{ beneficiary_id: b }] = await as(db, head, async () => (await db.query(`insert into beneficiaries (school_id, full_name, admission_no, age, sex) values ($1, 'Brian', 'A1', 12, 'male') returning beneficiary_id`, [school])).rows);
const rows = await as(db, head, async () => (await db.query(`select nutrient, requirement from student_nutrient_adequacy($1, current_date - 7, current_date)`, [b])).rows);
const energy = rows.find((r) => r.nutrient === 'energy_kcal');
ok("student_nutrient_adequacy uses 2550 kcal for a 12-year-old boy", energy && Number(energy.requirement) === 2550, JSON.stringify(energy));

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
