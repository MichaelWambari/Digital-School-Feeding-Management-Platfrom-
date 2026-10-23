import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView, PressableScale } from '../components/Motion';

// The network admin's side of food distribution: dispatching food from the
// central store to schools, and how much of each food every school uses.

type Food = { food_id: string; item_name: string; unit: string; quantity_available: number };

type Dispatch = {
  distribution_id: string;
  school_id: string;
  food_id: string;
  quantity_dispatched: number;
  dispatch_date: string;
  status: 'in_transit' | 'received' | 'cancelled';
  quantity_received: number | null;
  received_date: string | null;
};

type SchoolItem = { item_id: string; school_id: string; food_id: string; quantity_available: number };

// Per school and food over the chosen range.
type FoodTotals = { sent: number; used: number; inStock: number };

const RANGES = [
  { key: 'week', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'Last 30 days', days: 30 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

// Supabase returns at most 1000 rows per request, so larger results are paged.
const PAGE_SIZE = 1000;
const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

// Local calendar date as YYYY-MM-DD, daysAgo days back.
function localDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatQty(qty: number, unit: string | null) {
  return `${Number(qty).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit ?? ''}`.trim();
}

function formatDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export default function NetworkDistributionScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const [tab, setTab] = useState<'dispatch' | 'schools'>('dispatch');

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <PressableScale onPress={() => navigation.goBack()}>
          <Text style={styles.link}>‹ Back</Text>
        </PressableScale>
        <Text style={styles.headerTitle}>Distribution</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.segment}>
        {(['dispatch', 'schools'] as const).map((t) => (
          <PressableScale
            key={t}
            style={[styles.segmentItem, tab === t && styles.segmentItemActive]}
            onPress={() => setTab(t)}
            accessibilityState={{ selected: tab === t }}
          >
            <Text style={[styles.segmentText, tab === t && styles.segmentTextActive]}>
              {t === 'dispatch' ? 'Dispatch to schools' : 'Use by school'}
            </Text>
          </PressableScale>
        ))}
      </View>

      {tab === 'dispatch' ? <DispatchTab /> : <SchoolsTab />}
    </View>
  );
}

function DispatchTab() {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { schools } = useSchool();
  const [foods, setFoods] = useState<Food[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [schoolId, setSchoolId] = useState<string | null>(schools[0]?.school_id ?? null);
  const [foodId, setFoodId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Dispatching and cancelling take two taps: the action, then Confirm.
  const [confirming, setConfirming] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [foodResult, dispatchResult] = await Promise.all([
      supabase.from('food_items').select('food_id, item_name, unit, quantity_available').order('item_name'),
      supabase
        .from('food_distribution')
        .select(
          'distribution_id, school_id, food_id, quantity_dispatched, dispatch_date, status, quantity_received, received_date'
        )
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    const loadError = foodResult.error ?? dispatchResult.error;
    if (loadError) {
      setError(`Could not load dispatches: ${loadError.message}`);
    } else {
      setError(null);
      const loadedFoods = foodResult.data ?? [];
      setFoods(loadedFoods);
      setDispatches(dispatchResult.data ?? []);
      setFoodId((current) =>
        current && loadedFoods.some((f) => f.food_id === current)
          ? current
          : loadedFoods[0]?.food_id ?? null
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const food = foods.find((f) => f.food_id === foodId);
  const school = schools.find((s) => s.school_id === schoolId);
  const foodById = new Map(foods.map((f) => [f.food_id, f]));
  const schoolName = (id: string) => schools.find((s) => s.school_id === id)?.name ?? 'Unknown school';

  async function handleDispatch() {
    const qty = Number(quantity.trim());
    if (!food || !school) {
      setError('Choose a school and a food first.');
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter a quantity greater than zero.');
      return;
    }
    if (qty > food.quantity_available) {
      setError(`Not enough ${food.item_name}: only ${formatQty(food.quantity_available, food.unit)} in the central store.`);
      return;
    }
    setError(null);
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setBusy(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      // A database trigger takes the food out of the central store.
      const { error } = await supabase.from('food_distribution').insert({
        school_id: school.school_id,
        food_id: food.food_id,
        quantity_dispatched: qty,
        dispatch_date: localDate(),
        dispatched_by: auth.user?.id ?? null,
      });
      if (error) {
        if (error.code === '23514') {
          setError(`Not enough ${food.item_name} in the central store. Refresh and try again.`);
        } else if (error.code === '42501') {
          setError('Only network admins can dispatch food.');
        } else {
          setError(error.message);
        }
        return;
      }
      setQuantity('');
      await loadData();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  async function handleCancel(d: Dispatch) {
    if (cancelId !== d.distribution_id) {
      setCancelId(d.distribution_id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Returns the food to the central store.
      const { error } = await supabase.rpc('cancel_distribution', { p_distribution_id: d.distribution_id });
      if (error) {
        setError(error.message);
        return;
      }
      await loadData();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
      setCancelId(null);
    }
  }

  return (
    <FadeInScrollView
      style={styles.tabBody}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
    >
      <Text style={styles.label}>School</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContent}>
        {schools.map((s) => (
          <PressableScale
            key={s.school_id}
            style={[styles.chip, s.school_id === schoolId && styles.chipActive]}
            onPress={() => {
              setSchoolId(s.school_id);
              setConfirming(false);
            }}
            accessibilityState={{ selected: s.school_id === schoolId }}
          >
            <Text style={[styles.chipText, s.school_id === schoolId && styles.chipTextActive]}>{s.name}</Text>
          </PressableScale>
        ))}
      </ScrollView>

      <Text style={styles.label}>Food</Text>
      {!loading && foods.length === 0 ? (
        <Text style={styles.emptyLeft}>No foods yet. Add foods and record a delivery in Inventory first.</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContent}>
          {foods.map((f) => (
            <PressableScale
              key={f.food_id}
              style={[styles.chip, f.food_id === foodId && styles.chipActive]}
              onPress={() => {
                setFoodId(f.food_id);
                setConfirming(false);
              }}
              accessibilityState={{ selected: f.food_id === foodId }}
            >
              <Text style={[styles.chipText, f.food_id === foodId && styles.chipTextActive]}>{f.item_name}</Text>
              <Text style={[styles.chipMeta, f.food_id === foodId && styles.chipTextActive]}>
                {formatQty(f.quantity_available, f.unit)} in store
              </Text>
            </PressableScale>
          ))}
        </ScrollView>
      )}

      <Text style={styles.label}>Quantity to send{food ? ` (${food.unit})` : ''}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={quantity}
        onChangeText={(text) => {
          setQuantity(text);
          setConfirming(false);
        }}
        keyboardType="decimal-pad"
        placeholder="0"
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <PressableScale
        style={[styles.button, confirming && styles.buttonConfirm]}
        onPress={handleDispatch}
        disabled={busy || !food || !school}
      >
        {busy && cancelId === null ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>
            {confirming && food && school
              ? `Confirm: send ${formatQty(Number(quantity), food.unit)} of ${food.item_name} to ${school.name}`
              : 'Dispatch'}
          </Text>
        )}
      </PressableScale>

      <Text style={styles.sectionTitle}>Recent dispatches</Text>
      {dispatches.length === 0 ? (
        <Text style={styles.emptyLeft}>Nothing dispatched yet.</Text>
      ) : (
        dispatches.map((d) => {
          const f = foodById.get(d.food_id);
          const unit = f?.unit ?? null;
          const short = d.status === 'received' ? d.quantity_dispatched - (d.quantity_received ?? 0) : 0;
          return (
            <View key={d.distribution_id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>
                  {f?.item_name ?? 'Food'} · {formatQty(d.quantity_dispatched, unit)} to {schoolName(d.school_id)}
                </Text>
                <Text
                  style={[
                    styles.rowMeta,
                    d.status === 'in_transit' && styles.statusTransit,
                    short > 0 && styles.statusShort,
                  ]}
                >
                  Sent {formatDay(d.dispatch_date)} ·{' '}
                  {d.status === 'in_transit'
                    ? 'in transit'
                    : d.status === 'cancelled'
                      ? 'cancelled'
                      : `received ${formatDay(d.received_date!)}` +
                        (short > 0 ? `, ${formatQty(short, unit)} short` : ' in full')}
                </Text>
              </View>
              {d.status === 'in_transit' && (
                <PressableScale
                  style={[styles.cancelButton, cancelId === d.distribution_id && styles.cancelButtonConfirm]}
                  onPress={() => handleCancel(d)}
                  disabled={busy}
                >
                  <Text style={styles.cancelText}>
                    {cancelId === d.distribution_id ? 'Confirm cancel' : 'Cancel'}
                  </Text>
                </PressableScale>
              )}
            </View>
          );
        })
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

function SchoolsTab() {
  const { styles } = useThemedStyles(makeStyles);
  const { schools } = useSchool();
  const [range, setRange] = useState<RangeKey>('week');
  const [foods, setFoods] = useState<Food[]>([]);
  // school_id -> food_id -> totals
  const [totals, setTotals] = useState<Map<string, Map<string, FoodTotals>>>(new Map());
  const [inTransit, setInTransit] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rangeDays = RANGES.find((r) => r.key === range)!.days;

  const loadData = useCallback(async () => {
    setLoading(true);
    const start = localDate(rangeDays - 1);
    try {
      const [foodResult, items, dispatches, usage] = await Promise.all([
        supabase.from('food_items').select('food_id, item_name, unit, quantity_available').order('item_name'),
        fetchAllRows<SchoolItem>((from, to) =>
          supabase
            .from('inventory_items')
            .select('item_id, school_id, food_id, quantity_available')
            .order('item_id')
            .range(from, to)
        ),
        fetchAllRows<Dispatch>((from, to) =>
          supabase
            .from('food_distribution')
            .select('distribution_id, school_id, food_id, quantity_dispatched, dispatch_date, status, quantity_received, received_date')
            .or(`dispatch_date.gte.${start},status.eq.in_transit`)
            .order('distribution_id')
            .range(from, to)
        ),
        fetchAllRows<{ item_id: string; quantity: number }>((from, to) =>
          supabase
            .from('food_consumption')
            .select('item_id, quantity')
            .gte('consumption_date', start)
            .order('consumption_id')
            .range(from, to)
        ),
      ]);
      if (foodResult.error) throw new Error(foodResult.error.message);

      const bySchool = new Map<string, Map<string, FoodTotals>>();
      const entry = (schoolId: string, foodId: string) => {
        const forSchool = bySchool.get(schoolId) ?? new Map<string, FoodTotals>();
        bySchool.set(schoolId, forSchool);
        const t = forSchool.get(foodId) ?? { sent: 0, used: 0, inStock: 0 };
        forSchool.set(foodId, t);
        return t;
      };
      const itemById = new Map(items.map((i) => [i.item_id, i]));
      for (const i of items) entry(i.school_id, i.food_id).inStock += Number(i.quantity_available);
      const transit = new Map<string, number>();
      for (const d of dispatches) {
        if (d.status === 'in_transit') transit.set(d.school_id, (transit.get(d.school_id) ?? 0) + 1);
        if (d.status === 'cancelled' || d.dispatch_date < start) continue;
        entry(d.school_id, d.food_id).sent += Number(d.quantity_dispatched);
      }
      for (const u of usage) {
        const item = itemById.get(u.item_id);
        if (item) entry(item.school_id, item.food_id).used += Number(u.quantity);
      }

      setFoods(foodResult.data ?? []);
      setTotals(bySchool);
      setInTransit(transit);
      setError(null);
    } catch (e) {
      setError(`Could not load school figures: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [rangeDays]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Network totals per food, across every school.
  const network = new Map<string, FoodTotals>();
  totals.forEach((forSchool) =>
    forSchool.forEach((t, foodId) => {
      const n = network.get(foodId) ?? { sent: 0, used: 0, inStock: 0 };
      n.sent += t.sent;
      n.used += t.used;
      n.inStock += t.inStock;
      network.set(foodId, n);
    })
  );

  function renderTable(rows: Map<string, FoodTotals> | undefined) {
    const shown = foods.filter((f) => rows?.has(f.food_id));
    if (shown.length === 0) return <Text style={styles.emptyLeft}>No food sent or used yet.</Text>;
    return (
      <>
        <View style={styles.tableRow}>
          <Text style={[styles.tableHead, styles.foodCol]}>Food</Text>
          <Text style={[styles.tableHead, styles.numCol]}>Sent</Text>
          <Text style={[styles.tableHead, styles.numCol]}>Used</Text>
          <Text style={[styles.tableHead, styles.numCol]}>In stock</Text>
        </View>
        {shown.map((f) => {
          const t = rows!.get(f.food_id)!;
          return (
            <View key={f.food_id} style={styles.tableRow}>
              <Text style={[styles.tableCell, styles.foodCol]}>{f.item_name}</Text>
              <Text style={[styles.tableCell, styles.numCol]}>{formatQty(t.sent, f.unit)}</Text>
              <Text style={[styles.tableCell, styles.numCol]}>{formatQty(t.used, f.unit)}</Text>
              <Text style={[styles.tableCell, styles.numCol]}>{formatQty(t.inStock, f.unit)}</Text>
            </View>
          );
        })}
      </>
    );
  }

  return (
    <FadeInScrollView
      style={styles.tabBody}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
    >
      <View style={styles.chipRow}>
        {RANGES.map((r) => (
          <PressableScale
            key={r.key}
            style={[styles.chip, range === r.key && styles.chipActive]}
            onPress={() => setRange(r.key)}
            accessibilityState={{ selected: range === r.key }}
          >
            <Text style={[styles.chipText, range === r.key && styles.chipTextActive]}>{r.label}</Text>
          </PressableScale>
        ))}
      </View>
      <Text style={styles.hint}>
        Sent: dispatched in this period. Used: recorded at the school's meals. In stock: now.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>All schools</Text>
        {renderTable(network)}
      </View>

      {schools.map((s) => {
        const transit = inTransit.get(s.school_id) ?? 0;
        return (
          <View key={s.school_id} style={styles.card}>
            <Text style={styles.cardTitle}>{s.name}</Text>
            {transit > 0 && (
              <Text style={[styles.rowMeta, styles.statusTransit]}>
                {transit} {transit === 1 ? 'delivery' : 'deliveries'} in transit
              </Text>
            )}
            {renderTable(totals.get(s.school_id))}
          </View>
        );
      })}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
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
  headerTitle: { fontSize: 20, fontWeight: '700', color: c.text },
  headerSpacer: { width: 60 },
  link: { color: c.primary, fontSize: 15 },
  tabBody: { flex: 1, marginTop: 16 },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: c.border, borderRadius: 8 },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: c.primary, borderRadius: 7 },
  segmentText: { fontSize: 14, color: c.textSecondary },
  segmentTextActive: { color: c.onPrimary, fontWeight: '600' },
  label: { fontSize: 13, color: c.textSecondary, marginBottom: 6, marginTop: 12 },
  hint: { fontSize: 13, color: c.textMuted, marginBottom: 12 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chipsContent: { gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: c.primary, borderColor: c.primary },
  chipText: { fontSize: 14, fontWeight: '600', color: c.text },
  chipMeta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  chipTextActive: { color: c.onPrimary },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: c.text,
  },
  error: { color: c.danger, fontSize: 13, marginTop: 12 },
  button: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 12,
    marginTop: 20,
    alignItems: 'center',
  },
  buttonConfirm: { backgroundColor: c.warning },
  buttonText: { color: c.onPrimary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  sectionTitle: { fontSize: 15, fontWeight: '600', marginTop: 24, marginBottom: 10, color: c.text },
  emptyLeft: { color: c.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
    gap: 12,
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 15, color: c.text },
  rowMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  statusTransit: { color: c.warningText },
  statusShort: { color: c.danger },
  cancelButton: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  cancelButtonConfirm: { borderColor: c.danger },
  cancelText: { color: c.danger, fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 6 },
  tableRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.divider },
  tableHead: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
  tableCell: { fontSize: 14, color: c.text },
  foodCol: { flex: 1.4 },
  numCol: { flex: 1, textAlign: 'right' },
  bottomSpacer: { height: 40 },
});
