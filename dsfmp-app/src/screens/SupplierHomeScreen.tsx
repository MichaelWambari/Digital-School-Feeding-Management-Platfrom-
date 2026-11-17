import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Card, List } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSupplier } from '../school/SchoolContext';
import { FadeIn, PressableScale } from '../components/Motion';
import { DashboardHeader, MenuGrid, MenuItem, ThemeSection } from '../components/Dashboard';
import { StatCard } from '../components/ScreenParts';

type Step = { key: string; label: string; screen: string; done: boolean };

// The supplier's home screen: what's left to set up, and where it
// stands with schools.
export default function SupplierHomeScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { profile, supplier } = useSupplier();
  const [approved, setApproved] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [newRequests, setNewRequests] = useState<number | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);

  const load = useCallback(async () => {
    const head = { count: 'exact' as const, head: true };
    const [foods, docs, links, requests] = await Promise.all([
      supabase.from('supplier_foods').select('*', head).eq('supplier_id', supplier.supplier_id),
      supabase.from('supplier_documents').select('*', head).eq('supplier_id', supplier.supplier_id),
      supabase.from('school_suppliers').select('status').eq('supplier_id', supplier.supplier_id),
      // Not there before fix 015; the count then stays blank.
      supabase.from('supply_requests').select('*', head).eq('supplier_id', supplier.supplier_id).eq('status', 'pending'),
    ]);
    const rows = (links.data ?? []) as { status: string }[];
    setApproved(rows.filter((r) => r.status === 'approved').length);
    setPending(rows.filter((r) => r.status === 'requested').length);
    setNewRequests(requests.error ? null : requests.count ?? 0);
    setSteps([
      { key: 'foods', label: 'Choose the foods you supply', screen: 'SupplierProfile', done: (foods.count ?? 0) > 0 },
      { key: 'docs', label: 'Upload your documents', screen: 'SupplierDocuments', done: (docs.count ?? 0) > 0 },
      { key: 'schools', label: 'Ask a school to work with you', screen: 'SupplierSchools', done: rows.length > 0 },
    ]);
  }, [supplier.supplier_id]);

  useEffect(() => {
    load();
    return navigation.addListener('focus', load);
  }, [navigation, load]);

  const menuItems: MenuItem[] = [
    { label: 'Supply requests', screen: 'SupplierRequests', icon: 'cart-arrow-down', available: true },
    { label: 'Schools', screen: 'SupplierSchools', icon: 'school-outline', available: true },
    { label: 'Business profile', screen: 'SupplierProfile', icon: 'store-outline', available: true },
    { label: 'Documents', screen: 'SupplierDocuments', icon: 'file-document-multiple-outline', available: true },
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <DashboardHeader
        title={supplier.business_name}
        name={supplier.business_name}
        subtitle={`${profile.full_name} · Supplier`}
      />

      {steps && steps.some((st) => !st.done) && (
        <FadeIn>
          <Card mode="outlined" style={styles.card}>
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

      <FadeIn>
        <View style={styles.stats}>
          <StatCard value={approved ?? '—'} label="Schools that approved you" style={styles.stat} />
          <StatCard
            value={pending ?? '—'}
            label="Requests waiting"
            tone={pending ? 'warning' : 'default'}
            style={styles.stat}
          />
        </View>
        {!!newRequests && (
          <Card mode="contained" style={styles.card} onPress={() => navigation.navigate('SupplierRequests')}>
            <Card.Title
              title={`${newRequests} new supply ${newRequests === 1 ? 'request' : 'requests'}`}
              subtitle="Schools are running low. Tap to accept or decline."
              left={(props) => <List.Icon {...props} icon="cart-arrow-down" color={colors.warning} />}
              right={(props) => <List.Icon {...props} icon="chevron-right" />}
            />
          </Card>
        )}
      </FadeIn>

      <MenuGrid items={menuItems} onOpen={(screen) => navigation.navigate(screen)} />

      <ThemeSection />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 20, paddingBottom: 32 },
  card: { borderRadius: 16, marginBottom: 20 },
  step: { paddingLeft: 0, paddingRight: 0 },
  stepDone: { color: c.textMuted, textDecorationLine: 'line-through' },
  stats: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  stat: { flex: 1 },
});
