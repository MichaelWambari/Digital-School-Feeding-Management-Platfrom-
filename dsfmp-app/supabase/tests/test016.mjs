// Fix 016: issue sheets and automatic stock deduction when a meal closes.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test016.mjs
import { freshDb, as, newUser } from './db.mjs';
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

// School A: headteacher, coordinator, 3 active students and 1 inactive.
const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Tumaini', 'Head A')`);
const coord = await newUser(db, 'coord@x.com', 'Coord A');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord]);
const headB = await newUser(db, 'headb@x.com', 'Head B');
const [{ create_my_school: schoolB }] = await q(headB, `select create_my_school('Upendo', 'Head B')`);

const students = [];
for (const [i, status] of ['active', 'active', 'active', 'inactive'].entries()) {
  const [{ beneficiary_id }] = await q(null,
    `insert into beneficiaries (school_id, full_name, admission_no, age, status) values ($1, $2, $3, 10, $4) returning beneficiary_id`,
    [school, `Student ${i}`, `TUM-00${i}`, status]);
  students.push(beneficiary_id);
}

// Foods and stock: 5 kg maize, 0.3 kg beans, 2 litres milk.
const food = async (name, unit) => (await q(null,
  `insert into food_items (item_name, unit) values ($1, $2) returning food_id`, [name, unit]))[0].food_id;
const maize = await food('Test maize', 'kg');
const beans = await food('Test beans', 'kg');
const milk = await food('Test milk', 'litres');
const stockUp = async (f, qty) => {
  const [{ item_id }] = await q(null, `insert into inventory_items (school_id, food_id) values ($1, $2) returning item_id`, [school, f]);
  await q(null, `insert into inventory_transactions (item_id, transaction_type, quantity) values ($1, 'received', $2)`, [item_id, qty]);
};
await stockUp(maize, 5);
await stockUp(beans, 0.3);
await stockUp(milk, 2);
const stock = async (f) => num((await q(null,
  `select quantity_available from inventory_items where school_id = $1 and food_id = $2`, [school, f]))[0]?.quantity_available);

// Dishes: Ugali (maize 200 g), Githeri (beans 200 g), Tea (milk 250 ml).
const dish = async (name, items) => {
  const [{ meal_id }] = await q(head, `insert into meals (school_id, name) values ($1, $2) returning meal_id`, [school, name]);
  await q(head, `select set_meal_ingredients($1, $2)`, [meal_id, JSON.stringify(items)]);
  return meal_id;
};
const ugali = await dish('Ugali', [{ food_id: maize, amount: 200 }]);
const githeri = await dish('Githeri', [{ food_id: beans, amount: 200 }]);
const tea = await dish('Tea', [{ food_id: milk, amount: 250 }]);

// Local dates: yesterday (Y) and the day before (Y2).
const [{ y, yd, y2, y2d }] = await q(null, `
  select ((now() at time zone timezone)::date - 1)::text y, extract(isodow from (now() at time zone timezone)::date - 1)::int yd,
         ((now() at time zone timezone)::date - 2)::text y2, extract(isodow from (now() at time zone timezone)::date - 2)::int y2d
  from schools where school_id = $1`, [school]);
await q(null, `delete from meal_schedules where school_id in ($1, $2)`, [school, schoolB]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'breakfast', '07:00', '08:00', $2)`, [yd, tea]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '12:00', '14:00', $2)`, [yd, ugali]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'supper', '18:00', '19:00', $2)`, [yd, githeri]);
await q(head, `select set_meal_schedule(array[$1]::int[], 'lunch', '12:00', '14:00', $2)`, [y2d, ugali]);
// Automatic closing started three days ago for school A (the fix sets it to "now").
await q(null, `update schools set meal_close_since = now() - interval '3 days' where school_id = $1`, [school]);

const attend = async (i, meal, day) => q(null,
  `insert into meal_attendance (beneficiary_id, meal_type, attendance_date, status) values ($1, $2, $3, 'present')`,
  [students[i], meal, day]);
await attend(0, 'lunch', y);
await attend(1, 'lunch', y);
for (const i of [0, 1, 2]) await attend(i, 'supper', y);

// ---------- Issue sheet ----------
let sheet = await q(coord, `select * from meal_issue_sheet($1, $2, 'lunch')`, [school, y]);
ok('sheet lists the dish food', sheet.length === 1 && sheet[0].food_id === maize && sheet[0].meal_name === 'Ugali');
ok('planned = 3 active students x 200 g = 0.6 kg', num(sheet[0].planned_quantity) === 0.6, sheet[0].planned_quantity);
ok('issued defaults to planned, not saved', num(sheet[0].issued_quantity) === 0.6 && sheet[0].saved === false);
ok('sheet shows stock in hand', num(sheet[0].in_stock) === 5);

await q(coord, `select set_meal_issue($1, $2, 'lunch', $3)`, [school, y, JSON.stringify([{ food_id: maize, quantity: 0.8 }])]);
sheet = await q(coord, `select * from meal_issue_sheet($1, $2, 'lunch')`, [school, y]);
ok('coordinator saves 0.8 kg issued', num(sheet[0].issued_quantity) === 0.8 && sheet[0].saved === true);
const notInDish = await err(coord, `select set_meal_issue($1, $2, 'lunch', $3)`, [school, y, JSON.stringify([{ food_id: beans, quantity: 1 }])]);
ok('a food not in the dish is rejected', notInDish?.includes('22023'), notInDish);
const negative = await err(coord, `select set_meal_issue($1, $2, 'lunch', $3)`, [school, y, JSON.stringify([{ food_id: maize, quantity: -1 }])]);
ok('a negative amount is rejected', negative?.includes('22023'), negative);
const otherHead = await err(headB, `select set_meal_issue($1, $2, 'lunch', $3)`, [school, y, JSON.stringify([{ food_id: maize, quantity: 1 }])]);
ok("another school's headteacher can't change the sheet", otherHead?.includes('42501'), otherHead);
const direct = await err(coord, `insert into meal_issues (school_id, issue_date, meal_type, food_id, issued_quantity) values ($1, $2, 'lunch', $3, 9)`, [school, y, maize]);
ok('meal_issues cannot be written directly', direct !== null, direct);
ok("another school can't read the sheet rows", (await q(headB, `select * from meal_issues where school_id = $1`, [school])).length === 0);

// Manual entry for the day before, before anything closes.
const [{ item_id: maizeItem }] = await q(null, `select item_id from inventory_items where school_id = $1 and food_id = $2`, [school, maize]);
await q(coord, `insert into food_consumption (item_id, meal_type, consumption_date, quantity, recorded_by) values ($1, 'lunch', $2, 1, $3)`, [maizeItem, y2, coord]);
ok('manual entry still deducts (5 - 1 = 4 kg)', (await stock(maize)) === 4);

// ---------- Access to close_due_meals / close_meal ----------
const allByUser = await err(coord, `select close_due_meals()`);
ok('a user cannot close every school', allByUser?.includes('42501'), allByUser);
const otherSchool = await err(headB, `select close_due_meals($1)`, [school]);
ok("a user cannot close another school's meals", otherSchool?.includes('42501'), otherSchool);
const closeMeal = await err(coord, `select close_meal($1, $2, 'lunch')`, [school, y]);
ok('close_meal is not callable from the app', closeMeal !== null, closeMeal);

// ---------- Closing ----------
const [{ close_due_meals: closed }] = await q(coord, `select close_due_meals($1)`, [school]);
ok('four meals closed (Y breakfast, lunch, supper; Y2 lunch)', closed === 4, closed);
const closures = Object.fromEntries((await q(coord,
  `select closure_date::text || ' ' || meal_type k, status, students from meal_closures where school_id = $1`, [school]))
  .map((r) => [r.k, r]));
ok('breakfast with no one and no sheet: not_served', closures[`${y} breakfast`]?.status === 'not_served');
ok('lunch: closed with 2 students', closures[`${y} lunch`]?.status === 'closed' && closures[`${y} lunch`]?.students === 2);
ok('supper: closed with 3 students', closures[`${y} supper`]?.status === 'closed');
ok('day-before lunch entered by hand: manual', closures[`${y2} lunch`]?.status === 'manual');
ok('milk untouched by the unserved breakfast', (await stock(milk)) === 2);
ok('lunch took the issued 0.8 kg (4 - 0.8 = 3.2)', (await stock(maize)) === 3.2, await stock(maize));

const lunch = (await q(coord, `select * from food_consumption where school_id = $1 and consumption_date = $2 and meal_type = 'lunch' and source = 'meal_close'`, [school, y]))[0];
ok('lunch row: issued 0.8, served 0.4, unserved 0.4',
  num(lunch?.issued_quantity) === 0.8 && num(lunch?.served_quantity) === 0.4 && num(lunch?.unserved_quantity) === 0.4 && num(lunch?.quantity) === 0.8);
ok('closed automatically from the app records who opened it', lunch?.recorded_by === coord);
const used = await q(null, `select count(*)::int n from inventory_transactions where consumption_id = $1 and transaction_type = 'used'`, [lunch.consumption_id]);
ok('a stock movement links to the food used', used[0].n === 1);

const supper = (await q(coord, `select * from food_consumption where school_id = $1 and consumption_date = $2 and meal_type = 'supper'`, [school, y]))[0];
ok('supper short of beans: issued 0.6, only 0.3 taken from stock',
  num(supper?.issued_quantity) === 0.6 && num(supper?.quantity) === 0.3, `${supper?.issued_quantity} / ${supper?.quantity}`);
ok('beans stock is now 0', (await stock(beans)) === 0);

sheet = await q(coord, `select * from meal_issue_sheet($1, $2, 'lunch')`, [school, y]);
ok('closed sheet shows served and unserved', sheet[0].closure_status === 'closed' && num(sheet[0].served_quantity) === 0.4 && num(sheet[0].unserved_quantity) === 0.4 && sheet[0].students === 2);

// ---------- Idempotence and locks ----------
const [{ close_due_meals: again }] = await q(coord, `select close_due_meals($1)`, [school]);
const [{ close_due_meals: cron }] = await q(null, `select close_due_meals()`);
ok('running again closes nothing (app and cron)', again === 0 && cron === 0, `${again}/${cron}`);
ok('stock unchanged after re-runs', (await stock(maize)) === 3.2);
const late = await err(coord, `select set_meal_issue($1, $2, 'lunch', $3)`, [school, y, JSON.stringify([{ food_id: maize, quantity: 1 }])]);
ok('issue sheet locked after closing', late?.includes('23514'), late);
const manualAfter = await err(coord, `insert into food_consumption (item_id, meal_type, consumption_date, quantity) values ($1, 'lunch', $2, 1)`, [maizeItem, y]);
ok('food entered by hand for a closed meal is rejected', manualAfter?.includes('23514'), manualAfter);
const direct2 = await err(coord, `insert into meal_closures (school_id, closure_date, meal_type, status) values ($1, now()::date, 'lunch', 'closed')`, [school]);
ok('meal_closures cannot be written directly', direct2 !== null, direct2);

// ---------- Meals before automation started are left alone ----------
await q(null, `insert into meal_schedules (school_id, weekday, meal_type, start_time, end_time) values ($1, $2, 'lunch', '12:00', '14:00')`, [schoolB, yd]);
const [{ close_due_meals: closedB }] = await q(headB, `select close_due_meals($1)`, [schoolB]);
ok('a new school does not close meals from before it started', closedB === 0, closedB);

// ---------- Cron closes every school ----------
await q(null, `update schools set meal_close_since = now() - interval '3 days' where school_id = $1`, [schoolB]);
const [{ close_due_meals: cronB }] = await q(null, `select close_due_meals()`);
ok('cron closes the other school (no dish: no_recipe)', cronB === 1 &&
  (await q(null, `select status from meal_closures where school_id = $1`, [schoolB]))[0]?.status === 'no_recipe');

console.log(`\n${failed === 0 ? 'All passed' : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
