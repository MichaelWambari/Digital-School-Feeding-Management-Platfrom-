-- ============================================================
-- Fix 015: request food from a supplier when stock runs low
--
-- When a school's stock of a food is at or below its reorder level
-- (or won't cover the next meal), the Distribution screen shows it
-- and staff with the 'view_procurement' permission (the headteacher,
-- and coordinators by default) can ask one of the school's approved
-- suppliers for it.
--
--   pending   -> the supplier accepts or declines it
--   accepted  -> the school records the amount that arrived
--   delivered -> that amount was added to the school's stock
--   declined / cancelled -> closed (the school can cancel until delivery)
--
-- Recording the delivery needs 'verify_deliveries', like any food
-- received, and adds a 'received' stock movement naming the supplier.
--
-- Run it once, after fix 014. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

create table if not exists supply_requests (
  request_id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(school_id) on delete cascade,
  supplier_id uuid not null references suppliers(supplier_id) on delete cascade,
  food_id uuid not null references food_items(food_id),
  quantity numeric not null check (quantity > 0),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'delivered', 'cancelled')),
  note text,                 -- the school's note with its request
  response_note text,        -- the supplier's note when accepting or declining
  requested_by uuid references users(user_id) on delete set null,
  responded_at timestamptz,
  quantity_received numeric check (quantity_received is null or quantity_received >= 0),
  received_by uuid references users(user_id) on delete set null,
  received_at timestamptz,
  transaction_id uuid references inventory_transactions(transaction_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supply_requests_school_idx on supply_requests (school_id, created_at desc);
create index if not exists supply_requests_supplier_idx on supply_requests (supplier_id, created_at desc);

alter table supply_requests enable row level security;

drop policy if exists "Suppliers and schools read their supply requests" on supply_requests;
create policy "Suppliers and schools read their supply requests"
  on supply_requests for select
  using (supplier_id = public.my_supplier_id()
         or public.has_school_permission(school_id, 'view_procurement')
         or public.has_school_permission(school_id, 'verify_deliveries'));

revoke insert, update, delete on supply_requests from anon, authenticated;
grant select on supply_requests to authenticated;

-- ------------------------------------------------------------
-- The school's side
-- ------------------------------------------------------------

-- Ask an approved supplier for a food.
create or replace function public.request_supply(
  p_supplier_id uuid, p_food_id uuid, p_quantity numeric, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
  v_request_id uuid;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_permission(v_school_id, 'view_procurement') then
    raise exception 'You don''t have permission to request supplies' using errcode = '42501';
  end if;
  if not exists (select 1 from school_suppliers
                 where school_id = v_school_id and supplier_id = p_supplier_id and status = 'approved') then
    raise exception 'Your school hasn''t approved this supplier' using errcode = '42501';
  end if;
  if not public.food_usable_by(p_food_id, v_school_id) then
    raise exception 'Food not found' using errcode = 'P0002';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'The amount must be more than 0' using errcode = '22023';
  end if;
  if exists (select 1 from supply_requests
             where school_id = v_school_id and supplier_id = p_supplier_id and food_id = p_food_id
               and status in ('pending', 'accepted')) then
    raise exception 'This supplier already has an open request for that food' using errcode = '22023';
  end if;

  insert into supply_requests (school_id, supplier_id, food_id, quantity, note, requested_by)
  values (v_school_id, p_supplier_id, p_food_id, p_quantity, nullif(btrim(p_note), ''), auth.uid())
  returning request_id into v_request_id;
  return v_request_id;
end;
$$;

-- Cancel a request that hasn't been delivered.
create or replace function public.cancel_supply_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request supply_requests%rowtype;
begin
  select * into v_request from supply_requests where request_id = p_request_id for update;
  if not found or not public.has_school_permission(v_request.school_id, 'view_procurement') then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_request.status not in ('pending', 'accepted') then
    raise exception 'This request is already %', v_request.status using errcode = '22023';
  end if;
  update supply_requests set status = 'cancelled', updated_at = now()
    where request_id = p_request_id;
end;
$$;

-- Record what arrived (0 if nothing did); adds it to the school's stock.
create or replace function public.receive_supply_request(p_request_id uuid, p_quantity numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request supply_requests%rowtype;
  v_item_id uuid;
  v_transaction_id uuid;
  v_today date;
begin
  select * into v_request from supply_requests where request_id = p_request_id for update;
  if not found or not (public.has_school_permission(v_request.school_id, 'view_procurement')
                       or public.has_school_permission(v_request.school_id, 'verify_deliveries')) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if not public.has_school_permission(v_request.school_id, 'verify_deliveries') then
    raise exception 'You don''t have permission to record food received' using errcode = '42501';
  end if;
  if v_request.status not in ('pending', 'accepted') then
    raise exception 'This request is already %', v_request.status using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'Enter the amount that arrived' using errcode = '22023';
  end if;

  if p_quantity > 0 then
    v_today := (now() at time zone (select timezone from schools where school_id = v_request.school_id))::date;
    insert into inventory_items (school_id, food_id) values (v_request.school_id, v_request.food_id)
      on conflict (school_id, food_id) do nothing;
    select item_id into v_item_id from inventory_items
      where school_id = v_request.school_id and food_id = v_request.food_id;
    insert into inventory_transactions
        (item_id, transaction_type, quantity, transaction_date, recorded_by, supplier_name, note)
      values (v_item_id, 'received', p_quantity, v_today, auth.uid(),
              (select business_name from suppliers where supplier_id = v_request.supplier_id),
              'Supply request')
      returning transaction_id into v_transaction_id;
  end if;

  update supply_requests
    set status = 'delivered', quantity_received = p_quantity, received_by = auth.uid(),
        received_at = now(), transaction_id = v_transaction_id, updated_at = now()
    where request_id = p_request_id;
end;
$$;

-- The school's requests, newest first, with supplier and food names.
create or replace function public.school_supply_requests()
returns table (request_id uuid, supplier_id uuid, business_name text, phone text,
               food_id uuid, item_name text, unit text, pack_size numeric,
               quantity numeric, status text, note text, response_note text,
               requested_by_name text, created_at timestamptz, responded_at timestamptz,
               quantity_received numeric, received_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select u.school_id into v_school_id from users u where u.user_id = auth.uid();
  if v_school_id is null or not (public.has_school_permission(v_school_id, 'view_procurement')
                                 or public.has_school_permission(v_school_id, 'verify_deliveries')) then
    raise exception 'You don''t have permission to see supply requests' using errcode = '42501';
  end if;
  return query
    select r.request_id, r.supplier_id, s.business_name, s.phone,
           r.food_id, f.item_name, f.unit, f.pack_size,
           r.quantity, r.status, r.note, r.response_note,
           u.full_name, r.created_at, r.responded_at, r.quantity_received, r.received_at
    from supply_requests r
    join suppliers s on s.supplier_id = r.supplier_id
    join food_items f on f.food_id = r.food_id
    left join users u on u.user_id = r.requested_by
    where r.school_id = v_school_id
    order by (r.status in ('pending', 'accepted')) desc, r.created_at desc
    limit 200;
end;
$$;

-- ------------------------------------------------------------
-- The supplier's side
-- ------------------------------------------------------------

-- The supplier's requests, newest first, with school and food names.
create or replace function public.supplier_supply_requests()
returns table (request_id uuid, school_id uuid, school_name text, county text, location text,
               item_name text, unit text, pack_size numeric, quantity numeric, status text,
               note text, response_note text, requested_by_name text,
               created_at timestamptz, responded_at timestamptz,
               quantity_received numeric, received_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_supplier_id uuid := public.my_supplier_id();
begin
  if v_supplier_id is null then
    raise exception 'Only a supplier can do this' using errcode = '42501';
  end if;
  return query
    select r.request_id, r.school_id, sc.name, sc.county, sc.location,
           f.item_name, f.unit, f.pack_size, r.quantity, r.status,
           r.note, r.response_note, u.full_name,
           r.created_at, r.responded_at, r.quantity_received, r.received_at
    from supply_requests r
    join schools sc on sc.school_id = r.school_id
    join food_items f on f.food_id = r.food_id
    left join users u on u.user_id = r.requested_by
    where r.supplier_id = v_supplier_id
    order by (r.status = 'pending') desc, r.created_at desc
    limit 200;
end;
$$;

-- Accept or decline a pending request.
create or replace function public.respond_supply_request(
  p_request_id uuid, p_accept boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request supply_requests%rowtype;
begin
  select * into v_request from supply_requests
    where request_id = p_request_id and supplier_id = public.my_supplier_id() for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request is already %', v_request.status using errcode = '22023';
  end if;
  if p_accept is null then
    raise exception 'Accept or decline the request' using errcode = '22023';
  end if;
  update supply_requests
    set status = case when p_accept then 'accepted' else 'declined' end,
        response_note = nullif(btrim(p_note), ''), responded_at = now(), updated_at = now()
    where request_id = p_request_id;
end;
$$;

revoke all on function public.request_supply(uuid, uuid, numeric, text) from public;
revoke all on function public.cancel_supply_request(uuid) from public;
revoke all on function public.receive_supply_request(uuid, numeric) from public;
revoke all on function public.school_supply_requests() from public;
revoke all on function public.supplier_supply_requests() from public;
revoke all on function public.respond_supply_request(uuid, boolean, text) from public;
grant execute on function public.request_supply(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.cancel_supply_request(uuid) to authenticated;
grant execute on function public.receive_supply_request(uuid, numeric) to authenticated;
grant execute on function public.school_supply_requests() to authenticated;
grant execute on function public.supplier_supply_requests() to authenticated;
grant execute on function public.respond_supply_request(uuid, boolean, text) to authenticated;

commit;

select (select count(*) from supply_requests) as supply_requests;
