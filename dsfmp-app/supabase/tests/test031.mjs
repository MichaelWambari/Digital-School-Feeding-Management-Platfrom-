// Fix 031: correcting a mistaken stock entry.
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/test031.mjs
import { freshDb, as, newUser } from './db.mjs';
const db = await freshDb(31);
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

const head = await newUser(db, 'head@x.com', 'Head A');
const [{ create_my_school: school }] = await q(head, `select create_my_school('Jasiri', 'Head A')`);
const coord = await newUser(db, 'coord@x.com', 'Coord A');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord]);
const coord2 = await newUser(db, 'coord2@x.com', 'Coord B');
await q(null, `update users set role = 'coordinator', school_id = $1 where user_id = $2`, [school, coord2]);
const headB = await newUser(db, 'headb@x.com', 'Head B');
await q(headB, `select create_my_school('Upendo', 'Head B')`);

const [{ food_id: maize }] = await q(null, `insert into food_items (item_name, unit) values ('Test maize', 'kg') returning food_id`);
const stock = async () => num((await q(null, `select quantity_available from inventory_items where school_id = $1 and food_id = $2`, [school, maize]))[0].quantity_available);
const correct = (uid, id, qty, reason = 'Typo') => q(uid, `select correct_stock_entry($1, $2, $3)`, [id, qty, reason]);
const correctErr = (uid, id, qty, reason = 'Typo') => err(uid, `select correct_stock_entry($1, $2, $3)`, [id, qty, reason]);

// The coordinator records 100 kg received (meant 10), then uses 4 kg at lunch.
const [{ record_stock_received: received }] = await q(coord, `select record_stock_received($1, 100, 'Mama Mboga', null)`, [maize]);
ok('received 100 kg', (await stock()) === 100);
const [{ item_id: item }] = await q(null, `select item_id from inventory_items where school_id = $1 and food_id = $2`, [school, maize]);
await q(coord, `insert into food_consumption (item_id, meal_type, consumption_date, quantity, recorded_by) values ($1, 'lunch', current_date, 4, $2)`, [item, coord]);
const [{ transaction_id: usedTx, consumption_id: usedC }] = await q(null, `select transaction_id, consumption_id from inventory_transactions where transaction_type = 'used'`);
ok('used 4 kg -> 96 in stock', (await stock()) === 96);

// ---------- who may correct ----------
let e = await correctErr(coord2, received, 10);
ok('another coordinator cannot correct it', e?.includes('42501'), e);
e = await correctErr(headB, received, 10);
ok("another school's headteacher cannot correct it", e?.includes('42501'), e);
e = await correctErr(coord, received, 10, '  ');
ok('a reason is required', e?.includes('22023'), e);
e = await correctErr(coord, received, -1);
ok('a negative amount is refused', e?.includes('22023'), e);
e = await correctErr(coord, received, 100);
ok('an unchanged amount is refused', e?.includes('22023'), e);

// ---------- correcting a delivery ----------
await correct(coord, received, 10, 'Typed 100 instead of 10');
ok('the recorder corrects 100 -> 10: stock 6', (await stock()) === 6);
ok('the delivery now says 10', num((await q(null, `select quantity from inventory_transactions where transaction_id = $1`, [received]))[0].quantity) === 10);
const [log] = await q(coord, `select old_quantity, new_quantity, reason, corrected_by from stock_corrections where transaction_id = $1`, [received]);
ok('the correction is kept with old/new/reason/who', num(log?.old_quantity) === 100 && num(log.new_quantity) === 10 && log.corrected_by === coord, JSON.stringify(log));
e = await correctErr(coord, received, 2);
ok("can't reduce a delivery below what's already used (stock would go negative)", e?.includes('23514'), e);

// ---------- correcting food used ----------
await correct(coord, usedTx, 3, 'Only 3 kg were cooked');
ok('used 4 -> 3: one kg back in stock (7)', (await stock()) === 7);
ok('the food-used record says 3 too', num((await q(null, `select quantity from food_consumption where consumption_id = $1`, [usedC]))[0].quantity) === 3);
e = await correctErr(coord, usedTx, 50);
ok("can't raise food used beyond the stock", e?.includes('23514'), e);

// ---------- the 24-hour window and the headteacher ----------
await q(null, `update inventory_transactions set created_at = now() - interval '2 days' where transaction_id = $1`, [usedTx]);
e = await correctErr(coord, usedTx, 2);
ok('after 24 hours the recorder cannot correct it', e?.includes('42501'), e);
await correct(head, usedTx, 0, 'Meal was not cooked');
ok('the headteacher can, and 0 removes the entry: stock 10', (await stock()) === 10);
ok('the movement and the food-used record are gone',
  (await q(null, `select count(*)::int c from inventory_transactions where transaction_id = $1`, [usedTx]))[0].c === 0 &&
  (await q(null, `select count(*)::int c from food_consumption where consumption_id = $1`, [usedC]))[0].c === 0);
ok('both corrections are in the log', (await q(null, `select count(*)::int c from stock_corrections`))[0].c === 3);

// ---------- a closed meal's food ----------
await q(null, `insert into food_consumption (item_id, meal_type, consumption_date, quantity, source, issued_quantity, served_quantity, unserved_quantity)
  values ($1, 'supper', current_date - 1, 5, 'meal_close', 5, 4, 1)`, [item]);
const [{ transaction_id: closeTx, consumption_id: closeC }] = await q(null, `select transaction_id, consumption_id from inventory_transactions where transaction_type = 'used'`);
ok('a closed meal took 5 kg: stock 5', (await stock()) === 5);
e = await correctErr(coord, closeTx, 3);
ok('a coordinator cannot correct an automatic entry', e?.includes('42501'), e);
await correct(head, closeTx, 3, 'Kitchen issued only 3 kg');
const [c] = await q(null, `select quantity, issued_quantity, served_quantity, unserved_quantity from food_consumption where consumption_id = $1`, [closeC]);
ok('issued 3, served capped at 3, unserved 0', num(c.quantity) === 3 && num(c.issued_quantity) === 3 && num(c.served_quantity) === 3 && num(c.unserved_quantity) === 0, JSON.stringify(c));
ok('stock back to 7', (await stock()) === 7);

// ---------- reading the log ----------
const other = await q(headB, `select count(*)::int c from stock_corrections`);
ok("another school can't read this school's corrections", other[0].c === 0);
const direct = await err(coord, `insert into stock_corrections (school_id, item_id, transaction_id, transaction_type, transaction_date, old_quantity, new_quantity, reason) values ($1, $2, $3, 'received', current_date, 1, 2, 'x')`, [school, item, received]);
ok('the log cannot be written directly', direct !== null, direct);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
