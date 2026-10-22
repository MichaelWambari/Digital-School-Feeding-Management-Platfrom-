  -- ============================================================
  -- DSFMP Database Schema for Supabase (PostgreSQL)
  -- Updated to match the expanded ERD (Users, Beneficiaries,
  -- NFC_Devices, Inventory_Items, Inventory_Transactions,
  -- Meal_Attendance, Food_Distribution, Reports, NFC_Tag_Logs).
  --
  -- Run this in the Supabase SQL Editor: Project > SQL Editor > New query
  -- ============================================================

  create extension if not exists "pgcrypto";

  -- ============================================================
  -- DESTRUCTIVE RESET
  -- This development bootstrap drops all application tables and their
  -- data. Do not run it against a database whose data you need to keep.
  -- ============================================================
  drop trigger if exists on_auth_user_created on auth.users;
  drop function if exists public.handle_new_user() cascade;
  drop function if exists public.has_any_role(text[]) cascade;
  drop function if exists public.is_network_admin() cascade;
  drop function if exists public.can_view_school(uuid) cascade;
  drop function if exists public.has_school_role(uuid, text[]) cascade;
  drop function if exists public.record_nfc_scan(text, text, text, uuid, numeric) cascade;
  drop function if exists public.apply_inventory_transaction() cascade;
  drop function if exists public.apply_central_transaction() cascade;
  drop function if exists public.log_dispatch_as_central_transaction() cascade;
  drop function if exists public.log_consumption_as_transaction() cascade;
  drop function if exists public.receive_distribution(uuid, numeric) cascade;
  drop function if exists public.cancel_distribution(uuid) cascade;
  drop function if exists public.log_distribution_as_transaction() cascade;
  drop function if exists public.set_school_from_beneficiary() cascade;
  drop function if exists public.set_school_from_item() cascade;
  drop function if exists public.set_distribution_school() cascade;

  drop table if exists nfc_tag_logs cascade;
  drop table if exists reports cascade;
  drop table if exists inventory_transactions cascade;
  drop table if exists food_consumption cascade;
  drop table if exists central_transactions cascade;
  drop table if exists food_distribution cascade;
  drop table if exists meal_attendance cascade;
  drop table if exists inventory_items cascade;
  drop table if exists food_items cascade;
  drop table if exists nfc_devices cascade;
  drop table if exists beneficiaries cascade;
  drop table if exists users cascade;
  drop table if exists schools cascade;

  -- earlier (pre-rename) table names from the previous schema version
  drop table if exists distribution cascade;
  drop table if exists attendance cascade;
  drop table if exists inventory cascade;
  drop table if exists devices cascade;
  drop table if exists profiles cascade;

  -- ------------------------------------------------------------
  -- SCHOOLS
  -- The platform serves a network of schools. Every record below
  -- belongs to one school, and staff only see their own school's
  -- data. Each school has its own meal serving windows (school
  -- local time, end exclusive); a null window means that meal is
  -- not served there.
  -- ------------------------------------------------------------
  create table schools (
    school_id uuid primary key default gen_random_uuid(),
    name text not null unique,
    location text,
    timezone text not null default 'Africa/Nairobi',
    breakfast_start time default '06:00',
    breakfast_end time default '07:00',
    lunch_start time default '12:00',
    lunch_end time default '14:00',
    supper_start time default '18:00',
    supper_end time default '20:00',
    status text not null default 'active' check (status in ('active', 'inactive')),
    created_at timestamptz default now(),
    constraint breakfast_window check (
      (breakfast_start is null) = (breakfast_end is null) and
      (breakfast_start is null or breakfast_start < breakfast_end)),
    constraint lunch_window check (
      (lunch_start is null) = (lunch_end is null) and
      (lunch_start is null or lunch_start < lunch_end)),
    constraint supper_window check (
      (supper_start is null) = (supper_end is null) and
      (supper_start is null or supper_start < supper_end))
  );

  insert into schools (name) values ('Jasiri School');

  -- ------------------------------------------------------------
  -- USERS (extends Supabase's built-in auth.users)
  -- This is the "Users" entity from the ERD. We still rely on
  -- Supabase Auth for the password itself (auth.users holds the
  -- hashed password internally) rather than storing our own
  -- password_hash column -- Supabase already does this correctly
  -- and re-implementing it ourselves would be both extra work and
  -- less secure.
  -- ------------------------------------------------------------
  create table users (
    user_id uuid primary key references auth.users(id) on delete cascade,
    username text unique,
    full_name text not null,
    -- network_admin sees every school; the other roles work at one school.
    role text not null check (role in ('network_admin', 'admin', 'coordinator', 'inventory_officer')),
    school_id uuid references schools(school_id), -- null until assigned; unused for network_admin
    status text not null default 'active' check (status in ('active', 'suspended')),
    created_at timestamptz default now()
  );

  -- ------------------------------------------------------------
  -- BENEFICIARIES
  -- ------------------------------------------------------------
  create table beneficiaries (
    beneficiary_id uuid primary key default gen_random_uuid(),
    school_id uuid not null references schools(school_id),
    full_name text not null,
    age int,
    admission_no text not null,
    nfc_tag_id text unique, -- the beneficiary's own card/tag UID (not a device); unique network-wide
    status text not null default 'active' check (status in ('active', 'inactive')),
    created_at timestamptz default now(),
    constraint beneficiaries_school_admission_no_key unique (school_id, admission_no)
  );

  create index idx_beneficiaries_nfc_tag_id on beneficiaries(nfc_tag_id);
  create index idx_beneficiaries_school on beneficiaries(school_id);

  -- ------------------------------------------------------------
  -- NFC_DEVICES
  -- The physical ESP32 + MFRC522 reader units at each serving
  -- point -- NOT the beneficiaries' cards. This is an allow-list:
  -- a device must exist here and be "active" before its scans are
  -- accepted (see record_nfc_scan() below).
  -- ------------------------------------------------------------
  create table nfc_devices (
    device_id text primary key, -- e.g. 'reader-01'
    school_id uuid not null references schools(school_id),
    device_name text,
    location text,
    status text not null default 'active' check (status in ('active', 'inactive')),
    created_at timestamptz default now()
  );

  -- ------------------------------------------------------------
  -- FOOD STOCK
  -- Food flows from the network's central store (the source) to
  -- the schools, and is used there at meals:
  --
  --   supplier --received--> central store --food_distribution-->
  --   school store --food_consumption--> breakfast/lunch/supper
  --
  -- Every stock level (food_items.quantity_available for the
  -- central store, inventory_items.quantity_available for a
  -- school) is kept in sync by a trigger on its transaction table,
  -- rather than being edited directly, so a running total can
  -- never drift from the history that justifies it.
  -- ------------------------------------------------------------

  -- ------------------------------------------------------------
  -- FOOD_ITEMS
  -- The network's list of food types, kept by the network admin,
  -- and the central store's stock of each. Schools hold the same
  -- foods, so totals add up across the network.
  -- ------------------------------------------------------------
  create table food_items (
    food_id uuid primary key default gen_random_uuid(),
    item_name text not null,
    unit text not null default 'kg',
    quantity_available numeric not null default 0, -- central store stock
    reorder_level numeric not null default 0,       -- low-stock warning for the central store
    created_at timestamptz default now()
  );

  create unique index food_items_name_key on food_items (lower(item_name));

  -- ------------------------------------------------------------
  -- FOOD_DISTRIBUTION
  -- A dispatch of one food from the central store to a school.
  -- Dispatching takes the stock out of the central store at once;
  -- the food is "in transit" until the school confirms how much
  -- actually arrived (receive_distribution() below), which adds
  -- that amount to the school's stock. Any shortfall stays on
  -- record for the network admin.
  -- ------------------------------------------------------------
  create table food_distribution (
    distribution_id uuid primary key default gen_random_uuid(),
    school_id uuid not null references schools(school_id),
    food_id uuid not null references food_items(food_id),
    quantity_dispatched numeric not null check (quantity_dispatched > 0),
    dispatch_date date not null default current_date,
    dispatched_by uuid references users(user_id),
    status text not null default 'in_transit' check (status in ('in_transit', 'received', 'cancelled')),
    quantity_received numeric check (quantity_received >= 0 and quantity_received <= quantity_dispatched),
    received_date date,
    received_by uuid references users(user_id),
    created_at timestamptz default now(),
    constraint received_has_quantity check ((status = 'received') = (quantity_received is not null))
  );

  create index idx_food_distribution_school_date on food_distribution(school_id, dispatch_date);

  -- ------------------------------------------------------------
  -- CENTRAL_TRANSACTIONS
  -- Every movement in or out of the central store: deliveries from
  -- suppliers ('received'), losses and corrections ('written_off'),
  -- dispatches to schools ('dispatched') and cancelled dispatches
  -- coming back ('returned'). The last two are added automatically.
  -- ------------------------------------------------------------
  create table central_transactions (
    transaction_id uuid primary key default gen_random_uuid(),
    food_id uuid not null references food_items(food_id) on delete cascade,
    transaction_type text not null
      check (transaction_type in ('received', 'written_off', 'dispatched', 'returned')),
    quantity numeric not null check (quantity > 0),
    transaction_date date default current_date,
    distribution_id uuid references food_distribution(distribution_id), -- set for dispatched/returned
    recorded_by uuid references users(user_id),
    created_at timestamptz default now()
  );

  create function public.apply_central_transaction()
  returns trigger as $$
  begin
    if new.transaction_type in ('received', 'returned') then
      update food_items set quantity_available = quantity_available + new.quantity
        where food_id = new.food_id;
    else
      update food_items set quantity_available = quantity_available - new.quantity
        where food_id = new.food_id and quantity_available >= new.quantity;
      if not found then
        raise exception 'Insufficient central stock for food %', new.food_id
          using errcode = '23514';
      end if;
    end if;
    return new;
  end;
  $$ language plpgsql security definer set search_path = public, pg_temp;

  create trigger on_central_transaction_insert
    after insert on central_transactions
    for each row execute procedure public.apply_central_transaction();

  -- Dispatching takes the food out of the central store (and is
  -- rejected if the store doesn't have enough).
  create function public.log_dispatch_as_central_transaction()
  returns trigger as $$
  begin
    insert into central_transactions
        (food_id, transaction_type, quantity, transaction_date, distribution_id, recorded_by)
      values (new.food_id, 'dispatched', new.quantity_dispatched, new.dispatch_date,
              new.distribution_id, new.dispatched_by);
    return new;
  end;
  $$ language plpgsql security definer set search_path = public, pg_temp;

  create trigger on_food_distribution_insert
    after insert on food_distribution
    for each row execute procedure public.log_dispatch_as_central_transaction();

  -- ------------------------------------------------------------
  -- INVENTORY_ITEMS
  -- A school's stock of one food. Rows are created when the school
  -- first receives that food from the central store.
  -- ------------------------------------------------------------
  create table inventory_items (
    item_id uuid primary key default gen_random_uuid(),
    school_id uuid not null references schools(school_id), -- each school holds its own stock
    food_id uuid not null references food_items(food_id),
    quantity_available numeric not null default 0,
    reorder_level numeric default 0, -- triggers a low-stock warning in the Inventory UI
    created_at timestamptz default now(),
    constraint inventory_items_school_food_key unique (school_id, food_id)
  );

  create index idx_inventory_items_school on inventory_items(school_id);

  -- ------------------------------------------------------------
  -- FOOD_CONSUMPTION
  -- Food a school used at one meal, recorded in bulk after the meal
  -- (e.g. lunch on 22 Oct: 30 kg maize flour). Dividing by that
  -- meal's attendance gives the portion per student.
  -- ------------------------------------------------------------
  create table food_consumption (
    consumption_id uuid primary key default gen_random_uuid(),
    item_id uuid not null references inventory_items(item_id),
    school_id uuid not null references schools(school_id), -- copied from the item by trigger
    meal_type text not null check (meal_type in ('breakfast', 'lunch', 'supper')),
    consumption_date date not null default current_date,
    quantity numeric not null check (quantity > 0),
    recorded_by uuid references users(user_id),
    created_at timestamptz default now()
  );

  create index idx_food_consumption_school_date on food_consumption(school_id, consumption_date);

  -- ------------------------------------------------------------
  -- INVENTORY_TRANSACTIONS
  -- Every movement of a school's stock: food received from the
  -- central store and food used at meals. Both are added
  -- automatically (by receive_distribution() and by recording
  -- food_consumption), and link back to the record that caused them.
  -- ------------------------------------------------------------
  create table inventory_transactions (
    transaction_id uuid primary key default gen_random_uuid(),
    item_id uuid not null references inventory_items(item_id) on delete cascade,
    school_id uuid not null references schools(school_id), -- copied from the item by trigger
    transaction_type text not null check (transaction_type in ('received', 'used')),
    quantity numeric not null check (quantity > 0),
    transaction_date date default current_date,
    distribution_id uuid references food_distribution(distribution_id), -- set for 'received'
    consumption_id uuid references food_consumption(consumption_id),    -- set for 'used'
    recorded_by uuid references users(user_id),
    created_at timestamptz default now()
  );

  -- Keep inventory_items.quantity_available in sync with transactions
  create function public.apply_inventory_transaction()
  returns trigger as $$
  begin
    if new.transaction_type = 'received' then
      update inventory_items set quantity_available = quantity_available + new.quantity
        where item_id = new.item_id;
    else
      update inventory_items set quantity_available = quantity_available - new.quantity
        where item_id = new.item_id and quantity_available >= new.quantity;
      if not found then
        raise exception 'Insufficient stock for inventory item %', new.item_id
          using errcode = '23514';
      end if;
    end if;
    return new;
  end;
  $$ language plpgsql security definer set search_path = public, pg_temp;

  create trigger on_inventory_transaction_insert
    after insert on inventory_transactions
    for each row execute procedure public.apply_inventory_transaction();

  -- Recording food used at a meal takes it out of the school's
  -- stock (and is rejected if the school doesn't have enough).
  create function public.log_consumption_as_transaction()
  returns trigger as $$
  begin
    insert into inventory_transactions
        (item_id, transaction_type, quantity, transaction_date, consumption_id, recorded_by)
      values (new.item_id, 'used', new.quantity, new.consumption_date,
              new.consumption_id, new.recorded_by);
    return new;
  end;
  $$ language plpgsql security definer set search_path = public, pg_temp;

  create trigger on_food_consumption_insert
    after insert on food_consumption
    for each row execute procedure public.log_consumption_as_transaction();

  -- ------------------------------------------------------------
  -- MEAL_ATTENDANCE
  -- device_id and nfc_tag_id are both stored directly (alongside
  -- beneficiary_id) so an attendance row is self-explanatory on
  -- its own -- useful for the Reports module -- without always
  -- requiring a join back to beneficiaries or nfc_devices.
  -- ------------------------------------------------------------
  create table meal_attendance (
    attendance_id uuid primary key default gen_random_uuid(),
    beneficiary_id uuid not null references beneficiaries(beneficiary_id) on delete cascade,
    school_id uuid not null references schools(school_id), -- copied from the beneficiary by trigger
    nfc_tag_id text,
    device_id text references nfc_devices(device_id),
    recorded_by uuid references users(user_id), -- set when a Coordinator records it manually; null for a device-triggered scan
    meal_type text not null default 'lunch',
    attendance_date date default current_date,
    status text default 'present',
    created_at timestamptz default now()
  );

  create unique index idx_meal_attendance_once_per_meal
    on meal_attendance(beneficiary_id, attendance_date, meal_type);
  create index idx_meal_attendance_school_date on meal_attendance(school_id, attendance_date);

  -- ------------------------------------------------------------
  -- REPORTS
  -- Stores metadata about a generated report; the file itself is
  -- expected to live in Supabase Storage, with file_path pointing
  -- to it.
  -- ------------------------------------------------------------
  create table reports (
    report_id uuid primary key default gen_random_uuid(),
    school_id uuid references schools(school_id), -- null = network-wide report
    report_type text not null, -- e.g. 'attendance', 'inventory', 'distribution'
    generated_date date default current_date,
    start_date date,
    end_date date,
    generated_by uuid references users(user_id),
    file_path text,
    created_at timestamptz default now()
  );

  -- ------------------------------------------------------------
  -- NFC_TAG_LOGS
  -- A raw, append-only audit trail of every scan attempt at every
  -- reader -- successful or not -- kept separate from
  -- meal_attendance/food_distribution, which only hold the scans
  -- that became official business records. Useful for debugging a
  -- reader in the field ("why isn't this card working?") without
  -- digging through business tables.
  -- ------------------------------------------------------------
  create table nfc_tag_logs (
    log_id uuid primary key default gen_random_uuid(),
    nfc_tag_id text,
    device_id text,
    school_id uuid references schools(school_id), -- the reader's school; null for unknown readers
    action_type text not null, -- Failed scans may come from unregistered devices.
    created_at timestamptz default now()
  );

  -- ------------------------------------------------------------
  -- Keep school_id consistent with the record it belongs to.
  -- Attendance, food used and stock movements take their school
  -- from the beneficiary or item, so the app never sends it and a
  -- record can't be filed under the wrong school.
  -- ------------------------------------------------------------
  create function public.set_school_from_beneficiary()
  returns trigger as $$
  begin
    select school_id into new.school_id from beneficiaries where beneficiary_id = new.beneficiary_id;
    return new;
  end;
  $$ language plpgsql security definer set search_path = public, pg_temp;

  create function public.set_school_from_item()
  returns trigger as $$
  begin
    select school_id into new.school_id from inventory_items where item_id = new.item_id;
    return new;
  end;
  $$ language plpgsql security definer set search_path = public, pg_temp;

  create trigger set_meal_attendance_school
    before insert or update of beneficiary_id on meal_attendance
    for each row execute procedure public.set_school_from_beneficiary();

  create trigger set_food_consumption_school
    before insert or update of item_id on food_consumption
    for each row execute procedure public.set_school_from_item();

  create trigger set_inventory_transaction_school
    before insert or update of item_id on inventory_transactions
    for each row execute procedure public.set_school_from_item();

  -- ============================================================
  -- ROW LEVEL SECURITY
  -- The network admin runs the central store and dispatches food
  -- to schools. They can see every school's records but not change
  -- them: students, attendance, stock and food used are recorded
  -- by each school's own staff.
  -- ============================================================
  alter table schools enable row level security;
  alter table users enable row level security;
  alter table beneficiaries enable row level security;
  alter table nfc_devices enable row level security;
  alter table food_items enable row level security;
  alter table food_distribution enable row level security;
  alter table central_transactions enable row level security;
  alter table inventory_items enable row level security;
  alter table food_consumption enable row level security;
  alter table inventory_transactions enable row level security;
  alter table meal_attendance enable row level security;
  alter table reports enable row level security;
  alter table nfc_tag_logs enable row level security;

  create function public.is_network_admin()
  returns boolean language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.users
      where user_id = auth.uid() and status = 'active' and role = 'network_admin'
    );
  $$;

  -- Can the current user see this school's data?
  create function public.can_view_school(p_school_id uuid)
  returns boolean language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.users
      where user_id = auth.uid() and status = 'active'
        and (role = 'network_admin' or school_id = p_school_id)
    );
  $$;

  -- Does the current user hold one of these roles at this school?
  -- Network admins don't: they only view school records.
  create function public.has_school_role(p_school_id uuid, p_roles text[])
  returns boolean language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.users
      where user_id = auth.uid() and status = 'active'
        and school_id = p_school_id and role = any(p_roles)
    );
  $$;

  revoke all on function public.is_network_admin() from public;
  revoke all on function public.can_view_school(uuid) from public;
  revoke all on function public.has_school_role(uuid, text[]) from public;
  grant execute on function public.is_network_admin() to anon, authenticated;
  grant execute on function public.can_view_school(uuid) to anon, authenticated;
  grant execute on function public.has_school_role(uuid, text[]) to anon, authenticated;

  create policy "Staff can read their school"
    on schools for select using (public.can_view_school(school_id));
  create policy "Admins can update their school"
    on schools for update
    using (public.has_school_role(school_id, array['admin']) or public.is_network_admin())
    with check (public.has_school_role(school_id, array['admin']) or public.is_network_admin());
  create policy "Network admins can add schools"
    on schools for insert with check (public.is_network_admin());
  create policy "Network admins can remove schools"
    on schools for delete using (public.is_network_admin());

  create policy "Users can read own profile and admins their school"
    on users for select
    using (user_id = auth.uid() or public.has_school_role(school_id, array['admin'])
           or public.is_network_admin());

  create policy "Staff can read their school's beneficiaries"
    on beneficiaries for select using (public.can_view_school(school_id));
  create policy "Coordinators can manage their school's beneficiaries"
    on beneficiaries for all
    using (public.has_school_role(school_id, array['admin', 'coordinator']))
    with check (public.has_school_role(school_id, array['admin', 'coordinator']));

  create policy "Staff can read their school's devices"
    on nfc_devices for select using (public.can_view_school(school_id));
  create policy "Admins can manage their school's devices"
    on nfc_devices for all
    using (public.has_school_role(school_id, array['admin']) or public.is_network_admin())
    with check (public.has_school_role(school_id, array['admin']) or public.is_network_admin());

  -- Every signed-in user can read the food list; the network admin keeps it.
  create policy "Signed-in users can read the food list"
    on food_items for select using (auth.uid() is not null);
  create policy "Network admins can manage the food list"
    on food_items for all
    using (public.is_network_admin()) with check (public.is_network_admin());
  -- quantity_available only changes through central_transactions.
  revoke insert, update on food_items from authenticated;
  grant insert (item_name, unit, reorder_level) on food_items to authenticated;
  grant update (item_name, unit, reorder_level) on food_items to authenticated;

  create policy "Network admins can read central store movements"
    on central_transactions for select using (public.is_network_admin());
  -- Dispatches and returns are added automatically, not by hand.
  create policy "Network admins can record deliveries and write-offs"
    on central_transactions for insert
    with check (public.is_network_admin() and transaction_type in ('received', 'written_off'));

  -- Deliveries are confirmed or cancelled through receive_distribution()
  -- and cancel_distribution() below, never by editing rows directly.
  create policy "Staff can read their school's deliveries"
    on food_distribution for select using (public.can_view_school(school_id));
  create policy "Network admins can dispatch food"
    on food_distribution for insert with check (public.is_network_admin());
  revoke insert, update, delete on food_distribution from authenticated;
  grant insert (school_id, food_id, quantity_dispatched, dispatch_date, dispatched_by)
    on food_distribution to authenticated;

  -- Items appear when a school first receives a food; staff can only set the reorder level.
  create policy "Staff can read their school's inventory items"
    on inventory_items for select using (public.can_view_school(school_id));
  create policy "Inventory officers can set their school's reorder levels"
    on inventory_items for update
    using (public.has_school_role(school_id, array['admin', 'inventory_officer']))
    with check (public.has_school_role(school_id, array['admin', 'inventory_officer']));
  revoke insert, update, delete on inventory_items from authenticated;
  grant update (reorder_level) on inventory_items to authenticated;

  create policy "Staff can read their school's food used"
    on food_consumption for select using (public.can_view_school(school_id));
  create policy "School staff can record food used"
    on food_consumption for insert
    with check (public.has_school_role(school_id, array['admin', 'coordinator', 'inventory_officer']));

  -- Stock movements are only added by the triggers and functions above.
  create policy "Staff can read their school's inventory transactions"
    on inventory_transactions for select using (public.can_view_school(school_id));

  create policy "Staff can read their school's attendance"
    on meal_attendance for select using (public.can_view_school(school_id));
  create policy "Coordinators can manage their school's attendance"
    on meal_attendance for all
    using (public.has_school_role(school_id, array['admin', 'coordinator']))
    with check (public.has_school_role(school_id, array['admin', 'coordinator']));

  -- A null school_id is a network-wide report, visible to network admins only.
  create policy "Staff can read their school's reports"
    on reports for select using (public.can_view_school(school_id));
  create policy "Coordinators can manage their school's reports"
    on reports for all
    using (public.has_school_role(school_id, array['admin', 'coordinator']) or public.is_network_admin())
    with check (public.has_school_role(school_id, array['admin', 'coordinator']) or public.is_network_admin());

  -- Logs from unknown readers (null school_id) are visible to network admins only.
  create policy "Admins can read their school's NFC audit logs"
    on nfc_tag_logs for select
    using (public.has_school_role(school_id, array['admin']) or public.is_network_admin());

  -- ------------------------------------------------------------
  -- receive_distribution(): a school confirms a delivery from the
  -- central store, giving the amount that actually arrived (at most
  -- the amount sent). That amount is added to the school's stock.
  -- ------------------------------------------------------------
  create function public.receive_distribution(p_distribution_id uuid, p_quantity_received numeric)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  declare
    v_dispatch food_distribution%rowtype;
    v_item_id uuid;
    v_today date;
  begin
    select * into v_dispatch from food_distribution
      where distribution_id = p_distribution_id for update;
    if not found or not public.can_view_school(v_dispatch.school_id) then
      raise exception 'Delivery not found' using errcode = 'P0002';
    end if;
    if not public.has_school_role(v_dispatch.school_id, array['admin', 'inventory_officer']) then
      raise exception 'Only the school''s admin or inventory officer can confirm deliveries'
        using errcode = '42501';
    end if;
    if v_dispatch.status <> 'in_transit' then
      raise exception 'This delivery is already %', replace(v_dispatch.status, '_', ' ')
        using errcode = '22023';
    end if;
    if p_quantity_received is null or p_quantity_received < 0
       or p_quantity_received > v_dispatch.quantity_dispatched then
      raise exception 'The amount received must be between 0 and %', v_dispatch.quantity_dispatched
        using errcode = '22023';
    end if;

    v_today := (now() at time zone (select timezone from schools
                                    where school_id = v_dispatch.school_id))::date;

    insert into inventory_items (school_id, food_id)
      values (v_dispatch.school_id, v_dispatch.food_id)
      on conflict (school_id, food_id) do nothing;
    select item_id into v_item_id from inventory_items
      where school_id = v_dispatch.school_id and food_id = v_dispatch.food_id;

    update food_distribution
      set status = 'received', quantity_received = p_quantity_received,
          received_date = v_today, received_by = auth.uid()
      where distribution_id = p_distribution_id;

    if p_quantity_received > 0 then
      insert into inventory_transactions
          (item_id, transaction_type, quantity, transaction_date, distribution_id, recorded_by)
        values (v_item_id, 'received', p_quantity_received, v_today, p_distribution_id, auth.uid());
    end if;
  end;
  $$;

  -- ------------------------------------------------------------
  -- cancel_distribution(): the network admin cancels a dispatch
  -- that is still in transit; its food goes back into the store.
  -- ------------------------------------------------------------
  create function public.cancel_distribution(p_distribution_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  declare
    v_dispatch food_distribution%rowtype;
  begin
    if not public.is_network_admin() then
      raise exception 'Only network admins can cancel a dispatch' using errcode = '42501';
    end if;
    select * into v_dispatch from food_distribution
      where distribution_id = p_distribution_id for update;
    if not found then
      raise exception 'Dispatch not found' using errcode = 'P0002';
    end if;
    if v_dispatch.status <> 'in_transit' then
      raise exception 'This delivery is already %', replace(v_dispatch.status, '_', ' ')
        using errcode = '22023';
    end if;

    update food_distribution set status = 'cancelled' where distribution_id = p_distribution_id;
    insert into central_transactions
        (food_id, transaction_type, quantity, distribution_id, recorded_by)
      values (v_dispatch.food_id, 'returned', v_dispatch.quantity_dispatched,
              p_distribution_id, auth.uid());
  end;
  $$;

  revoke all on function public.receive_distribution(uuid, numeric) from public;
  revoke all on function public.cancel_distribution(uuid) from public;
  grant execute on function public.receive_distribution(uuid, numeric) to authenticated;
  grant execute on function public.cancel_distribution(uuid) to authenticated;

  -- Note: there is deliberately no policy letting the anon key (used
  -- by the ESP32 readers, which have no user login) write directly to
  -- meal_attendance or nfc_tag_logs. Instead, every device write goes
  -- through record_nfc_scan() below, which runs as
  -- SECURITY DEFINER (so it isn't limited by these policies), checks
  -- the device is registered and active, looks the tag up internally,
  -- and returns only a success flag and first name -- the beneficiaries
  -- table itself is never exposed to the public anon key.

  -- ------------------------------------------------------------
  -- Auto-create a users row whenever someone signs up. New users
  -- have no school (and so see nothing) until one is assigned.
  -- ------------------------------------------------------------
  create function public.handle_new_user()
  returns trigger as $$
  begin
    insert into public.users (user_id, username, full_name, role)
    values (
      new.id,
      new.raw_user_meta_data->>'username',
      coalesce(new.raw_user_meta_data->>'full_name', 'New User'),
      'coordinator'
    );
    return new;
  end;
  $$ language plpgsql security definer set search_path = public, pg_temp;

  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

  -- ------------------------------------------------------------
  -- record_nfc_scan(): the single endpoint the ESP32 calls.
  -- A card tap records the student's attendance at the current
  -- meal. (Food used is recorded per meal in bulk, in
  -- food_consumption, not per tap.) Every call is logged to
  -- nfc_tag_logs regardless of outcome, so a misbehaving reader or
  -- an unregistered card leaves a trace to investigate.
  -- The reader's school decides everything: only that school's
  -- cards are accepted ('wrong_school' otherwise),
  -- and attendance scans are filed under the meal whose serving
  -- window (in schools, school local time) they fall in. Scans
  -- outside every window are rejected with 'outside_meal_time'.
  -- ------------------------------------------------------------
  create or replace function record_nfc_scan(
    p_nfc_tag_id text,
    p_device_id text,
    -- Readers used to issue food per tap too. Only 'attendance' is
    -- accepted now; the unused parameters keep older readers working.
    p_mode text default 'attendance',
    p_item_id uuid default null,
    p_quantity numeric default 1
  )
  returns json
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_device nfc_devices%rowtype;
    v_school schools%rowtype;
    v_beneficiary beneficiaries%rowtype;
    v_local_now timestamp;
    v_time time;
    v_meal_type text;
  begin
    if p_nfc_tag_id is null or btrim(p_nfc_tag_id) = '' then
      insert into nfc_tag_logs (nfc_tag_id, device_id, action_type)
        values (p_nfc_tag_id, p_device_id, 'invalid_tag');
      return json_build_object('success', false, 'error', 'invalid_tag');
    end if;

    select * into v_device from nfc_devices where device_id = p_device_id;
    if not found or v_device.status <> 'active' then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_device.school_id, 'inactive_device');
      return json_build_object('success', false, 'error', 'unregistered_or_inactive_device');
    end if;

    select * into v_school from schools where school_id = v_device.school_id;
    if v_school.status <> 'active' then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'inactive_school');
      return json_build_object('success', false, 'error', 'inactive_school');
    end if;

    if p_mode is null or p_mode <> 'attendance' then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'invalid_mode');
      return json_build_object('success', false, 'error', 'invalid_mode');
    end if;

    select * into v_beneficiary from beneficiaries where nfc_tag_id = p_nfc_tag_id;
    if not found then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'unknown_tag');
      return json_build_object('success', false, 'error', 'unknown_tag');
    end if;

    if v_beneficiary.school_id <> v_school.school_id then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'wrong_school');
      return json_build_object('success', false, 'error', 'wrong_school');
    end if;

    if v_beneficiary.status <> 'active' then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'not_eligible');
      return json_build_object('success', false, 'error', 'not_eligible');
    end if;

    -- The meal is decided by the school's serving window the scan falls in
    -- (school local time, end time exclusive). A null window = meal not served.
    v_local_now := now() at time zone v_school.timezone;
    v_time := v_local_now::time;
    v_meal_type := case
      when v_time >= v_school.breakfast_start and v_time < v_school.breakfast_end then 'breakfast'
      when v_time >= v_school.lunch_start and v_time < v_school.lunch_end then 'lunch'
      when v_time >= v_school.supper_start and v_time < v_school.supper_end then 'supper'
    end;
    if v_meal_type is null then
      insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
        values (p_nfc_tag_id, p_device_id, v_school.school_id, 'outside_meal_time');
      return json_build_object('success', false, 'error', 'outside_meal_time');
    end if;

    insert into meal_attendance
        (beneficiary_id, nfc_tag_id, device_id, meal_type, attendance_date, status)
      values (v_beneficiary.beneficiary_id, p_nfc_tag_id, p_device_id,
              v_meal_type, v_local_now::date, 'present')
      on conflict (beneficiary_id, attendance_date, meal_type) do nothing;
    insert into nfc_tag_logs (nfc_tag_id, device_id, school_id, action_type)
      values (p_nfc_tag_id, p_device_id, v_school.school_id, 'attendance_recorded');

    return json_build_object('success', true, 'first_name', split_part(v_beneficiary.full_name, ' ', 1));
  end;
  $$;

  grant execute on function record_nfc_scan(text, text, text, uuid, numeric) to anon, authenticated;
