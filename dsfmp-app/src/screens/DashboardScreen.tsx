import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, ThemePreference, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, useSchool } from '../school/SchoolContext';

const MENU_ITEMS = [
  { label: 'Students', screen: 'Students', available: true },
  { label: 'Attendance', screen: 'Attendance', available: true },
  { label: 'Inventory', screen: 'Inventory', available: true },
  { label: 'Distribution', screen: 'Distribution', available: true },
  { label: 'Reports', screen: 'Reports', available: true },
];

// Only network admins manage staff logins.
const NETWORK_MENU_ITEMS = [{ label: 'Staff', screen: 'Staff', available: true }];

const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

export default function DashboardScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { preference, setPreference } = useTheme();
  const { profile, isNetworkAdmin, schools, school, setSchoolId } = useSchool();
  const [beneficiaryCount, setBeneficiaryCount] = useState<number | null>(null);

  const loadStats = useCallback(async () => {
    const { count } = await supabase
      .from('beneficiaries')
      .select('*', { count: 'exact', head: true })
      .eq('school_id', school.school_id)
      .eq('status', 'active');
    setBeneficiaryCount(count ?? 0);
  }, [school.school_id]);

  useEffect(() => {
    // Reload on every focus so the count reflects changes made on other screens.
    loadStats();
    return navigation.addListener('focus', loadStats);
  }, [navigation, loadStats]);

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerMain}>
          <Text style={styles.headerTitle}>{school.name}</Text>
          <Text style={styles.headerMeta}>
            {profile.full_name} · {ROLE_LABELS[profile.role]}
          </Text>
        </View>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logout}>Logout</Text>
        </TouchableOpacity>
      </View>

      {isNetworkAdmin && schools.length > 1 && (
        <>
          <Text style={styles.sectionLabel}>School</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chips}
            contentContainerStyle={styles.chipsContent}
          >
            {schools.map((s) => (
              <TouchableOpacity
                key={s.school_id}
                style={[styles.chip, s.school_id === school.school_id && styles.chipActive]}
                onPress={() => setSchoolId(s.school_id)}
                accessibilityState={{ selected: s.school_id === school.school_id }}
              >
                <Text
                  style={[styles.chipText, s.school_id === school.school_id && styles.chipTextActive]}
                >
                  {s.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}

      <View style={styles.statCard}>
        <Text style={styles.statNumber}>{beneficiaryCount ?? '—'}</Text>
        <Text style={styles.statLabel}>Active students</Text>
      </View>

      <View style={styles.menu}>
        {(isNetworkAdmin ? [...MENU_ITEMS, ...NETWORK_MENU_ITEMS] : MENU_ITEMS).map((item) => (
          <TouchableOpacity
            key={item.screen}
            style={[styles.menuItem, !item.available && styles.menuItemDisabled]}
            onPress={() => item.available && navigation.navigate(item.screen)}
            disabled={!item.available}
            accessibilityState={{ disabled: !item.available }}
          >
            <Text style={styles.menuText}>{item.label}</Text>
            <Text style={styles.chevron}>{item.available ? '›' : 'Coming soon'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Theme</Text>
      <View style={styles.segment}>
        {THEME_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.key}
            style={[styles.segmentItem, preference === option.key && styles.segmentItemActive]}
            onPress={() => setPreference(option.key)}
            accessibilityState={{ selected: preference === option.key }}
          >
            <Text
              style={[styles.segmentText, preference === option.key && styles.segmentTextActive]}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerMain: { flex: 1, marginRight: 12 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: c.text },
  headerMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  logout: { color: c.danger, fontSize: 14 },
  sectionLabel: { fontSize: 13, color: c.textSecondary, marginBottom: 8 },
  chips: { flexGrow: 0, marginBottom: 20 },
  chipsContent: { gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: c.primary, borderColor: c.primary },
  chipText: { fontSize: 14, color: c.text },
  chipTextActive: { color: c.onPrimary, fontWeight: '600' },
  statCard: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
  },
  statNumber: { fontSize: 32, fontWeight: '700', color: c.text },
  statLabel: { fontSize: 13, color: c.textMuted, marginTop: 4 },
  menu: { borderTopWidth: 1, borderTopColor: c.divider },
  menuItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  menuItemDisabled: { opacity: 0.55 },
  menuText: { fontSize: 16, color: c.text },
  chevron: { fontSize: 20, color: c.textFaint },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: c.text, marginTop: 28, marginBottom: 10 },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: c.border, borderRadius: 8 },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: c.primary, borderRadius: 7 },
  segmentText: { fontSize: 14, color: c.textSecondary },
  segmentTextActive: { color: c.onPrimary, fontWeight: '600' },
});
