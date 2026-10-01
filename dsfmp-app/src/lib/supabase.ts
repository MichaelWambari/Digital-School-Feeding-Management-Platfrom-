import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Get these from: Supabase Dashboard > Project Settings > API
const SUPABASE_URL = 'https://ziecvzfwwtutxliivddn.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'sb_publishable_iVEdMjk-a1XgLcUjTY8jRA_oa0jawwK';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
