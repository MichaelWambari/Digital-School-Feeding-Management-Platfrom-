import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';

type Item = {
  item_id: string;
  item_name: string;
  quantity_available: number;
  unit: string | null;
};

type Beneficiary = {
  beneficiary_id: string;
  full_name: string;
  admission_no: string;
};

// Local calendar date as YYYY-MM-DD, so "today" matches the coordinator's day
// rather than the database server's UTC date.
function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatQty(qty: number, unit: string | null) {
  return `${Number(qty).toLocaleString()} ${unit ?? ''}`.trim();
}

export default function DistributionScreen({ navigation }: any) {
  const [items, setItems] = useState<Item[]>([]);
  const [itemId, setItemId] = useState<string | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  // beneficiary_id -> total quantity of the selected item issued today
  const [issuedToday, setIssuedToday] = useState<Map<string, number>>(new Map());
  const [portion, setPortion] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Distributions can't be deleted, so issuing takes two taps: Issue, then Confirm.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const date = todayLocal();
  const item = items.find((i) => i.item_id === itemId);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [itemResult, beneficiaryResult] = await Promise.all([
      supabase
        .from('inventory_items')
        .select('item_id, item_name, quantity_available, unit')
        .order('item_name'),
      supabase
        .from('beneficiaries')
        .select('beneficiary_id, full_name, admission_no')
        .eq('status', 'active')
        .order('full_name'),
    ]);
    const loadError = itemResult.error ?? beneficiaryResult.error;
    if (loadError) {
      setError(`Could not load data: ${loadError.message}`);
    } else {
      setError(null);
      const loadedItems = itemResult.data ?? [];
      setItems(loadedItems);
      setBeneficiaries(beneficiaryResult.data ?? []);
      setItemId((current) =>
        current && loadedItems.some((i) => i.item_id === current)
          ? current
          : loadedItems[0]?.item_id ?? null
      );
    }
    setLoading(false);
  }, []);

  const loadIssued = useCallback(async () => {
    if (!itemId) {
      setIssuedToday(new Map());
      return;
    }
    const { data, error } = await supabase
      .from('food_distribution')
      .select('beneficiary_id, quantity_issued')
      .eq('item_id', itemId)
      .eq('distribution_date', date);
    if (error) {
      setError(`Could not load today's distributions: ${error.message}`);
      return;
    }
    const totals = new Map<string, number>();
    for (const d of data ?? []) {
      totals.set(d.beneficiary_id, (totals.get(d.beneficiary_id) ?? 0) + Number(d.quantity_issued));
    }
    setIssuedToday(totals);
  }, [itemId, date]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    setConfirmId(null);
    loadIssued();
  }, [loadIssued]);

  async function refresh() {
    await loadData();
    await loadIssued();
  }

  function handleIssuePress(b: Beneficiary) {
    const qty = Number(portion.trim());
    if (!item) return;
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter the portion size to issue first.');
      return;
    }
    setError(null);
    if (confirmId === b.beneficiary_id) {
      issue(b, qty);
    } else {
      setConfirmId(b.beneficiary_id);
    }
  }

  async function issue(b: Beneficiary, qty: number) {
    if (!item) return;
    setBusyId(b.beneficiary_id);
    try {
      const { data: auth } = await supabase.auth.getUser();
      // A database trigger records this as stock "used" and rejects it if stock is short.
      const { error } = await supabase.from('food_distribution').insert({
        beneficiary_id: b.beneficiary_id,
        item_id: item.item_id,
        quantity_issued: qty,
        distribution_date: date,
        recorded_by: auth.user?.id ?? null,
      });
      if (error) {
        if (error.code === '23514') {
          setError(
            `Not enough ${item.item_name}: only ${formatQty(item.quantity_available, item.unit)} left.`
          );
        } else if (error.code === '42501') {
          setError('Only admins and coordinators can record distributions.');
        } else {
          setError(error.message);
        }
        return;
      }
      setIssuedToday((prev) =>
        new Map(prev).set(b.beneficiary_id, (prev.get(b.beneficiary_id) ?? 0) + qty)
      );
      setItems((prev) =>
        prev.map((i) =>
          i.item_id === item.item_id
            ? { ...i, quantity_available: i.quantity_available - qty }
            : i
        )
      );
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  }

  const term = search.trim().toLowerCase();
  const filtered = term
    ? beneficiaries.filter(
        (b) =>
          b.full_name.toLowerCase().includes(term) ||
          b.admission_no.toLowerCase().includes(term)
      )
    : beneficiaries;

  let totalIssued = 0;
  issuedToday.forEach((qty) => (totalIssued += qty));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Distribution</Text>
        <View style={styles.headerSpacer} />
      </View>

      {!loading && items.length === 0 ? (
        <Text style={styles.empty}>
          No inventory items yet. Add items and record a delivery in Inventory first.
        </Text>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chips}
            contentContainerStyle={styles.chipsContent}
          >
            {items.map((i) => (
              <TouchableOpacity
                key={i.item_id}
                style={[styles.chip, i.item_id === itemId && styles.chipActive]}
                onPress={() => setItemId(i.item_id)}
                accessibilityState={{ selected: i.item_id === itemId }}
              >
                <Text style={[styles.chipText, i.item_id === itemId && styles.chipTextActive]}>
                  {i.item_name}
                </Text>
                <Text style={[styles.chipMeta, i.item_id === itemId && styles.chipTextActive]}>
                  {formatQty(i.quantity_available, i.unit)} left
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {item && (
            <View style={styles.summary}>
              <Text style={styles.summaryNumber}>{issuedToday.size}</Text>
              <Text style={styles.summaryLabel}>
                received {item.item_name} today · {formatQty(totalIssued, item.unit)} issued ·{' '}
                {formatQty(item.quantity_available, item.unit)} left
              </Text>
            </View>
          )}

          <Text style={styles.label}>Portion per beneficiary{item?.unit ? ` (${item.unit})` : ''}</Text>
          <TextInput
            style={styles.input}
            value={portion}
            onChangeText={(text) => {
              setPortion(text);
              setConfirmId(null);
            }}
            keyboardType="decimal-pad"
            placeholder="e.g. 0.25"
          />

          <TextInput
            style={[styles.input, styles.search]}
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name or admission no."
            autoCapitalize="none"
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <FlatList
            style={styles.list}
            data={filtered}
            keyExtractor={(b) => b.beneficiary_id}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
            ListEmptyComponent={
              loading ? null : (
                <Text style={styles.empty}>
                  {term ? 'No beneficiaries match your search.' : 'No active beneficiaries.'}
                </Text>
              )
            }
            renderItem={({ item: b }) => {
              const received = issuedToday.get(b.beneficiary_id);
              const isConfirming = confirmId === b.beneficiary_id;
              const isBusy = busyId === b.beneficiary_id;
              return (
                <View style={styles.row}>
                  <View style={styles.rowMain}>
                    <Text style={styles.rowName}>{b.full_name}</Text>
                    <Text style={styles.rowMeta}>
                      {b.admission_no}
                      {received ? ` · received ${formatQty(received, item?.unit ?? null)} today` : ''}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[
                      styles.issueButton,
                      received !== undefined && !isConfirming && styles.issueButtonAgain,
                      isConfirming && styles.issueButtonConfirm,
                    ]}
                    onPress={() => handleIssuePress(b)}
                    disabled={busyId !== null}
                    accessibilityLabel={
                      isConfirming
                        ? `Confirm issuing ${portion} ${item?.unit ?? ''} to ${b.full_name}`
                        : `Issue ${item?.item_name ?? 'food'} to ${b.full_name}`
                    }
                  >
                    {isBusy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text
                        style={[
                          styles.issueText,
                          received !== undefined && !isConfirming && styles.issueTextAgain,
                        ]}
                      >
                        {isConfirming
                          ? `Confirm ${formatQty(Number(portion), item?.unit ?? null)}`
                          : received !== undefined
                            ? 'Issue again'
                            : 'Issue'}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              );
            }}
          />
        </>
      )}
    </View>
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
  headerTitle: { fontSize: 20, fontWeight: '700' },
  headerSpacer: { width: 60 },
  back: { color: '#2563eb', fontSize: 15 },
  chips: { flexGrow: 0 },
  chipsContent: { gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  chipText: { fontSize: 14, fontWeight: '600', color: '#222' },
  chipMeta: { fontSize: 12, color: '#666', marginTop: 2 },
  chipTextActive: { color: '#fff' },
  summary: { backgroundColor: '#f3f4f6', borderRadius: 12, padding: 16, marginTop: 16 },
  summaryNumber: { fontSize: 26, fontWeight: '700' },
  summaryLabel: { fontSize: 13, color: '#666', marginTop: 2 },
  label: { fontSize: 13, color: '#444', marginBottom: 6, marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  search: { marginTop: 12 },
  error: { color: '#dc2626', fontSize: 13, marginTop: 12 },
  list: { marginTop: 12 },
  empty: { textAlign: 'center', color: '#666', marginTop: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 16 },
  rowMeta: { fontSize: 13, color: '#666', marginTop: 2 },
  issueButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 110,
    alignItems: 'center',
  },
  issueButtonAgain: { backgroundColor: '#dcfce7' },
  issueButtonConfirm: { backgroundColor: '#d97706' },
  issueText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  issueTextAgain: { color: '#166534' },
});
