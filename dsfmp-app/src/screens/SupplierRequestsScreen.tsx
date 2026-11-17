import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Card, HelperText, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { formatDate } from '../lib/suppliers';
import { formatPacks, formatQty } from '../lib/units';
import {
  REQUEST_LABELS,
  REQUEST_TONES,
  SupplierRequest,
  describeRequestError,
  isOpen,
} from '../lib/supplyRequests';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { Button, SegmentedButtons } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';

// Food schools have asked this supplier for. The supplier accepts or
// declines; the school records the delivery when it arrives.
export default function SupplierRequestsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [rows, setRows] = useState<SupplierRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'open' | 'past'>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('supplier_supply_requests');
    if (error) setLoadError(describeRequestError(error));
    else {
      setLoadError(null);
      setRows((data ?? []) as SupplierRequest[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function respond(r: SupplierRequest, accept: boolean) {
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('respond_supply_request', {
      p_request_id: r.request_id,
      p_accept: accept,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      setError(describeRequestError(error));
      return;
    }
    setOpenId(null);
    setNote('');
    await load();
  }

  const open = rows.filter((r) => isOpen(r.status));
  const shown = tab === 'open' ? open : rows.filter((r) => !isOpen(r.status));

  return (
    <View style={styles.container}>
      <ScreenHeader title="Supply requests" onBack={() => navigation.goBack()} />
      <SegmentedButtons
        value={tab}
        onValueChange={(v) => {
          setTab(v as 'open' | 'past');
          setOpenId(null);
        }}
        buttons={[
          { value: 'open', label: `Open (${open.length})`, icon: 'cart-arrow-down' },
          { value: 'past', label: 'Past', icon: 'history' },
        ]}
      />
      {loadError && <HelperText type="error">Could not load requests: {loadError}</HelperText>}

      <FlatList
        style={styles.list}
        data={shown}
        keyExtractor={(r) => r.request_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>
              {tab === 'open'
                ? 'No requests right now. Schools that approved you ask here when their food runs low.'
                : 'No past requests yet.'}
            </EmptyText>
          )
        }
        renderItem={({ item }) => {
          const expanded = openId === item.request_id;
          const place = [item.location, item.county].filter(Boolean).join(', ');
          const packs = formatPacks(item.quantity, item);
          return (
            <Card
              mode="outlined"
              style={styles.card}
              onPress={
                item.status === 'pending'
                  ? () => {
                      setOpenId(expanded ? null : item.request_id);
                      setNote('');
                      setError(null);
                    }
                  : undefined
              }
            >
              <Card.Title
                title={`${item.item_name} · ${formatQty(item.quantity, item.unit)}`}
                subtitle={`${item.school_name}${place ? ` · ${place}` : ''}`}
                right={() => (
                  <StatusPill label={REQUEST_LABELS[item.status]} tone={REQUEST_TONES[item.status]} style={styles.pill} />
                )}
              />
              <Card.Content>
                <Text variant="bodySmall" style={styles.text}>
                  {[packs, `Asked ${formatDate(item.created_at)}`, item.requested_by_name ? `by ${item.requested_by_name}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                  {item.note ? `\nSchool's note: "${item.note}"` : ''}
                  {item.response_note ? `\nYour note: "${item.response_note}"` : ''}
                  {item.status === 'accepted' ? '\nThe school records the amount when it arrives.' : ''}
                  {item.status === 'delivered'
                    ? `\nReceived ${formatQty(item.quantity_received ?? 0, item.unit)} on ${formatDate(item.received_at!)}`
                    : ''}
                  {item.status === 'pending' && !expanded ? '\nTap to accept or decline.' : ''}
                </Text>
                {expanded && (
                  <>
                    <Field
                      label="Note to the school (optional)"
                      value={note}
                      onChangeText={setNote}
                      multiline
                      placeholder="e.g. Delivering on Thursday morning"
                    />
                    <HelperText type="error" visible={!!error}>{error}</HelperText>
                    <View style={styles.actions}>
                      <Button mode="contained" icon="check" loading={busy} disabled={busy} onPress={() => respond(item, true)}>
                        Accept
                      </Button>
                      <Button mode="outlined" icon="close" textColor={colors.danger} disabled={busy} onPress={() => respond(item, false)}>
                        Decline
                      </Button>
                    </View>
                  </>
                )}
              </Card.Content>
            </Card>
          );
        }}
      />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  list: { marginTop: 12 },
  card: { borderRadius: 12, marginBottom: 10 },
  pill: { marginRight: 12 },
  text: { color: c.textSecondary },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
