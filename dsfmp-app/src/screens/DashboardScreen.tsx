import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, ThemePreference, useTheme, useThemedStyles } from '../theme/ThemeContext';

const MENU_ITEMS = [
  { label: 'Beneficiaries', screen: 'Beneficiaries', available: true },
  { label: 'Attendance', screen: 'Attendance', available: true },
  { label: 'Inventory', screen: 'Inventory', available: true },
  { label: 'Distribution', screen: 'Distribution', available: true },
  { label: 'Reports', screen: 'Reports', available: true },
];

const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

export default function DashboardScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { preference, setPreference } = useTheme();
  const [beneficiaryCount, setBeneficiaryCount] = useState<number | null>(null);

  useEffect(() => {
    // Reload on every focus so the count reflects changes made on other screens.
    return navigation.addListener('focus', loadStats);
  }, [navigation]);

  async function loadStats() {
    const { count } = await supabase
      .from('beneficiaries')
      .select('*', { count: 'exact', head: true });
    setBeneficiaryCount(count ?? 0);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Dashboard</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logout}>Logout</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statCard}>
        <Text style={styles.statNumber}>{beneficiaryCount ?? '—'}</Text>
        <Text style={styles.statLabel}>Total beneficiaries</Text>
      </View>

      <View style={styles.menu}>
        {MENU_ITEMS.map((item) => (
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
  headerTitle: { fontSize: 22, fontWeight: '700', color: c.text },
  logout: { color: c.danger, fontSize: 14 },
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
