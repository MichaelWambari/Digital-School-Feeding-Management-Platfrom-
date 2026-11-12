import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Avatar, Card, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, useSchool } from '../school/SchoolContext';
import { FadeIn, PressableScale } from '../components/Motion';
import { DashboardHeader, MenuGrid, MenuItem, ThemeSection } from '../components/Dashboard';

// First steps for a new school, shown to the headteacher until all are done.
type Step = { key: string; label: string; screen: string; done: boolean };

// The school's home screen. Tiles follow what the user may do here.
export default function DashboardScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { profile, school, can, isHeadteacher } = useSchool();
  const seesStudents = can('view_students') || can('manage_students');
  const [beneficiaryCount, setBeneficiaryCount] = useState<number | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);

  const loadStats = useCallback(async () => {
    if (seesStudents) {
      const { count } = await supabase
        .from('beneficiaries')
        .select('*', { count: 'exact', head: true })
        .eq('school_id', school.school_id)
        .eq('status', 'active');
      setBeneficiaryCount(count ?? 0);
    }
    if (!isHeadteacher) return;
    const count = async (query: PromiseLike<{ count: number | null }>) => ((await query).count ?? 0) > 0;
    const head = { count: 'exact' as const, head: true };
    const [hasServing, hasStudents, hasStock, hasCoordinator] = await Promise.all([
      count(supabase.from('meal_ingredients').select('*', head).eq('school_id', school.school_id)),
      count(supabase.from('beneficiaries').select('*', head).eq('school_id', school.school_id)),
      count(supabase.from('inventory_items').select('*', head).eq('school_id', school.school_id)),
      count(supabase.from('users').select('*', head).eq('school_id', school.school_id).eq('role', 'coordinator')),
    ]);
    setSteps([
      { key: 'timetable', label: 'Set meal times and a dish with its serving', screen: 'Timetable', done: hasServing },
      { key: 'students', label: 'Add your students', screen: 'Students', done: hasStudents },
      { key: 'stock', label: 'Record the food you have in stock', screen: 'Inventory', done: hasStock },
      { key: 'coordinator', label: 'Add a coordinator', screen: 'Staff', done: hasCoordinator },
    ]);
  }, [school.school_id, seesStudents, isHeadteacher]);

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
    { label: 'Timetable', screen: 'Timetable', icon: 'calendar-clock-outline', available: true },
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

      {steps && steps.some((st) => !st.done) && (
        <FadeIn>
          <Card mode="outlined" style={styles.statCard}>
            <Card.Title
              title="Getting started"
              subtitle={`${steps.filter((st) => st.done).length} of ${steps.length} done`}
            />
            <Card.Content>
              {steps.map((st) => (
                <PressableScale key={st.key} onPress={() => navigation.navigate(st.screen)} disabled={st.done}>
                  <List.Item
                    title={st.label}
                    titleStyle={st.done ? styles.stepDone : undefined}
                    style={styles.step}
                    left={(props) => (
                      <List.Icon
                        {...props}
                        icon={st.done ? 'check-circle' : 'circle-outline'}
                        color={st.done ? colors.successText : colors.textMuted}
                      />
                    )}
                    right={(props) => (st.done ? null : <List.Icon {...props} icon="chevron-right" />)}
                  />
                </PressableScale>
              ))}
            </Card.Content>
          </Card>
        </FadeIn>
      )}

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
  step: { paddingVertical: 0, paddingLeft: 0 },
  stepDone: { color: c.textMuted, textDecorationLine: 'line-through' },
});
