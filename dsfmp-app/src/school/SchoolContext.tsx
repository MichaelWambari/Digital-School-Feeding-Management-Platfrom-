import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { PressableScale } from '../components/Motion';
import ChangePasswordScreen from '../screens/ChangePasswordScreen';

export type Role = 'platform_admin' | 'headteacher' | 'coordinator' | 'inventory_officer' | 'staff';
export type SchoolRole = Exclude<Role, 'platform_admin'>;

export const ROLE_LABELS: Record<Role, string> = {
  platform_admin: 'Platform admin',
  headteacher: 'Headteacher',
  coordinator: 'Feeding coordinator',
  inventory_officer: 'Inventory officer',
  staff: 'Staff',
};

// What a school lets each role do (school_role_permissions, fix 009).
// The headteacher can do all of these and more.
export type Permission =
  | 'view_students'
  | 'manage_students'
  | 'record_attendance'
  | 'view_attendance'
  | 'manage_meals'
  | 'view_nutrition'
  | 'view_inventory'
  | 'verify_deliveries'
  | 'stock_counts'
  | 'view_procurement'
  | 'view_reports';

export const PERMISSIONS: { key: Permission; label: string; description: string }[] = [
  { key: 'view_students', label: 'See students', description: 'The student list' },
  { key: 'manage_students', label: 'Manage students', description: 'Add and edit students and their NFC tags' },
  { key: 'record_attendance', label: 'Record attendance', description: 'Mark students present by hand' },
  { key: 'view_attendance', label: 'See attendance', description: 'Who attended each meal' },
  { key: 'manage_meals', label: 'Manage meals', description: 'Timetable, recipes and nutrition values' },
  { key: 'view_nutrition', label: 'See nutrition', description: "Students' estimated nutrition" },
  { key: 'view_inventory', label: 'See inventory', description: 'Stock levels and movements' },
  { key: 'verify_deliveries', label: 'Confirm deliveries', description: 'Record the amount of food that arrived' },
  { key: 'stock_counts', label: 'Stock counts', description: 'Enter physical stock counts' },
  { key: 'view_procurement', label: 'See orders', description: 'Reorder requests, quotations and orders' },
  { key: 'view_reports', label: 'See reports', description: 'Attendance, food and stock reports' },
];

export type Profile = {
  user_id: string;
  full_name: string;
  role: Role | null;
  school_id: string | null;
  status: 'active' | 'suspended';
  must_change_password: boolean;
};

export type School = {
  school_id: string;
  name: string;
  location: string | null;
  county: string | null;
  phone: string | null;
  email: string | null;
  registration_no: string | null;
  timezone: string;
  status: 'active' | 'suspended';
};

type AccountValue = {
  profile: Profile;
  // The user's school; null for the platform admin.
  school: School | null;
  permissions: Permission[];
  reload: () => Promise<void>;
};

const AccountContext = createContext<AccountValue | null>(null);

// Loads the signed-in user's profile, school and permissions, and only
// renders the app once the account can be used.
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [school, setSchool] = useState<School | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { data: loaded, error: profileError } = await supabase
        .from('users')
        .select('user_id, full_name, role, school_id, status, must_change_password')
        .eq('user_id', auth.user?.id ?? '')
        .maybeSingle();
      if (profileError) {
        // 42703: fix 009 isn't installed yet (no must_change_password column).
        throw new Error(
          profileError.code === '42703'
            ? 'The database needs updating. Run supabase/fixes/009_independent_schools.sql.'
            : profileError.message
        );
      }
      if (!loaded) throw new Error('No profile was found for this login.');

      let loadedSchool: School | null = null;
      let loadedPermissions: Permission[] = [];
      if (loaded.school_id) {
        const [schoolResult, permissionResult] = await Promise.all([
          supabase
            .from('schools')
            .select('school_id, name, location, county, phone, email, registration_no, timezone, status')
            .eq('school_id', loaded.school_id)
            .maybeSingle(),
          supabase.rpc('my_permissions'),
        ]);
        const loadError = schoolResult.error ?? permissionResult.error;
        if (loadError) throw new Error(loadError.message);
        loadedSchool = schoolResult.data as School | null;
        loadedPermissions = (permissionResult.data ?? []) as Permission[];
      }
      setProfile(loaded as Profile);
      setSchool(loadedSchool);
      setPermissions(loadedPermissions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to connect. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usable =
    profile &&
    profile.status === 'active' &&
    (profile.role === 'platform_admin' || (profile.role && school?.status === 'active'));

  const value = useMemo<AccountValue | null>(
    () => (usable && profile ? { profile, school, permissions, reload: load } : null),
    [usable, profile, school, permissions, load]
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // A login made by someone else must choose its own password first.
  if (profile?.must_change_password && profile.status === 'active') {
    return <ChangePasswordScreen onChanged={load} />;
  }

  if (!value) {
    const message = error
      ? `Could not load your account: ${error}`
      : profile?.status === 'suspended'
      ? 'Your account is suspended. Ask your headteacher to restore it.'
      : school?.status === 'suspended'
      ? `${school.name}'s account is suspended. Contact the platform administrator.`
      : "Your login isn't linked to a school yet. Ask your headteacher to add you as staff.";
    return (
      <View style={styles.center}>
        <Text style={styles.message}>{message}</Text>
        <PressableScale style={styles.button} onPress={load}>
          <Text style={styles.buttonText}>Try again</Text>
        </PressableScale>
        <PressableScale onPress={() => supabase.auth.signOut()}>
          <Text style={styles.logout}>Logout</Text>
        </PressableScale>
      </View>
    );
  }

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used inside AccountProvider');
  return value;
}

// For school screens: the user's school and what they may do there.
export function useSchool() {
  const { profile, school, permissions, reload } = useAccount();
  if (!school) throw new Error('useSchool is only for school staff');
  const can = (permission: Permission) => permissions.includes(permission);
  return { profile, school, permissions, can, isHeadteacher: profile.role === 'headteacher', reload };
}

const makeStyles = (c: Colors) => StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: c.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: { fontSize: 15, color: c.text, textAlign: 'center', marginBottom: 20 },
  button: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  buttonText: { color: c.onPrimary, fontSize: 15, fontWeight: '600' },
  logout: { color: c.danger, fontSize: 14 },
});
