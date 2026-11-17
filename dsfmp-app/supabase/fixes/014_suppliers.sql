-- ============================================================
-- Fix 014: suppliers register, and each school approves its own
--
-- A food supplier creates an account in the app ("I'm a supplier"),
-- fills in a business profile, picks the foods it supplies and
-- uploads its documents (business permit, KRA PIN certificate,
-- KEBS or health certificates). There is no central verification:
-- each school decides which suppliers it works with.
--
--   * Role 'supplier': a login with a supplier profile and no school.
--   * suppliers / supplier_foods / supplier_documents: the profile,
--     the foods from the shared food list, and the documents, kept
--     in the private Storage bucket 'supplier-documents' under
--     <supplier_id>/.
--   * school_suppliers: one row per school and supplier. Either side
--     can start it: a supplier asks to supply a school ('requested'),
--     or the headteacher approves a supplier from the directory
--     straight away. Only the headteacher approves, declines or
--     removes; coordinators with the 'view_procurement' permission
--     can look.
--   * Any school's headteacher (or coordinator with 'view_procurement')
--     can browse suppliers and read their profiles and documents, so
--     they can check a supplier before approving it. Suppliers see a
--     list of schools (name, county, town) and nothing else of them.
--
-- Orders and automatic reorders come in a later fix.
--
-- Run it once, after fix 013. It is safe to run again.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Roles: suppliers have no school
-- ------------------------------------------------------------
alter table users drop constraint if exists users_role_check;
alter table users drop constraint if exists users_role_school_check;
alter table users add constraint users_role_check
  check (role in ('headteacher', 'coordinator', 'supplier'));
-- School roles belong to exactly one school; suppliers and new logins to none.
alter table users add constraint users_role_school_check
  check ((coalesce(role, '') in ('headteacher', 'coordinator')) = (school_id is not null));

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------
create table if not exists suppliers (
  supplier_id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(user_id) on delete cascade,
  business_name text not null,
  contact_name text not null,
  phone text not null,
  email text,
  county text,
  areas_served text,
  kra_pin text not null,
  registration_no text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists supplier_foods (
  supplier_id uuid not null references suppliers(supplier_id) on delete cascade,
  food_id uuid not null references food_items(food_id) on delete cascade,
  primary key (supplier_id, food_id)
);

create table if not exists supplier_documents (
  document_id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(supplier_id) on delete cascade,
  doc_type text not null check (doc_type in
    ('business_permit', 'kra_pin', 'registration', 'kebs', 'health', 'other')),
  title text,
  file_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_at timestamptz not null default now()
);

create table if not exists school_suppliers (
  school_id uuid not null references schools(school_id) on delete cascade,
  supplier_id uuid not null references suppliers(supplier_id) on delete cascade,
  status text not null check (status in ('requested', 'approved', 'declined', 'removed')),
  -- Who started it: the supplier asked, or the school approved it directly.
  requested_by text not null check (requested_by in ('supplier', 'school')),
  message text,          -- the supplier's note with its request
  decision_note text,    -- the headteacher's note when declining or removing
  decided_by uuid references users(user_id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (school_id, supplier_id)
);
create index if not exists school_suppliers_supplier_idx on school_suppliers (supplier_id);

-- ------------------------------------------------------------
-- Who is who
-- ------------------------------------------------------------

-- The signed-in supplier's profile ID (null for everyone else).
create or replace function public.my_supplier_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select s.supplier_id from suppliers s join users u on u.user_id = s.user_id
  where s.user_id = auth.uid() and u.status = 'active' and u.role = 'supplier'
    and public.session_verified();
$$;

-- May the current user look at suppliers? A school's headteacher, or a
-- coordinator its school allows to see orders.
create or replace function public.can_review_suppliers()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from users u
    where u.user_id = auth.uid() and u.school_id is not null
      and public.has_school_permission(u.school_id, 'view_procurement'));
$$;

-- The school whose suppliers the current user may approve (its headteacher).
create or replace function public.my_headteacher_school()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select u.school_id from users u
  where u.user_id = auth.uid() and u.school_id is not null
    and public.has_school_role(u.school_id, array['headteacher']);
$$;

revoke all on function public.my_supplier_id() from public;
revoke all on function public.can_review_suppliers() from public;
revoke all on function public.my_headteacher_school() from public;
grant execute on function public.my_supplier_id() to authenticated;
grant execute on function public.can_review_suppliers() to authenticated;
grant execute on function public.my_headteacher_school() to authenticated;

-- ------------------------------------------------------------
-- Row level security: reads only; changes go through the functions
-- below (documents are added by the supplier directly).
-- ------------------------------------------------------------
alter table suppliers enable row level security;
alter table supplier_foods enable row level security;
alter table supplier_documents enable row level security;
alter table school_suppliers enable row level security;

drop policy if exists "Suppliers read their profile and schools read suppliers" on suppliers;
create policy "Suppliers read their profile and schools read suppliers"
  on suppliers for select
  using (supplier_id = public.my_supplier_id() or public.can_review_suppliers());

drop policy if exists "Suppliers and schools read supplier foods" on supplier_foods;
create policy "Suppliers and schools read supplier foods"
  on supplier_foods for select
  using (supplier_id = public.my_supplier_id() or public.can_review_suppliers());

drop policy if exists "Suppliers and schools read supplier documents" on supplier_documents;
create policy "Suppliers and schools read supplier documents"
  on supplier_documents for select
  using (supplier_id = public.my_supplier_id() or public.can_review_suppliers());

drop policy if exists "Suppliers and schools read their links" on school_suppliers;
create policy "Suppliers and schools read their links"
  on school_suppliers for select
  using (supplier_id = public.my_supplier_id()
         or public.has_school_permission(school_id, 'view_procurement'));

revoke insert, update, delete on suppliers, supplier_foods, supplier_documents, school_suppliers
  from anon, authenticated;
grant select on suppliers, supplier_foods, supplier_documents, school_suppliers to authenticated;

-- ------------------------------------------------------------
-- The supplier's profile
-- ------------------------------------------------------------

-- Checks and tidies the profile fields; raises a readable error.
create or replace function public.clean_supplier_fields(
  p_business_name text, p_contact_name text, p_phone text, p_kra_pin text)
returns text language plpgsql immutable as $$
declare
  v_pin text := upper(regexp_replace(coalesce(p_kra_pin, ''), '\s', '', 'g'));
begin
  if coalesce(btrim(p_business_name), '') = '' then
    raise exception 'Enter the business name' using errcode = '22023';
  end if;
  if coalesce(btrim(p_contact_name), '') = '' then
    raise exception 'Enter the contact person''s name' using errcode = '22023';
  end if;
  if regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') !~ '^[0-9]{9,13}$' then
    raise exception 'Enter a phone number, e.g. 0712 345 678' using errcode = '22023';
  end if;
  -- A KRA PIN is a letter, 9 digits and a letter, e.g. A012345678Z.
  if v_pin !~ '^[A-Z][0-9]{9}[A-Z]$' then
    raise exception 'Enter a valid KRA PIN: a letter, 9 digits and a letter (e.g. A012345678Z)'
      using errcode = '22023';
  end if;
  return v_pin;
end;
$$;

-- A new account with no school becomes a supplier. Once per account.
create or replace function public.create_my_supplier(
  p_business_name text, p_contact_name text, p_phone text, p_kra_pin text,
  p_email text default null, p_county text default null, p_areas_served text default null,
  p_registration_no text default null, p_description text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user users%rowtype;
  v_pin text;
  v_supplier_id uuid;
begin
  if auth.uid() is null or not public.session_verified() then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into v_user from users where user_id = auth.uid() for update;
  if not found or v_user.status <> 'active' then
    raise exception 'This account is not active' using errcode = '42501';
  end if;
  if v_user.role = 'supplier' then
    raise exception 'This account already has a supplier profile' using errcode = '22023';
  end if;
  if v_user.role is not null or v_user.school_id is not null then
    raise exception 'This account belongs to a school. Use another email for the supplier account.'
      using errcode = '22023';
  end if;
  v_pin := public.clean_supplier_fields(p_business_name, p_contact_name, p_phone, p_kra_pin);

  insert into suppliers (user_id, business_name, contact_name, phone, email, county,
                         areas_served, kra_pin, registration_no, description)
  values (auth.uid(), btrim(p_business_name), btrim(p_contact_name), btrim(p_phone),
          nullif(btrim(p_email), ''), nullif(btrim(p_county), ''), nullif(btrim(p_areas_served), ''),
          v_pin, nullif(btrim(p_registration_no), ''), nullif(btrim(p_description), ''))
  returning supplier_id into v_supplier_id;

  update users set role = 'supplier', full_name = btrim(p_contact_name) where user_id = auth.uid();
  return v_supplier_id;
end;
$$;

create or replace function public.update_my_supplier(
  p_business_name text, p_contact_name text, p_phone text, p_kra_pin text,
  p_email text default null, p_county text default null, p_areas_served text default null,
  p_registration_no text default null, p_description text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_supplier_id uuid := public.my_supplier_id();
  v_pin text;
begin
  if v_supplier_id is null then
    raise exception 'Only a supplier can do this' using errcode = '42501';
  end if;
  v_pin := public.clean_supplier_fields(p_business_name, p_contact_name, p_phone, p_kra_pin);
  update suppliers
    set business_name = btrim(p_business_name), contact_name = btrim(p_contact_name),
        phone = btrim(p_phone), email = nullif(btrim(p_email), ''),
        county = nullif(btrim(p_county), ''), areas_served = nullif(btrim(p_areas_served), ''),
        kra_pin = v_pin, registration_no = nullif(btrim(p_registration_no), ''),
        description = nullif(btrim(p_description), ''), updated_at = now()
    where supplier_id = v_supplier_id;
  update users set full_name = btrim(p_contact_name) where user_id = auth.uid();
end;
$$;

-- The foods the supplier offers, from the shared food list.
create or replace function public.set_my_supplier_foods(p_food_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_supplier_id uuid := public.my_supplier_id();
begin
  if v_supplier_id is null then
    raise exception 'Only a supplier can do this' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(coalesce(p_food_ids, '{}')) f(id)
             where not exists (select 1 from food_items where food_id = f.id and school_id is null)) then
    raise exception 'That food isn''t on the food list' using errcode = 'P0002';
  end if;
  delete from supplier_foods
    where supplier_id = v_supplier_id and food_id <> all (coalesce(p_food_ids, '{}'));
  insert into supplier_foods (supplier_id, food_id)
    select distinct v_supplier_id, id from unnest(coalesce(p_food_ids, '{}')) as id
    on conflict do nothing;
  update suppliers set updated_at = now() where supplier_id = v_supplier_id;
end;
$$;

-- ------------------------------------------------------------
-- Documents: the app uploads the file to Storage at
-- supplier-documents/<supplier_id>/<name>, then records it here.
-- ------------------------------------------------------------
create or replace function public.add_supplier_document(
  p_doc_type text, p_file_path text, p_file_name text,
  p_title text default null, p_mime_type text default null, p_size_bytes bigint default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_supplier_id uuid := public.my_supplier_id();
  v_document_id uuid;
begin
  if v_supplier_id is null then
    raise exception 'Only a supplier can do this' using errcode = '42501';
  end if;
  if p_doc_type is null or p_doc_type not in
     ('business_permit', 'kra_pin', 'registration', 'kebs', 'health', 'other') then
    raise exception 'Unknown document type %', p_doc_type using errcode = '22023';
  end if;
  if p_doc_type = 'other' and coalesce(btrim(p_title), '') = '' then
    raise exception 'Say what the document is' using errcode = '22023';
  end if;
  if p_file_path is null or split_part(p_file_path, '/', 1) <> v_supplier_id::text
     or p_file_path like '%..%' then
    raise exception 'The file must be in your own folder' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects
                 where bucket_id = 'supplier-documents' and name = p_file_path) then
    raise exception 'The file wasn''t uploaded. Try again.' using errcode = 'P0002';
  end if;
  if (select count(*) from supplier_documents where supplier_id = v_supplier_id) >= 20 then
    raise exception 'You can keep up to 20 documents. Remove an old one first.' using errcode = '22023';
  end if;

  insert into supplier_documents (supplier_id, doc_type, title, file_path, file_name, mime_type, size_bytes)
  values (v_supplier_id, p_doc_type, nullif(btrim(p_title), ''), p_file_path,
          coalesce(nullif(btrim(p_file_name), ''), 'document'), p_mime_type, p_size_bytes)
  returning document_id into v_document_id;
  return v_document_id;
end;
$$;

-- Forgets a document and returns its file path, which the app then
-- deletes from Storage (Supabase doesn't allow deleting files in SQL).
create or replace function public.remove_supplier_document(p_document_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_path text;
begin
  delete from supplier_documents
    where document_id = p_document_id and supplier_id = public.my_supplier_id()
    returning file_path into v_path;
  if v_path is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  return v_path;
end;
$$;

-- ------------------------------------------------------------
-- The supplier's side: schools to supply
-- ------------------------------------------------------------

-- Every active school, with where this supplier stands with it.
create or replace function public.supplier_school_directory()
returns table (school_id uuid, name text, county text, location text,
               status text, requested_by text, message text, decision_note text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_supplier_id uuid := public.my_supplier_id();
begin
  if v_supplier_id is null then
    raise exception 'Only a supplier can do this' using errcode = '42501';
  end if;
  return query
    select s.school_id, s.name, s.county, s.location,
           l.status, l.requested_by, l.message, l.decision_note, l.updated_at
    from schools s
    left join school_suppliers l on l.school_id = s.school_id and l.supplier_id = v_supplier_id
    where s.status = 'active'
    order by s.name;
end;
$$;

-- Ask to supply a school (again, after a decline or removal).
create or replace function public.request_to_supply(p_school_id uuid, p_message text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_supplier_id uuid := public.my_supplier_id();
  v_status text;
begin
  if v_supplier_id is null then
    raise exception 'Only a supplier can do this' using errcode = '42501';
  end if;
  if not exists (select 1 from schools where school_id = p_school_id and status = 'active') then
    raise exception 'School not found' using errcode = 'P0002';
  end if;
  select status into v_status from school_suppliers
    where school_id = p_school_id and supplier_id = v_supplier_id for update;
  if v_status = 'approved' then
    raise exception 'This school has already approved you' using errcode = '22023';
  end if;

  insert into school_suppliers (school_id, supplier_id, status, requested_by, message)
  values (p_school_id, v_supplier_id, 'requested', 'supplier', nullif(btrim(p_message), ''))
  on conflict (school_id, supplier_id) do update
    set status = 'requested', requested_by = 'supplier', message = excluded.message,
        decision_note = null, decided_by = null, decided_at = null, updated_at = now();
end;
$$;

-- Withdraw a request, or stop supplying a school that approved you.
create or replace function public.withdraw_from_school(p_school_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_supplier_id uuid := public.my_supplier_id();
  v_status text;
begin
  if v_supplier_id is null then
    raise exception 'Only a supplier can do this' using errcode = '42501';
  end if;
  select status into v_status from school_suppliers
    where school_id = p_school_id and supplier_id = v_supplier_id for update;
  if v_status = 'requested' then
    delete from school_suppliers where school_id = p_school_id and supplier_id = v_supplier_id;
  elsif v_status = 'approved' then
    update school_suppliers
      set status = 'removed', decision_note = 'The supplier stopped supplying this school',
          decided_by = auth.uid(), decided_at = now(), updated_at = now()
      where school_id = p_school_id and supplier_id = v_supplier_id;
  else
    raise exception 'There is no request or approval to withdraw' using errcode = '22023';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- The school's side
-- ------------------------------------------------------------

-- Every supplier, with its foods and where it stands with the user's school.
create or replace function public.school_supplier_directory()
returns table (supplier_id uuid, business_name text, contact_name text, phone text, email text,
               county text, areas_served text, kra_pin text, registration_no text, description text,
               foods text[], document_count int, status text, requested_by text, message text,
               decision_note text, updated_at timestamptz, registered_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid;
begin
  select school_id into v_school_id from users where user_id = auth.uid();
  if v_school_id is null or not public.has_school_permission(v_school_id, 'view_procurement') then
    raise exception 'You don''t have permission to see suppliers' using errcode = '42501';
  end if;
  return query
    select s.supplier_id, s.business_name, s.contact_name, s.phone, s.email, s.county,
           s.areas_served, s.kra_pin, s.registration_no, s.description,
           coalesce((select array_agg(f.item_name order by f.item_name)
                     from supplier_foods sf join food_items f on f.food_id = sf.food_id
                     where sf.supplier_id = s.supplier_id), '{}'),
           (select count(*)::int from supplier_documents d where d.supplier_id = s.supplier_id),
           l.status, l.requested_by, l.message, l.decision_note, l.updated_at, s.created_at
    from suppliers s
    join users u on u.user_id = s.user_id and u.status = 'active'
    left join school_suppliers l on l.supplier_id = s.supplier_id and l.school_id = v_school_id
    order by s.business_name;
end;
$$;

-- The headteacher approves, declines (a request) or removes (an
-- approved supplier). Approving works with or without a request.
create or replace function public.set_school_supplier(
  p_supplier_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_school_id uuid := public.my_headteacher_school();
  v_current text;
begin
  if v_school_id is null then
    raise exception 'Only the headteacher can choose suppliers' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('approved', 'declined', 'removed') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  if not exists (select 1 from suppliers s join users u on u.user_id = s.user_id
                 where s.supplier_id = p_supplier_id and u.status = 'active') then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  select status into v_current from school_suppliers
    where school_id = v_school_id and supplier_id = p_supplier_id for update;

  if p_status = 'declined' and v_current is distinct from 'requested' then
    raise exception 'Only a request can be declined' using errcode = '22023';
  end if;
  if p_status = 'removed' and v_current is distinct from 'approved' then
    raise exception 'Only an approved supplier can be removed' using errcode = '22023';
  end if;
  if p_status = 'approved' and v_current = 'approved' then
    return;
  end if;

  insert into school_suppliers (school_id, supplier_id, status, requested_by,
                                decision_note, decided_by, decided_at)
  values (v_school_id, p_supplier_id, p_status, 'school',
          nullif(btrim(p_note), ''), auth.uid(), now())
  on conflict (school_id, supplier_id) do update
    set status = excluded.status, decision_note = excluded.decision_note,
        decided_by = excluded.decided_by, decided_at = excluded.decided_at, updated_at = now();
end;
$$;

revoke all on function public.clean_supplier_fields(text, text, text, text) from public;
revoke all on function public.create_my_supplier(text, text, text, text, text, text, text, text, text) from public;
revoke all on function public.update_my_supplier(text, text, text, text, text, text, text, text, text) from public;
revoke all on function public.set_my_supplier_foods(uuid[]) from public;
revoke all on function public.add_supplier_document(text, text, text, text, text, bigint) from public;
revoke all on function public.remove_supplier_document(uuid) from public;
revoke all on function public.supplier_school_directory() from public;
revoke all on function public.request_to_supply(uuid, text) from public;
revoke all on function public.withdraw_from_school(uuid) from public;
revoke all on function public.school_supplier_directory() from public;
revoke all on function public.set_school_supplier(uuid, text, text) from public;
grant execute on function public.create_my_supplier(text, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.update_my_supplier(text, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.set_my_supplier_foods(uuid[]) to authenticated;
grant execute on function public.add_supplier_document(text, text, text, text, text, bigint) to authenticated;
grant execute on function public.remove_supplier_document(uuid) to authenticated;
grant execute on function public.supplier_school_directory() to authenticated;
grant execute on function public.request_to_supply(uuid, text) to authenticated;
grant execute on function public.withdraw_from_school(uuid) to authenticated;
grant execute on function public.school_supplier_directory() to authenticated;
grant execute on function public.set_school_supplier(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- Storage: a private bucket for the documents (PDF or photo, up to
-- 10 MB). A supplier writes only in its own folder; schools that
-- may review suppliers can read.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('supplier-documents', 'supplier-documents', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Suppliers upload their documents" on storage.objects;
create policy "Suppliers upload their documents"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'supplier-documents'
              and (storage.foldername(name))[1] = public.my_supplier_id()::text);

drop policy if exists "Suppliers and schools read supplier documents" on storage.objects;
create policy "Suppliers and schools read supplier documents"
  on storage.objects for select to authenticated
  using (bucket_id = 'supplier-documents'
         and ((storage.foldername(name))[1] = public.my_supplier_id()::text
              or public.can_review_suppliers()));

drop policy if exists "Suppliers delete their documents" on storage.objects;
create policy "Suppliers delete their documents"
  on storage.objects for delete to authenticated
  using (bucket_id = 'supplier-documents'
         and (storage.foldername(name))[1] = public.my_supplier_id()::text);

commit;

-- How many suppliers there are (shown in the results panel).
select (select count(*) from suppliers) as suppliers,
       (select count(*) from school_suppliers where status = 'approved') as approved_links;
