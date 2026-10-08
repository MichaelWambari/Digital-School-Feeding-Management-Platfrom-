import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { supabase } from '../lib/supabase';

const MENU_ITEMS = [
  { label: 'Beneficiaries', screen: 'Beneficiaries', available: true },
  { label: 'Attendance', screen: 'Attendance', available: false },
  { label: 'Inventory', screen: 'Inventory', available: false },
  { label: 'Distribution', screen: 'Distribution', available: false },
  { label: 'Reports', screen: 'Reports', available: false },
];

export default function DashboardScreen({ navigation }: any) {
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerTitle: { fontSize: 22, fontWeight: '700' },
  logout: { color: '#dc2626', fontSize: 14 },
  statCard: {
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
  },
  statNumber: { fontSize: 32, fontWeight: '700' },
  statLabel: { fontSize: 13, color: '#666', marginTop: 4 },
  menu: { borderTopWidth: 1, borderTopColor: '#eee' },
  menuItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  menuItemDisabled: { opacity: 0.55 },
  menuText: { fontSize: 16 },
  chevron: { fontSize: 20, color: '#999' },
});
