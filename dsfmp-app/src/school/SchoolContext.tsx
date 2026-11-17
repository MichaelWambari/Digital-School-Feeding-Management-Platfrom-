import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { PressableScale } from '../components/Motion';
import ChangePasswordScreen from '../screens/ChangePasswordScreen';
import CreateSchoolScreen from '../screens/CreateSchoolScreen';
import CreateSupplierScreen from '../screens/CreateSupplierScreen';
import { Supplier, describeSupplierError } from '../lib/suppliers';

// The headteacher runs the school; the coordinator, whom the headteacher
// adds, runs students, attendance, the timetable and inventory.
export type Role = 'headteacher' | 'coordinator';
export type SchoolRole = Role;

export const ROLE_LABELS: Record<Role, string> = {
  headteacher: 'Headteacher',
  coordinator: 'Coordinator',
};

// What a school lets the coordinator do (school_role_permissions). All of
// them by default; the headteacher can turn some off. The headteacher can
// do all of these and more.
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
  { key: 'view_procurement', label: 'See suppliers and orders', description: 'Suppliers, reorder requests and orders' },
  { key: 'view_reports', label: 'See reports', description: 'Attendance, food and stock reports' },
];

// A login is school staff (headteacher or coordinator), a food supplier,
// or (role null) a new account that hasn't been set up yet.
export type Profile = {
  user_id: string;
  full_name: string;
  role: Role | 'supplier' | null;
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

export type SchoolProfile = Profile & { role: Role };
export type AccountKind = 'school' | 'supplier';

type AccountValue =
  | {
      kind: 'school';
      profile: SchoolProfile;
      school: School;
      permissions: Permission[];
      reload: () => Promise<void>;
    }
  | {
      kind: 'supplier';
      profile: Profile;
      supplier: Supplier;
      reload: () => Promise<void>;
    };

const AccountContext = createContext<AccountValue | null>(null);

// Loads the signed-in user's profile and their school (with permissions)
// or supplier profile, and only renders the app once the account can be
// used. The app's screens depend on which kind of account it is.
export function AccountProvider({ children }: { children: (kind: AccountKind) => React.ReactNode }) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [school, setSchool] = useState<School | null>(null);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // For a new account: which set-up screen to show, and the email to suggest.
  const [setupKind, setSetupKind] = useState<AccountKind>('school');
  const [email, setEmail] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (!auth.user) {
        // The saved sign-in belongs to an account that no longer exists
        // (e.g. it was deleted): sign out, which shows the login page.
        if (authError && authError.status !== undefined && authError.status < 500) {
          await supabase.auth.signOut();
          return;
        }
        throw new Error(authError?.message ?? 'Unable to connect. Check your connection and try again.');
      }
      const { data: loaded, error: profileError } = await supabase
        .from('users')
        .select('user_id, full_name, role, school_id, status, must_change_password')
        .eq('user_id', auth.user.id)
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

      let loadedSupplier: Supplier | null = null;
      if (loaded.role === 'supplier') {
        const { data, error: supplierError } = await supabase
          .from('suppliers')
          .select('*')
          .eq('user_id', auth.user.id)
          .maybeSingle();
        if (supplierError) throw new Error(describeSupplierError(supplierError));
        loadedSupplier = data as Supplier | null;
      }

      // Sign-up records which kind of account was chosen.
      setSetupKind(auth.user.user_metadata?.account_type === 'supplier' ? 'supplier' : 'school');
      setEmail(auth.user.email ?? '');
      setProfile(loaded as Profile);
      setSchool(loadedSchool);
      setSupplier(loadedSupplier);
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

  const value = useMemo<AccountValue | null>(() => {
    if (!profile || profile.status !== 'active') return null;
    if (profile.role === 'supplier') {
      return supplier ? { kind: 'supplier', profile, supplier, reload: load } : null;
    }
    if (profile.role && school?.status === 'active') {
      return { kind: 'school', profile: profile as SchoolProfile, school, permissions, reload: load };
    }
    return null;
  }, [profile, school, supplier, permissions, load]);

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

  // A new account sets up its school (a headteacher) or supplier profile.
  if (!error && profile && profile.status === 'active' && !profile.role && !profile.school_id) {
    return setupKind === 'supplier' ? (
      <CreateSupplierScreen
        defaultName={profile.full_name}
        defaultEmail={email}
        onCreated={load}
        onSwitch={() => setSetupKind('school')}
      />
    ) : (
      <CreateSchoolScreen
        defaultName={profile.full_name}
        onCreated={load}
        onSwitch={() => setSetupKind('supplier')}
      />
    );
  }

  if (!value) {
    const message = error
      ? `Could not load your account: ${error}`
      : profile?.status === 'suspended'
      ? profile.role === 'supplier'
        ? 'This supplier account is suspended.'
        : 'Your account is suspended. Ask your headteacher to restore it.'
      : profile?.role === 'supplier'
      ? 'Your supplier profile could not be found.'
      : school?.status === 'suspended'
      ? `${school.name}'s account is suspended.`
      : "Your login isn't linked to a school.";
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

  return <AccountContext.Provider value={value}>{children(value.kind)}</AccountContext.Provider>;
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used inside AccountProvider');
  return value;
}

// The user's school and what they may do there (school screens only).
export function useSchool() {
  const account = useAccount();
  if (account.kind !== 'school') throw new Error('useSchool is only for school accounts');
  const { profile, school, permissions, reload } = account;
  const can = (permission: Permission) => permissions.includes(permission);
  return { profile, school, permissions, can, isHeadteacher: profile.role === 'headteacher', reload };
}

// The signed-in supplier's profile (supplier screens only).
export function useSupplier() {
  const account = useAccount();
  if (account.kind !== 'supplier') throw new Error('useSupplier is only for supplier accounts');
  return { profile: account.profile, supplier: account.supplier, reload: account.reload };
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
