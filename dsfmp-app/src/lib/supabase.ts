import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Get these from: Supabase Dashboard > Project Settings > API
const SUPABASE_URL = 'https://ziecvzfwwtutxliivddn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_iVEdMjk-a1XgLcUjTY8jRA_oa0jawwK';

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
