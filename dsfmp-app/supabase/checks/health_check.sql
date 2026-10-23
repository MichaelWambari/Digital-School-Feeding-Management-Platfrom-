-- ============================================================
-- DSFMP database health check (READ-ONLY)
-- Paste into Supabase SQL Editor and run. It changes nothing.
-- Returns one row per check: OK, WARN (worth a look), FAIL (broken)
-- or INFO (counts for context).
-- ============================================================
with
expected_tables(t) as (
  values ('schools'), ('users'), ('beneficiaries'), ('nfc_devices'), ('food_items'),
         ('central_transactions'), ('food_distribution'), ('inventory_items'),
         ('food_consumption'), ('inventory_transactions'), ('meal_attendance'),
         ('reports'), ('nfc_tag_logs')
),
tbl as (
  select e.t, c.oid is not null as present, coalesce(c.relrowsecurity, false) as rls,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = e.t) as policies
  from expected_tables e
  left join pg_class c on c.relname = e.t and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
),
expected_triggers(tg, on_table) as (
  values ('on_auth_user_created', 'auth.users'),
         ('on_inventory_transaction_insert', 'public.inventory_transactions'),
         ('on_central_transaction_insert', 'public.central_transactions'),
         ('on_food_distribution_insert', 'public.food_distribution'),
         ('on_food_consumption_insert', 'public.food_consumption'),
         ('set_meal_attendance_school', 'public.meal_attendance'),
         ('set_food_consumption_school', 'public.food_consumption'),
         ('set_inventory_transaction_school', 'public.inventory_transactions')
),
fn as (
  select p.proname, p.prosrc, p.proconfig, p.prosecdef
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
stock as (
  select i.item_id, s.name || ': ' || f.item_name as item_name, i.quantity_available, i.reorder_level,
         coalesce(sum(t.quantity) filter (where t.transaction_type = 'received'), 0)
       - coalesce(sum(t.quantity) filter (where t.transaction_type = 'used'), 0) as from_history
  from inventory_items i
  join schools s on s.school_id = i.school_id
  join food_items f on f.food_id = i.food_id
  left join inventory_transactions t on t.item_id = i.item_id
  group by i.item_id, s.name, f.item_name
),
central_stock as (
  select f.food_id, f.item_name, f.quantity_available, f.reorder_level,
         coalesce(sum(t.quantity) filter (where t.transaction_type in ('received', 'returned')), 0)
       - coalesce(sum(t.quantity) filter (where t.transaction_type in ('written_off', 'dispatched')), 0)
           as from_history
  from food_items f
  left join central_transactions t on t.food_id = f.food_id
  group by f.food_id
)

-- ---------- STRUCTURE ----------
select 1 as n, 'Structure' as section, 'Table ' || t || ' exists' as check_name,
       case when present then 'OK' else 'FAIL' end as result, '' as detail
from tbl
union all
select 2, 'Structure', 'RLS enabled on ' || t,
       case when not present then 'FAIL' when rls then 'OK' else 'FAIL' end,
       policies || ' policies'
from tbl
union all
select 3, 'Structure', 'Trigger ' || tg,
       case when exists (select 1 from pg_trigger g where g.tgname = tg and not g.tgisinternal
                         and g.tgrelid = on_table::regclass) then 'OK' else 'FAIL' end,
       'on ' || on_table
from expected_triggers
union all
select 4, 'Structure', 'Function ' || f || ' exists',
       case when exists (select 1 from fn where proname = f) then 'OK' else 'FAIL' end, ''
from unnest(array['handle_new_user', 'is_network_admin', 'can_view_school', 'has_school_role',
                  'record_nfc_scan', 'apply_inventory_transaction', 'apply_central_transaction',
                  'log_dispatch_as_central_transaction', 'log_consumption_as_transaction',
                  'receive_distribution', 'cancel_distribution', 'list_staff', 'update_staff',
                  'set_school_from_beneficiary', 'set_school_from_item']) f
union all
select 5, 'Structure', 'Security definer functions pin search_path',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       coalesce(string_agg(proname, ', '), '')
from fn where prosecdef and coalesce(array_to_string(proconfig, ','), '') not like '%search_path%'
union all
select 6, 'Structure', 'Fix 002: NFC scans are filed by meal serving window',
       case when exists (select 1 from fn where proname = 'record_nfc_scan'
                         and prosrc like '%outside_meal_time%') then 'OK' else 'FAIL' end,
       'run supabase/fixes/002 and 003 if FAIL'
union all
select 7, 'Structure', 'One attendance per student per meal (unique index)',
       case when exists (select 1 from pg_indexes where schemaname = 'public'
                         and indexname = 'idx_meal_attendance_once_per_meal') then 'OK' else 'FAIL' end, ''
union all
select 8, 'Structure', 'Fix 003: NFC scans use the reader''s school',
       case when exists (select 1 from fn where proname = 'record_nfc_scan'
                         and prosrc like '%wrong_school%') then 'OK' else 'FAIL' end,
       'run supabase/fixes/003 if FAIL'
union all
select 9, 'Structure', 'Fix 004: central store and food used per meal',
       case when to_regclass('public.food_consumption') is not null then 'OK' else 'FAIL' end,
       'run supabase/fixes/004 if FAIL'

-- ---------- SCHOOLS ----------
union all
select 15, 'Schools', 'Schools', 'INFO',
       coalesce(string_agg(name || case when status = 'active' then '' else ' (inactive)' end, ', '
                           order by name), 'no schools')
from schools
union all
select 16, 'Schools', 'Staff assigned to a school',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' non-network-admin users with no school (they see nothing until assigned)'
from public.users where role <> 'network_admin' and school_id is null
union all
select 17, 'Schools', 'Attendance filed under the student''s school',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' attendance records with a different school than their student'
from meal_attendance a join beneficiaries b using (beneficiary_id) where a.school_id <> b.school_id
union all
select 18, 'Schools', 'Food used filed under the item''s school',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' food-used records with a different school than their item'
from food_consumption c join inventory_items i using (item_id) where c.school_id <> i.school_id
union all
select 19, 'Schools', 'Stock movements filed under the item''s school',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' transactions with a different school than their item'
from inventory_transactions t join inventory_items i using (item_id) where t.school_id <> i.school_id
union all
select 19, 'Schools', 'NFC attendance read by a reader at the student''s school',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' NFC attendance records from another school''s reader'
from meal_attendance a join nfc_devices d using (device_id) where a.school_id <> d.school_id

-- ---------- ACCOUNTS ----------
union all
select 10, 'Accounts', 'Every login has a users profile',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' auth accounts with no row in public.users (they cannot use the app)'
from auth.users a where not exists (select 1 from public.users u where u.user_id = a.id)
union all
select 11, 'Accounts', 'Users per role', 'INFO',
       coalesce(string_agg(role || ': ' || n, ', '), 'no users')
from (select role, count(*) n from public.users group by role order by role) r
union all
select 12, 'Accounts', 'At least one active admin or network admin',
       case when count(*) > 0 then 'OK' else 'WARN' end, count(*) || ' active admins'
from public.users where role in ('admin', 'network_admin') and status = 'active'
union all
select 13, 'Accounts', 'Profiles still named "New User"',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' users with the default name; set full_name so records are traceable'
from public.users where full_name = 'New User'

-- ---------- STUDENTS ----------
union all
select 20, 'Students', 'Students', 'INFO',
       count(*) || ' total, ' || count(*) filter (where status = 'active') || ' active, '
       || count(*) filter (where status = 'inactive') || ' inactive'
from beneficiaries
union all
select 21, 'Students', 'Active students with an NFC card',
       case when count(*) filter (where nfc_tag_id is null) = 0 then 'OK' else 'WARN' end,
       count(*) filter (where nfc_tag_id is null) || ' of ' || count(*)
       || ' active students have no card (manual attendance only)'
from beneficiaries where status = 'active'
union all
select 22, 'Students', 'Ages look plausible (3-25)',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' students with a missing or unusual age'
from beneficiaries where age is null or age not between 3 and 25
union all
select 23, 'Students', 'Blank card IDs stored as text',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' students with an empty-string nfc_tag_id (should be null)'
from beneficiaries where trim(nfc_tag_id) = ''

-- ---------- DEVICES & NFC ----------
union all
select 30, 'NFC', 'Registered readers', 'INFO',
       count(*) || ' devices, ' || count(*) filter (where status = 'active') || ' active'
from nfc_devices
union all
select 31, 'NFC', 'Scans from unregistered readers (last 30 days)',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' scans from device IDs not in nfc_devices'
from nfc_tag_logs l
where l.created_at > now() - interval '30 days'
  and not exists (select 1 from nfc_devices d where d.device_id = l.device_id)
union all
select 32, 'NFC', 'Scan outcomes (last 30 days)', 'INFO',
       coalesce(string_agg(action_type || ': ' || n, ', '), 'no scans yet')
from (select action_type, count(*) n from nfc_tag_logs
      where created_at > now() - interval '30 days' group by action_type order by n desc) s

-- ---------- ATTENDANCE ----------
union all
select 40, 'Attendance', 'Attendance records', 'INFO',
       count(*) || ' total, ' || count(*) filter (where device_id is not null) || ' from NFC, '
       || count(*) filter (where device_id is null) || ' manual'
from meal_attendance
union all
select 41, 'Attendance', 'Meal type is breakfast, lunch or supper',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' records with another meal type'
from meal_attendance where meal_type not in ('breakfast', 'lunch', 'supper')
union all
select 42, 'Attendance', 'No attendance dated in the future',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' records after today (Nairobi)'
from meal_attendance where attendance_date > (now() at time zone 'Africa/Nairobi')::date
union all
select 43, 'Attendance', 'NFC tag on record matches the student''s card',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' records whose nfc_tag_id differs from the student''s current card'
from meal_attendance a join beneficiaries b using (beneficiary_id)
where a.nfc_tag_id is not null and a.nfc_tag_id is distinct from b.nfc_tag_id
union all
select 44, 'Attendance', 'Manual records say who recorded them',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' manual records with no recorded_by'
from meal_attendance where device_id is null and recorded_by is null
union all
select 45, 'Attendance', 'Attendance for inactive students',
       case when count(*) = 0 then 'OK' else 'INFO' end,
       count(*) || ' records belong to students now marked inactive (fine if they left later)'
from meal_attendance a join beneficiaries b using (beneficiary_id) where b.status = 'inactive'

-- ---------- INVENTORY ----------
union all
select 50, 'Inventory', 'Stock level matches transaction history: ' || item_name,
       case when quantity_available = from_history then 'OK' else 'FAIL' end,
       'stored ' || quantity_available || ', history says ' || from_history
from stock
union all
select 51, 'Inventory', 'No negative stock',
       case when count(*) = 0 then 'OK' else 'FAIL' end, count(*) || ' items below zero'
from inventory_items where quantity_available < 0
union all
select 52, 'Inventory', 'Food used at meals deducted stock',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' food-used records with no matching stock movement (records converted by fix 004 are exempt)'
from food_consumption c
where not exists (select 1 from inventory_transactions t where t.consumption_id = c.consumption_id)
  and c.created_at >= coalesce((select min(created_at) from inventory_transactions
                                where consumption_id is not null), now())
union all
select 55, 'Inventory', 'Central store matches its history: ' || item_name,
       case when quantity_available = from_history then 'OK' else 'FAIL' end,
       'stored ' || quantity_available || ', history says ' || from_history
from central_stock
union all
select 56, 'Inventory', 'Central store low on stock', case when count(*) = 0 then 'OK' else 'WARN' end,
       coalesce(string_agg(item_name || ' (' || quantity_available || ')', ', '), 'none')
from central_stock where quantity_available <= reorder_level and reorder_level > 0
union all
select 53, 'Inventory', 'Low-stock items', case when count(*) = 0 then 'OK' else 'WARN' end,
       coalesce(string_agg(item_name || ' (' || quantity_available || ')', ', '), 'none')
from stock where quantity_available <= coalesce(reorder_level, 0) and coalesce(reorder_level, 0) > 0
union all
select 54, 'Inventory', 'Stock movements say who recorded them',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' transactions with no recorded_by'
from inventory_transactions where recorded_by is null

-- ---------- DISTRIBUTION & REPORTS ----------
union all
select 60, 'Distribution', 'Dispatches to schools', 'INFO',
       count(*) || ' total, ' || count(*) filter (where status = 'in_transit') || ' in transit, '
       || count(*) filter (where status = 'cancelled') || ' cancelled'
from food_distribution
union all
select 61, 'Distribution', 'Deliveries arrived in full',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' deliveries received short, '
       || coalesce(sum(quantity_dispatched - quantity_received), 0) || ' units missing in all'
from food_distribution where status = 'received' and quantity_received < quantity_dispatched
union all
select 63, 'Distribution', 'Deliveries in transit for over a week',
       case when count(*) = 0 then 'OK' else 'WARN' end,
       count(*) || ' dispatches not yet confirmed by the school'
from food_distribution where status = 'in_transit' and dispatch_date < current_date - 7
union all
select 64, 'Distribution', 'Every received delivery added stock',
       case when count(*) = 0 then 'OK' else 'FAIL' end,
       count(*) || ' received deliveries with no stock movement'
from food_distribution d
where d.status = 'received' and d.quantity_received > 0
  and not exists (select 1 from inventory_transactions t where t.distribution_id = d.distribution_id)
union all
select 62, 'Reports', 'Saved reports', 'INFO', count(*) || ' rows (export not built yet, #1)'
from reports

order by n, check_name;
