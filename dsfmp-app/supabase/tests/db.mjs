// Local test database: PGlite with stub Supabase auth/storage schemas.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
// Run from the app folder: npm install --no-save @electric-sql/pglite && node supabase/tests/table_5_8.mjs
import { fileURLToPath } from 'node:url';
const APP = process.env.DSFMP_SUPABASE ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
export const read = (p) => fs.readFileSync(`${APP}/${p}`, 'utf8');

const STUBS = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text,
  raw_user_meta_data jsonb default '{}', last_sign_in_at timestamptz, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
create function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
`;

export async function freshDb(upTo = 13) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(read('schema.sql').replace(/create extension[^;]*;/gi, ''));
  const fixes = fs.readdirSync(`${APP}/fixes`).filter((f) => {
    const n = Number(f.slice(0, 3));
    return n >= 9 && n <= upTo;
  }).sort();
  for (const f of fixes) await db.exec(read(`fixes/${f}`));
  return db;
}

// Run as a signed-in user (with RLS) or as the system (null).
export async function as(db, uid, fn) {
  if (uid) {
    await db.exec(`set test.uid = '${uid}'; set test.jwt = '{"amr":[{"method":"oauth"}]}'; set role authenticated;`);
  } else {
    await db.exec(`reset role; set test.uid = '';`);
  }
  try { return await fn(); } finally { await db.exec(`reset role; set test.uid = '';`); }
}

export async function newUser(db, email, fullName) {
  const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
    [email, JSON.stringify({ full_name: fullName })]);
  return r.rows[0].id;
}
