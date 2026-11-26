import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Set in .env.local (copy .env.example): Supabase Dashboard > Project
// Settings > API. Expo puts EXPO_PUBLIC_* values into the app at build time.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Supabase is not configured: copy .env.example to .env.local, fill in ' +
      'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, and restart Expo.',
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // Google sign-in returns a one-time code (PKCE). On the web the page
    // itself is redirected back, so the client reads the code from the URL;
    // on phones LoginScreen exchanges it.
    flowType: 'pkce',
    detectSessionInUrl: Platform.OS === 'web',
  },
});
