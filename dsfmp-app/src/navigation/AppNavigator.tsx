import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useTheme } from '../theme/ThemeContext';
import { SchoolProvider } from '../school/SchoolContext';
import { FadeIn } from '../components/Motion';

import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import StudentsScreen from '../screens/StudentsScreen';
import AttendanceScreen from '../screens/AttendanceScreen';
import InventoryScreen from '../screens/InventoryScreen';
import DistributionScreen from '../screens/DistributionScreen';
import ReportsScreen from '../screens/ReportsScreen';
import StaffScreen from '../screens/StaffScreen';
import VerifyCodeScreen from '../screens/VerifyCodeScreen';

const Stack = createNativeStackNavigator();

// The login session's ID from its access token. It stays the same when the
// token is refreshed, so the sign-in code is checked once per sign-in.
function loginSessionId(session: Session) {
  try {
    const payload = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).session_id);
  } catch {
    return session.user.id;
  }
}

export default function AppNavigator() {
  const { scheme, colors } = useTheme();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Whether this login has finished the emailed-code step (Google logins have).
  const [verified, setVerified] = useState<{ loginId: string; ok: boolean } | null>(null);
  const loginId = session ? loginSessionId(session) : null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!loginId) return;
    let cancelled = false;
    supabase.rpc('session_verified').then(({ data, error }) => {
      if (cancelled) return;
      // PGRST202: fix 006 isn't installed yet, so there is no code step.
      setVerified({ loginId, ok: error ? error.code === 'PGRST202' : data === true });
    });
    return () => {
      cancelled = true;
    };
  }, [loginId]);

  if (loading) return null; // swap for a splash screen if you like

  const isVerified = loginId && verified?.loginId === loginId ? verified.ok : null;
  if (session && loginId && isVerified === null) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (session && loginId && isVerified === false) {
    return (
      <KeyboardAvoidingView style={styles.fill} behavior="padding" enabled={Platform.OS !== 'web'}>
        <VerifyCodeScreen onVerified={() => setVerified({ loginId, ok: true })} />
      </KeyboardAvoidingView>
    );
  }

  // Match the navigator's backdrop to the theme so screen transitions don't flash white.
  const baseTheme = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...baseTheme,
    colors: { ...baseTheme.colors, background: colors.background, primary: colors.primary },
  };

  // Screens slide in on phones; the web has no native transitions, so each
  // screen fades in instead. The keyboard view lifts screens above the
  // on-screen keyboard so the field being typed in stays visible.
  const navigator = (
    <KeyboardAvoidingView style={styles.fill} behavior="padding" enabled={Platform.OS !== 'web'}>
      <NavigationContainer theme={navigationTheme}>
        <Stack.Navigator
          screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
          screenLayout={
            Platform.OS === 'web'
              ? ({ children }) => <FadeIn style={styles.fill}>{children}</FadeIn>
              : undefined
          }
        >
          {session ? (
            <>
              <Stack.Screen name="Dashboard" component={DashboardScreen} />
              <Stack.Screen name="Students" component={StudentsScreen} />
              <Stack.Screen name="Attendance" component={AttendanceScreen} />
              <Stack.Screen name="Inventory" component={InventoryScreen} />
              <Stack.Screen name="Distribution" component={DistributionScreen} />
              <Stack.Screen name="Reports" component={ReportsScreen} />
              <Stack.Screen name="Staff" component={StaffScreen} />
            </>
          ) : (
            <Stack.Screen name="Login" component={LoginScreen} />
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </KeyboardAvoidingView>
  );

  // Signed-in screens all work on one school; keyed by user so a new login reloads it.
  return session ? (
    <SchoolProvider key={session.user.id}>{navigator}</SchoolProvider>
  ) : (
    navigator
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
