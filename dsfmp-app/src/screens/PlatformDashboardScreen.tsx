import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { HelperText } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, useAccount } from '../school/SchoolContext';
import { FadeIn } from '../components/Motion';
import { StatCard } from '../components/ScreenParts';
import { DashboardHeader, MenuGrid, MenuItem, ThemeSection } from '../components/Dashboard';

const MENU_ITEMS: MenuItem[] = [
  { label: 'Schools', screen: 'Schools', icon: 'school-outline', available: true },
  { label: 'Suppliers', screen: 'Suppliers', icon: 'storefront-outline', available: false },
  { label: 'Food list', screen: 'FoodList', icon: 'food-apple-outline', available: false },
];

// The platform admin's home screen. They onboard schools and verify
// suppliers, but never see a school's own records.
export default function PlatformDashboardScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { profile } = useAccount();
  const [counts, setCounts] = useState<{ active: number; suspended: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_schools');
    if (error) {
      setError(`Could not load schools: ${error.message}`);
      return;
    }
    setError(null);
    const rows = (data ?? []) as { status: string }[];
    setCounts({
      active: rows.filter((s) => s.status === 'active').length,
      suspended: rows.filter((s) => s.status === 'suspended').length,
    });
  }, []);

  useEffect(() => {
    loadStats();
    return navigation.addListener('focus', loadStats);
  }, [navigation, loadStats]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <DashboardHeader
        title="DSFMP platform"
        name={profile.full_name}
        subtitle={`${profile.full_name} · ${ROLE_LABELS.platform_admin}`}
      />

      {error && <HelperText type="error">{error}</HelperText>}

      <FadeIn style={styles.stats}>
        <StatCard style={styles.stat} value={counts?.active ?? '—'} label="active schools" />
        <StatCard
          style={styles.stat}
          value={counts?.suspended ?? '—'}
          label="suspended"
          tone={counts?.suspended ? 'warning' : 'default'}
        />
      </FadeIn>

      <MenuGrid items={MENU_ITEMS} onOpen={(screen) => navigation.navigate(screen)} />

      <ThemeSection />
      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 20, paddingBottom: 32 },
  stats: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  stat: { flex: 1 },
  bottomSpacer: { height: 8 },
});
