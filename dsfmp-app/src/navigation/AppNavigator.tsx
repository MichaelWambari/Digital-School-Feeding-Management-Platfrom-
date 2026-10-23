import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
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

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const { scheme, colors } = useTheme();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) return null; // swap for a splash screen if you like

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
});
