import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Avatar, Card, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, useSchool } from '../school/SchoolContext';
import { FadeIn } from '../components/Motion';
import { DashboardHeader, MenuGrid, MenuItem, ThemeSection } from '../components/Dashboard';

// The school's home screen. Tiles follow what the user may do here.
export default function DashboardScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { profile, school, can, isHeadteacher } = useSchool();
  const seesStudents = can('view_students') || can('manage_students');
  const [beneficiaryCount, setBeneficiaryCount] = useState<number | null>(null);

  const loadStats = useCallback(async () => {
    if (!seesStudents) return;
    const { count } = await supabase
      .from('beneficiaries')
      .select('*', { count: 'exact', head: true })
      .eq('school_id', school.school_id)
      .eq('status', 'active');
    setBeneficiaryCount(count ?? 0);
  }, [school.school_id, seesStudents]);

  useEffect(() => {
    // Reload on every focus so the count reflects changes made on other screens.
    loadStats();
    return navigation.addListener('focus', loadStats);
  }, [navigation, loadStats]);

  const seesStock = can('view_inventory') || can('verify_deliveries');
  const menuItems: MenuItem[] = [
    { label: 'Students', screen: 'Students', icon: 'account-school-outline', available: seesStudents },
    {
      label: 'Attendance',
      screen: 'Attendance',
      icon: 'clipboard-check-outline',
      available: can('view_attendance') || can('record_attendance'),
    },
    { label: 'Inventory', screen: 'Inventory', icon: 'package-variant-closed', available: seesStock },
    { label: 'Distribution', screen: 'Distribution', icon: 'truck-delivery-outline', available: seesStock },
    { label: 'Reports', screen: 'Reports', icon: 'chart-box-outline', available: can('view_reports') },
    ...(isHeadteacher
      ? [
          { label: 'Staff', screen: 'Staff', icon: 'account-key-outline', available: true },
          { label: 'Permissions', screen: 'Permissions', icon: 'shield-account-outline', available: true },
        ]
      : []),
    { label: 'School', screen: 'SchoolProfile', icon: 'school-outline', available: true },
  ].filter((item) => item.available);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <DashboardHeader
        title={school.name}
        name={profile.full_name}
        subtitle={`${profile.full_name} · ${profile.role ? ROLE_LABELS[profile.role] : ''}`}
      />

      {seesStudents && (
        <FadeIn>
          <Card mode="contained" style={styles.statCard}>
            <Card.Content style={styles.statContent}>
              <Avatar.Icon size={48} icon="account-group-outline" />
              <View style={styles.statText}>
                <Text variant="displaySmall" style={styles.statNumber}>
                  {beneficiaryCount ?? '—'}
                </Text>
                <Text variant="bodyMedium" style={styles.statLabel}>Active students</Text>
              </View>
            </Card.Content>
          </Card>
        </FadeIn>
      )}

      <MenuGrid items={menuItems} onOpen={(screen) => navigation.navigate(screen)} />

      <ThemeSection />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 20, paddingBottom: 32 },
  statCard: { borderRadius: 16, marginBottom: 20 },
  statContent: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  statText: { marginLeft: 16 },
  statNumber: { fontWeight: '700', color: c.text },
  statLabel: { color: c.textMuted },
});
