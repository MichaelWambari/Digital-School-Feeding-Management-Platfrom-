import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';

export type Role = 'network_admin' | 'admin' | 'coordinator' | 'inventory_officer';

export const ROLE_LABELS: Record<Role, string> = {
  network_admin: 'Network admin',
  admin: 'Admin',
  coordinator: 'Coordinator',
  inventory_officer: 'Inventory officer',
};

export type Profile = {
  user_id: string;
  full_name: string;
  role: Role;
  school_id: string | null;
};

export type School = { school_id: string; name: string };

type SchoolValue = {
  profile: Profile;
  isNetworkAdmin: boolean;
  // Schools this user can see: their own, or every school for a network admin.
  schools: School[];
  // The school every screen works on. Fixed for staff; network admins can switch.
  school: School;
  setSchoolId: (schoolId: string) => void;
};

const STORAGE_KEY = 'dsfmp.selectedSchool';

const SchoolContext = createContext<SchoolValue | null>(null);

// Loads the signed-in user's profile and schools, and only renders the app
// once there is a school to work on.
export function SchoolProvider({ children }: { children: React.ReactNode }) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [schools, setSchools] = useState<School[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const [profileResult, schoolResult] = await Promise.all([
        supabase
          .from('users')
          .select('user_id, full_name, role, school_id')
          .eq('user_id', auth.user?.id ?? '')
          .maybeSingle(),
        supabase.from('schools').select('school_id, name').eq('status', 'active').order('name'),
      ]);
      const loadError = profileResult.error ?? schoolResult.error;
      if (loadError) throw new Error(loadError.message);
      if (!profileResult.data) throw new Error('No profile was found for this login.');

      const loadedProfile = profileResult.data as Profile;
      const loadedSchools = schoolResult.data ?? [];
      let saved: string | null = null;
      if (loadedProfile.role === 'network_admin') {
        saved = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
      }
      setProfile(loadedProfile);
      setSchools(loadedSchools);
      setSelectedId(
        loadedProfile.role === 'network_admin'
          ? loadedSchools.find((s) => s.school_id === saved)?.school_id ??
              loadedSchools[0]?.school_id ??
              null
          : loadedProfile.school_id
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to connect. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const school = schools.find((s) => s.school_id === selectedId) ?? null;

  const value = useMemo<SchoolValue | null>(
    () =>
      profile && school
        ? {
            profile,
            isNetworkAdmin: profile.role === 'network_admin',
            schools,
            school,
            setSchoolId: (schoolId) => {
              setSelectedId(schoolId);
              AsyncStorage.setItem(STORAGE_KEY, schoolId).catch(() => {});
            },
          }
        : null,
    [profile, schools, school]
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!value) {
    const message = error
      ? `Could not load your account: ${error}`
      : profile?.role === 'network_admin'
      ? 'There are no active schools yet. Add a school in Supabase first.'
      : 'Your account is not assigned to a school yet. Ask an administrator to assign you.';
    return (
      <View style={styles.center}>
        <Text style={styles.message}>{message}</Text>
        <TouchableOpacity style={styles.button} onPress={load}>
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => supabase.auth.signOut()}>
          <Text style={styles.logout}>Logout</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return <SchoolContext.Provider value={value}>{children}</SchoolContext.Provider>;
}

export function useSchool() {
  const value = useContext(SchoolContext);
  if (!value) throw new Error('useSchool must be used inside SchoolProvider');
  return value;
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
