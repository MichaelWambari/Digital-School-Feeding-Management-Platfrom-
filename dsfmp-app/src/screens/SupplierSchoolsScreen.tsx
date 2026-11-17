import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Card, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { LINK_LABELS, LINK_TONES, LinkStatus, describeSupplierError, formatDate } from '../lib/suppliers';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { Button, SegmentedButtons } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';

type SchoolRow = {
  school_id: string;
  name: string;
  county: string | null;
  location: string | null;
  status: LinkStatus;
  requested_by: 'supplier' | 'school' | null;
  message: string | null;
  decision_note: string | null;
  updated_at: string | null;
};

// The supplier's schools: the ones it has asked or that approved it, and a
// list of every school to ask.
export default function SupplierSchoolsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [rows, setRows] = useState<SchoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'mine' | 'find'>('mine');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('supplier_school_directory');
    if (error) setLoadError(describeSupplierError(error));
    else {
      setLoadError(null);
      setRows((data ?? []) as SchoolRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mine = rows.filter((r) => r.status === 'requested' || r.status === 'approved' || r.status === 'declined');
  useEffect(() => {
    // A new supplier has no schools yet: start on the search.
    if (!loading && mine.length === 0) setTab('find');
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(row: SchoolRow) {
    setError(null);
    setMessage('');
    setOpenId(openId === row.school_id ? null : row.school_id);
  }

  async function run(fn: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) {
      setError(describeSupplierError(error));
      return;
    }
    setOpenId(null);
    setMessage('');
    await load();
  }

  const term = search.trim().toLowerCase();
  const source = tab === 'mine' ? mine : rows.filter((r) => r.status !== 'approved' && r.status !== 'requested');
  const shown = term
    ? source.filter((r) => [r.name, r.county, r.location].some((v) => v?.toLowerCase().includes(term)))
    : source;

  return (
    <View style={styles.container}>
      <ScreenHeader title="Schools" onBack={() => navigation.goBack()} />
      <SegmentedButtons
        value={tab}
        onValueChange={(v) => {
          setTab(v as 'mine' | 'find');
          setOpenId(null);
        }}
        buttons={[
          { value: 'mine', label: `My schools (${mine.length})`, icon: 'handshake-outline' },
          { value: 'find', label: 'Find schools', icon: 'magnify' },
        ]}
      />
      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by school, county or town"
        elevation={0}
        style={styles.search}
      />
      {loadError && <HelperText type="error">Could not load schools: {loadError}</HelperText>}

      <FlatList
        style={styles.list}
        data={shown}
        keyExtractor={(r) => r.school_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>
              {term
                ? 'No schools match your search.'
                : tab === 'mine'
                ? 'You haven\'t asked any school yet. Find one under "Find schools".'
                : 'No more schools to ask right now.'}
            </EmptyText>
          )
        }
        renderItem={({ item }) => {
          const open = openId === item.school_id;
          const place = [item.location, item.county].filter(Boolean).join(', ');
          return (
            <Card mode="outlined" style={styles.card} onPress={() => toggle(item)}>
              <Card.Title
                title={item.name}
                subtitle={place || 'Location not given'}
                right={() =>
                  item.status ? (
                    <StatusPill label={LINK_LABELS[item.status]} tone={LINK_TONES[item.status]} style={styles.pill} />
                  ) : null
                }
              />
              {open && (
                <Card.Content>
                  {item.status === 'approved' && (
                    <Text variant="bodyMedium" style={styles.text}>
                      {item.requested_by === 'school' ? 'The school added you' : 'The school approved your request'}
                      {item.updated_at ? ` on ${formatDate(item.updated_at)}` : ''}. Their orders will come
                      here.
                    </Text>
                  )}
                  {item.status === 'requested' && (
                    <Text variant="bodyMedium" style={styles.text}>
                      Waiting for the headteacher to answer.
                      {item.message ? `\nYour note: "${item.message}"` : ''}
                    </Text>
                  )}
                  {(item.status === 'declined' || item.status === 'removed') && (
                    <Text variant="bodyMedium" style={styles.text}>
                      {item.status === 'declined' ? 'The school declined your request.' : 'You no longer supply this school.'}
                      {item.decision_note ? `\nNote: "${item.decision_note}"` : ''}
                    </Text>
                  )}

                  {(item.status === null || item.status === 'declined' || item.status === 'removed') && (
                    <Field
                      label="Note to the headteacher (optional)"
                      value={message}
                      onChangeText={setMessage}
                      multiline
                      placeholder="e.g. We deliver maize and beans weekly in Nakuru"
                    />
                  )}
                  <HelperText type="error" visible={!!error}>{error}</HelperText>

                  {(item.status === null || item.status === 'declined' || item.status === 'removed') && (
                    <Button
                      mode="contained"
                      icon="send-outline"
                      loading={busy}
                      disabled={busy}
                      onPress={() => run('request_to_supply', { p_school_id: item.school_id, p_message: message.trim() || null })}
                    >
                      {item.status ? 'Ask again' : 'Ask to supply this school'}
                    </Button>
                  )}
                  {item.status === 'requested' && (
                    <Button mode="outlined" icon="undo" loading={busy} disabled={busy}
                      onPress={() => run('withdraw_from_school', { p_school_id: item.school_id })}>
                      Withdraw request
                    </Button>
                  )}
                  {item.status === 'approved' && (
                    <Button mode="outlined" icon="close" textColor={colors.danger} loading={busy} disabled={busy}
                      onPress={() => run('withdraw_from_school', { p_school_id: item.school_id })}>
                      Stop supplying this school
                    </Button>
                  )}
                </Card.Content>
              )}
            </Card>
          );
        }}
      />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  search: { backgroundColor: c.surface, marginTop: 12 },
  list: { marginTop: 12 },
  card: { borderRadius: 12, marginBottom: 10 },
  pill: { marginRight: 12 },
  text: { color: c.textSecondary, marginBottom: 4 },
});
