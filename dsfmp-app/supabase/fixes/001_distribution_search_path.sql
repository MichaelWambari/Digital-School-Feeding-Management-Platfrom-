-- ============================================================
-- Fix 001: pin search_path on log_distribution_as_transaction()
--
-- This SECURITY DEFINER trigger function was missing
-- "set search_path", so it could resolve inventory_transactions
-- against a lookalike table earlier on the caller's search path.
-- This matches the other SECURITY DEFINER functions in schema.sql.
--
-- Safe to run on a live database: it replaces the function in
-- place, keeps the existing trigger attached, and touches no data.
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

create or replace function public.log_distribution_as_transaction()
returns trigger as $$
begin
  insert into inventory_transactions (item_id, transaction_type, quantity, recorded_by)
  values (new.item_id, 'used', coalesce(new.quantity_issued, 0), new.recorded_by);
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
