// Accuracy check: does the app's way of working out a dish match KFCT's own
// cooked githeri (15053, "Githeri (stewed Maize & Beans)")?
//
// KFCT's recipe weights for 15053 are in the separate recipe book, which
// isn't in the KFCT PDF. So the amounts of maize, beans and oil per 100 g
// of cooked githeri are fitted to the dish's energy, protein, fat,
// carbohydrate and fibre (least squares). Cooking factors don't change
// these, so the fit is independent of what is tested: the
// micronutrients, worked out from the fitted amounts with the app's raw
// food values, once raw and once with fix 020's cooking factors.
//
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/githeri_check.mjs
import fs from 'node:fs';
import { freshDb } from './db.mjs';

const db = await freshDb(20);
const rows = (await db.query(`
  select n.*, f.default_cooking, public.cooking_retention(f.default_cooking) as retention
  from food_items f join food_nutrition n on n.food_id = f.food_id and n.school_id is null
  where f.school_id is null and n.kfct_code in ('01018', '03004', '09013')`)).rows;
const by = Object.fromEntries(rows.map((r) => [r.kfct_code, r]));
const foods = [by['01018'], by['03004'], by['09013']]; // whole maize, kidney beans, sunflower oil (per 100 ml)
const names = ['Whole maize (01018), g', 'Kidney beans (03004), g', 'Sunflower oil (09013), ml'];

// KFCT 2018, food 15053, per 100 g edible portion (pages 156, 169, 170, 189).
const kfct = {
  energy_kcal: 157, protein_g: 6.7, fat_g: 4.2, carbohydrate_g: 19.7, fibre_g: 7.2,
  calcium_mg: 39, iron_mg: 2.2, magnesium_mg: 41, zinc_mg: 1.01,
  thiamin_mg: 0.10, riboflavin_mg: 0.06, niacin_mg: 0.8, folate_ug: 52, phytate_mg: 178,
};
const fitKeys = ['energy_kcal', 'protein_g', 'fat_g', 'carbohydrate_g', 'fibre_g'];
const testKeys = ['calcium_mg', 'iron_mg', 'magnesium_mg', 'zinc_mg', 'thiamin_mg', 'riboflavin_mg',
  'niacin_mg', 'folate_ug', 'phytate_mg'];

// Weighted least squares (each equation divided by its target) via the normal equations.
const A = fitKeys.map((k) => foods.map((f) => Number(f[k] ?? 0) / 100 / kfct[k]));
const y = fitKeys.map(() => 1);
const AtA = [0, 1, 2].map((i) => [0, 1, 2].map((j) => A.reduce((s, r) => s + r[i] * r[j], 0)));
const Aty = [0, 1, 2].map((i) => A.reduce((s, r, n) => s + r[i] * y[n], 0));
const solve = (M, v) => {
  const m = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < 3; c++) {
    const p = m.slice(c).reduce((best, r, i) => (Math.abs(r[c]) > Math.abs(m[best][c]) ? i + c : best), c);
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) if (r !== c) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((r, i) => r[3] / r[i]);
};
const x = solve(AtA, Aty);

const calc = (k, cooked) => foods.reduce((s, f, i) =>
  s + Number(f[k] ?? 0) / 100 * x[i] * (cooked ? Number(f.retention[k] ?? 1) : 1), 0);
const pct = (v, t) => `${v >= t ? '+' : ''}${Math.round((100 * (v - t)) / t)}%`;
const pad = (s, n) => String(s).padEnd(n);

const out = [];
out.push('Githeri check: the app\'s calculation vs KFCT 2018 food 15053 (per 100 g cooked githeri)');
out.push('');
out.push('Fitted raw amounts per 100 g of cooked githeri:');
foods.forEach((f, i) => out.push(`  ${pad(names[i], 28)} ${x[i].toFixed(1)}   (cooking: ${f.default_cooking})`));
out.push(`  Raw food in 100 g cooked: ${(x[0] + x[1]).toFixed(1)} g dry maize and beans (the rest is water)`);
out.push('');
out.push('Fit (these set the amounts, so they only show how well 3 foods explain the dish):');
out.push(`  ${pad('Nutrient', 16)} ${pad('KFCT', 8)} ${pad('App', 8)} Diff`);
for (const k of fitKeys) out.push(`  ${pad(k, 16)} ${pad(kfct[k], 8)} ${pad(calc(k, true).toFixed(2), 8)} ${pct(calc(k, true), kfct[k])}`);
out.push('');
out.push('Test (not used in the fit):');
out.push(`  ${pad('Nutrient', 16)} ${pad('KFCT', 8)} ${pad('Raw', 8)} ${pad('Diff', 7)} ${pad('Cooked', 8)} Diff`);
let rawErr = 0, cookErr = 0;
for (const k of testKeys) {
  const r = calc(k, false), c = calc(k, true);
  rawErr += Math.abs(r - kfct[k]) / kfct[k];
  cookErr += Math.abs(c - kfct[k]) / kfct[k];
  out.push(`  ${pad(k, 16)} ${pad(kfct[k], 8)} ${pad(r.toFixed(2), 8)} ${pad(pct(r, kfct[k]), 7)} ${pad(c.toFixed(2), 8)} ${pct(c, kfct[k])}`);
}
out.push('');
out.push(`Mean absolute difference over the ${testKeys.length} test nutrients: raw ${Math.round(100 * rawErr / testKeys.length)}%, ` +
  `with cooking factors ${Math.round(100 * cookErr / testKeys.length)}%`);
const ratio = (cooked) => (calc('phytate_mg', cooked) / 660) / (calc('zinc_mg', cooked) / 65.4);
out.push(`Phytate:zinc molar ratio: KFCT ${((kfct.phytate_mg / 660) / (kfct.zinc_mg / 65.4)).toFixed(1)}, ` +
  `raw ${ratio(false).toFixed(1)}, with cooking factors ${ratio(true).toFixed(1)}`);
out.push('');
out.push('Limits: KFCT\'s recipe also has small amounts of onion, tomato and salt (vitamin C 0.5 mg,');
out.push('sodium 233 mg per 100 g), which are left out here, and KFCT counts the minerals in the tap');
out.push('water used to cook cereals and pulses (KFCT 2018, section 7), which likely explains most of the');
out.push('calcium gap. The amounts are fitted, not the recipe book\'s.');

const text = out.join('\n');
console.log(text);
fs.writeFileSync(new URL('./githeri_check_results.txt', import.meta.url), text + '\n');
