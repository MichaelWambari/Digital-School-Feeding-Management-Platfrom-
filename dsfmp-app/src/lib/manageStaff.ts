import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Calls the manage-staff Edge Function (creating logins, resetting
// passwords, onboarding schools). Returns its reply, or an error message
// that covers the common set-up problems.
export async function invokeManageStaff<T = Record<string, unknown>>(
  body: Record<string, unknown>
): Promise<{ data: T | null; error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('manage-staff', { body });
    if (error) return { data: null, error: await describeFunctionError(error) };
    return { data: data as T, error: null };
  } catch {
    return { data: null, error: 'Unable to connect. Check your connection and try again.' };
  }
}

async function describeFunctionError(error: unknown) {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    if (response.status === 404) {
      return 'The manage-staff function is not deployed yet. See "Staff accounts" in the README.';
    }
    const body = await response.json().catch(() => null);
    if (body?.error) return String(body.error);
    if (response.status === 401) {
      return 'Supabase rejected your login for manage-staff. Turn off "Verify JWT" for the function (it checks the login itself), or sign out and in again.';
    }
    return body?.message ?? error.message;
  }
  if (error instanceof FunctionsFetchError) {
    return 'Could not reach the manage-staff function. Check your connection and that the function is deployed.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
