-- ============================================================
-- Fix 031: correcting a mistaken stock entry (#5).
--
-- correct_stock_entry(transaction, new quantity, reason) fixes the
-- amount of a stock movement: food received, or food used at a meal
-- (entered by hand or worked out when the meal closed). 0 removes the
-- entry. The stock moves by the difference, and the food-used record
-- of a meal changes with it, so reports stay right.
--
-- Nothing is lost: every correction is kept in stock_corrections with
-- the old and new amounts, the reason and who made it.
--
-- Who may correct:
--   * the headteacher: any entry of their school;
--   * the person who recorded it: within 24 hours.
-- A correction can't take the stock below 0 (e.g. reducing a delivery
-- whose food has already been used).
--
-- Safe to run twice. Needs fixes 009 and 016.
-- ============================================================

create table if not exists stock_corrections (
  correction_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  item_id uuid not null references inventory_items(item_id) on delete cascade,
  transaction_id uuid not null, -- the movement corrected (gone if corrected to 0)
  transaction_type text not null check (transaction_type in ('received', 'used')),
  transaction_date date not null,
  meal_type text,
  old_quantity numeric not null,
  new_quantity numeric not null check (new_quantity >= 0),
  reason text not null check (btrim(reason) <> ''),
  corrected_by uuid references users(user_id) on delete set null,
  corrected_at timestamptz not null default now()
);

create index if not exists idx_stock_corrections_item on stock_corrections(item_id, corrected_at desc);

alter table stock_corrections enable row level security;
drop policy if exists "Staff read their school's stock corrections" on stock_corrections;
create policy "Staff read their school's stock corrections"
  on stock_corrections for select
  using (public.has_school_permission(school_id, 'view_inventory')
         or public.has_school_permission(school_id, 'view_reports'));
revoke insert, update, delete on stock_corrections from authenticated, anon;

-- ------------------------------------------------------------
-- correct_stock_entry()
-- ------------------------------------------------------------
create or replace function public.correct_stock_entry(
  p_transaction_id uuid, p_new_quantity numeric, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t inventory_transactions%rowtype;
  v_c food_consumption%rowtype;
  v_delta numeric;   -- change to the stock
  v_stock numeric;
begin
  select * into v_t from inventory_transactions where transaction_id = p_transaction_id for update;
  if not found then
    raise exception 'Stock entry not found' using errcode = 'P0002';
  end if;

  -- coalesce: an automatic entry has no recorded_by, and a null here
  -- must refuse, not slip through.
  if not coalesce(public.has_school_role(v_t.school_id, array['headteacher'])
          or (v_t.recorded_by = auth.uid() and v_t.created_at > now() - interval '24 hours'
              and public.is_school_member(v_t.school_id)), false) then
    raise exception 'Only the headteacher, or the person who recorded it within 24 hours, can correct this entry'
      using errcode = '42501';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'The corrected amount can''t be below 0' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Say why the entry is being corrected' using errcode = '22023';
  end if;
  if p_new_quantity = v_t.quantity then
    raise exception 'The amount is unchanged' using errcode = '22023';
  end if;

  v_delta := case when v_t.transaction_type = 'received'
                  then p_new_quantity - v_t.quantity
                  else v_t.quantity - p_new_quantity end;

  select quantity_available into v_stock from inventory_items where item_id = v_t.item_id for update;
  if v_stock + v_delta < 0 then
    raise exception 'Only % is in stock, so this correction would take the stock below 0 (some of the food may already be used)',
      v_stock using errcode = '23514';
  end if;

  if v_t.consumption_id is not null then
    select * into v_c from food_consumption where consumption_id = v_t.consumption_id for update;
  end if;

  insert into stock_corrections (school_id, item_id, transaction_id, transaction_type, transaction_date,
                                 meal_type, old_quantity, new_quantity, reason, corrected_by)
    values (v_t.school_id, v_t.item_id, v_t.transaction_id, v_t.transaction_type, v_t.transaction_date,
            v_c.meal_type, v_t.quantity, p_new_quantity, btrim(p_reason), auth.uid());

  update inventory_items set quantity_available = quantity_available + v_delta
    where item_id = v_t.item_id;

  if p_new_quantity = 0 then
    delete from inventory_transactions where transaction_id = v_t.transaction_id;
    if v_c.consumption_id is not null then
      delete from food_consumption where consumption_id = v_c.consumption_id;
    end if;
    return;
  end if;

  update inventory_transactions set quantity = p_new_quantity where transaction_id = v_t.transaction_id;
  if v_c.consumption_id is not null then
    update food_consumption
      set quantity = p_new_quantity,
          -- A closed meal's split: what was taken is now what was issued.
          issued_quantity = case when issued_quantity is null then null else p_new_quantity end,
          served_quantity = case when served_quantity is null then null else least(served_quantity, p_new_quantity) end,
          unserved_quantity = case when served_quantity is null then null
                                   else p_new_quantity - least(served_quantity, p_new_quantity) end
      where consumption_id = v_c.consumption_id;
  end if;
end;
$$;

revoke all on function public.correct_stock_entry(uuid, numeric, text) from public, anon;
grant execute on function public.correct_stock_entry(uuid, numeric, text) to authenticated;
