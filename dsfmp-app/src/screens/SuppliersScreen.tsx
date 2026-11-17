import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Avatar, Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { LINK_LABELS, LINK_TONES, LinkStatus, describeSupplierError } from '../lib/suppliers';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { ListItem, SegmentedButtons } from '../components/Paper';
import { EmptyText, ScreenHeader, StatusPill, initials } from '../components/ScreenParts';

// A row of school_supplier_directory().
export type DirectorySupplier = {
  supplier_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string | null;
  county: string | null;
  areas_served: string | null;
  kra_pin: string;
  registration_no: string | null;
  description: string | null;
  foods: string[];
  document_count: number;
  status: LinkStatus;
  requested_by: 'supplier' | 'school' | null;
  message: string | null;
  decision_note: string | null;
  updated_at: string | null;
  registered_at: string;
};

type Tab = 'requests' | 'approved' | 'find';

// The school's suppliers: requests waiting for the headteacher, approved
// suppliers, and every registered supplier to choose from.
export default function SuppliersScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [rows, setRows] = useState<DirectorySupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('school_supplier_directory');
    if (error) setLoadError(describeSupplierError(error));
    else {
      setLoadError(null);
      setRows((data ?? []) as DirectorySupplier[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    return navigation.addListener('focus', load);
  }, [navigation, load]);

  const requests = rows.filter((r) => r.status === 'requested');
  const approved = rows.filter((r) => r.status === 'approved');
  // Open on the requests if there are any, otherwise on the approved list
  // (or the directory for a school with no suppliers yet).
  const current: Tab = tab ?? (requests.length ? 'requests' : approved.length ? 'approved' : 'find');

  const term = search.trim().toLowerCase();
  const source = current === 'requests' ? requests : current === 'approved' ? approved : rows;
  const shown = term
    ? source.filter((r) =>
        [r.business_name, r.contact_name, r.county, r.areas_served, ...r.foods].some((v) =>
          v?.toLowerCase().includes(term)
        )
      )
    : source;

  return (
    <View style={styles.container}>
      <ScreenHeader title="Suppliers" onBack={() => navigation.goBack()} />
      <Text variant="bodySmall" style={styles.schoolName}>{school.name}</Text>

      <SegmentedButtons
        value={current}
        onValueChange={(v) => setTab(v as Tab)}
        buttons={[
          { value: 'requests', label: `Requests (${requests.length})` },
          { value: 'approved', label: `Approved (${approved.length})` },
          { value: 'find', label: 'All' },
        ]}
      />
      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, food, county or area"
        elevation={0}
        style={styles.search}
      />
      {loadError && <HelperText type="error">Could not load suppliers: {loadError}</HelperText>}

      <FlatList
        style={styles.list}
        data={shown}
        keyExtractor={(r) => r.supplier_id}
        ItemSeparatorComponent={Divider}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>
              {term
                ? 'No suppliers match your search.'
                : current === 'requests'
                ? 'No requests waiting.'
                : current === 'approved'
                ? 'No approved suppliers yet. Find one under "All".'
                : 'No suppliers have registered yet.'}
            </EmptyText>
          )
        }
        renderItem={({ item }) => (
          <ListItem
            title={item.business_name}
            description={
              (item.foods.length ? item.foods.join(', ') : 'No foods listed') +
              `\n${[item.county, item.areas_served].filter(Boolean).join(' · ') || 'Area not given'}`
            }
            descriptionNumberOfLines={2}
            onPress={() => navigation.navigate('SupplierDetail', { supplier: item })}
            style={styles.row}
            left={() => <Avatar.Text size={40} label={initials(item.business_name)} style={styles.avatar} />}
            right={() =>
              item.status ? (
                <StatusPill label={LINK_LABELS[item.status]} tone={LINK_TONES[item.status]} style={styles.pill} />
              ) : null
            }
          />
        )}
      />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  schoolName: { color: c.textMuted, marginTop: -8, marginBottom: 12 },
  search: { backgroundColor: c.surface, marginTop: 12 },
  list: { marginTop: 12 },
  row: { paddingLeft: 0, paddingRight: 0 },
  avatar: { alignSelf: 'center' },
  pill: { alignSelf: 'center' },
});
