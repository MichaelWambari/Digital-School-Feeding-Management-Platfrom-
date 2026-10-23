import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import NetworkDistributionScreen from './NetworkDistributionScreen';
import { FadeInScrollView, PressableScale } from '../components/Motion';

// A school's side of food distribution: food received from the central
// store, and food used at each meal.

type Item = {
  item_id: string;
  quantity_available: number;
  food_items: { item_name: string; unit: string };
};

type Delivery = {
  distribution_id: string;
  quantity_dispatched: number;
  dispatch_date: string;
  status: 'in_transit' | 'received' | 'cancelled';
  quantity_received: number | null;
  received_date: string | null;
  food_items: { item_name: string; unit: string };
};

type UsageRow = { item_id: string; meal_type: MealType; consumption_date: string; quantity: number };

const MEAL_TYPES = ['breakfast', 'lunch', 'supper'] as const;
type MealType = (typeof MEAL_TYPES)[number];
const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  supper: 'Supper',
};

const HISTORY_DAYS = 7;
const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

// Local calendar date as YYYY-MM-DD, daysAgo days back, so "today" matches the
// school's day rather than the database server's UTC date.
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
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

// Network admins see dispatches and every school's use; school staff see their own school.
export default function DistributionScreen(props: any) {
  const { isNetworkAdmin } = useSchool();
  return isNetworkAdmin ? (
    <NetworkDistributionScreen {...props} />
  ) : (
    <SchoolDistributionScreen {...props} />
  );
}

function SchoolDistributionScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const [tab, setTab] = useState<'usage' | 'deliveries'>('usage');

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
        {(['usage', 'deliveries'] as const).map((t) => (
          <PressableScale
            key={t}
            style={[styles.segmentItem, tab === t && styles.segmentItemActive]}
            onPress={() => setTab(t)}
            accessibilityState={{ selected: tab === t }}
          >
            <Text style={[styles.segmentText, tab === t && styles.segmentTextActive]}>
              {t === 'usage' ? 'Food used' : 'Received from source'}
            </Text>
          </PressableScale>
        ))}
      </View>

      {tab === 'usage' ? <UsageTab /> : <DeliveriesTab />}
    </View>
  );
}

function UsageTab() {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [daysAgo, setDaysAgo] = useState<0 | 1>(0);
  const [servedMeals, setServedMeals] = useState<MealType[]>([...MEAL_TYPES]);
  const [mealType, setMealType] = useState<MealType>('lunch');
  const [items, setItems] = useState<Item[]>([]);
  const [fed, setFed] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  // item_id -> quantity typed for the selected meal
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Food used can't be edited or deleted, so saving takes two taps: Save, then Confirm.
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const date = localDate(daysAgo);
  const historyStart = localDate(HISTORY_DAYS - 1);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [schoolResult, itemResult, usageResult, fedResult] = await Promise.all([
      supabase
        .from('schools')
        .select('breakfast_start, lunch_start, supper_start')
        .eq('school_id', school.school_id)
        .single(),
      supabase
        .from('inventory_items')
        .select('item_id, quantity_available, food_items(item_name, unit)')
        .eq('school_id', school.school_id),
      supabase
        .from('food_consumption')
        .select('item_id, meal_type, consumption_date, quantity')
        .eq('school_id', school.school_id)
        .gte('consumption_date', historyStart)
        .order('consumption_date', { ascending: false }),
      supabase
        .from('meal_attendance')
        .select('*', { count: 'exact', head: true })
        .eq('school_id', school.school_id)
        .eq('attendance_date', date)
        .eq('meal_type', mealType),
    ]);
    const loadError = schoolResult.error ?? itemResult.error ?? usageResult.error ?? fedResult.error;
    if (loadError) {
      setError(`Could not load food used: ${loadError.message}`);
    } else {
      setError(null);
      // A meal with no serving window isn't served at this school.
      const windows = schoolResult.data as Record<string, string | null>;
      const served = MEAL_TYPES.filter((m) => windows[`${m}_start`] !== null);
      setServedMeals(served.length > 0 ? served : [...MEAL_TYPES]);
      if (served.length > 0 && !served.includes(mealType)) setMealType(served[0]);
      const loaded = (itemResult.data ?? []) as unknown as Item[];
      setItems(loaded.sort((a, b) => a.food_items.item_name.localeCompare(b.food_items.item_name)));
      setUsage((usageResult.data ?? []) as UsageRow[]);
      setFed(fedResult.count ?? 0);
    }
    setLoading(false);
  }, [school.school_id, date, mealType, historyStart]);

  useEffect(() => {
    setConfirming(false);
    loadData();
  }, [loadData]);

  const itemById = new Map(items.map((i) => [i.item_id, i]));
  const recordedForMeal = new Map<string, number>();
  for (const u of usage) {
    if (u.consumption_date === date && u.meal_type === mealType) {
      recordedForMeal.set(u.item_id, (recordedForMeal.get(u.item_id) ?? 0) + Number(u.quantity));
    }
  }

  // The amounts typed so far, checked against what's in stock.
  const entries = items
    .map((i) => ({ item: i, text: (amounts[i.item_id] ?? '').trim() }))
    .filter((e) => e.text !== '');

  function validate() {
    if (entries.length === 0) return 'Enter the amount used for at least one food.';
    for (const { item, text } of entries) {
      const qty = Number(text);
      if (!Number.isFinite(qty) || qty <= 0) {
        return `Enter a number greater than zero for ${item.food_items.item_name}.`;
      }
      if (qty > item.quantity_available) {
        return `Not enough ${item.food_items.item_name}: only ${formatQty(item.quantity_available, item.food_items.unit)} in stock.`;
      }
    }
    return null;
  }

  async function handleSave() {
    const problem = validate();
    if (problem) {
      setError(problem);
      setConfirming(false);
      return;
    }
    setError(null);
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setSaving(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      // One insert for all foods, so either every amount is saved or none is.
      // A database trigger takes each amount out of stock.
      const { error } = await supabase.from('food_consumption').insert(
        entries.map(({ item, text }) => ({
          item_id: item.item_id,
          meal_type: mealType,
          consumption_date: date,
          quantity: Number(text),
          recorded_by: auth.user?.id ?? null,
        }))
      );
      if (error) {
        if (error.code === '23514') {
          setError('Not enough stock for one of these foods. Refresh and check the amounts.');
        } else if (error.code === '42501') {
          setError('You do not have permission to record food used.');
        } else {
          setError(error.message);
        }
        return;
      }
      setAmounts({});
      await loadData();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  }

  // Food used per day and meal over the last week, newest first.
  const history = new Map<string, Map<MealType, { item: Item; quantity: number }[]>>();
  for (const u of usage) {
    const item = itemById.get(u.item_id);
    if (!item) continue;
    const day = history.get(u.consumption_date) ?? new Map();
    history.set(u.consumption_date, day);
    const meal = day.get(u.meal_type) ?? [];
    day.set(u.meal_type, meal);
    const existing = meal.find((m: { item: Item }) => m.item.item_id === u.item_id);
    if (existing) existing.quantity += Number(u.quantity);
    else meal.push({ item, quantity: Number(u.quantity) });
  }

  return (
    <FadeInScrollView
      style={styles.tabBody}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
    >
      <View style={styles.chipRow}>
        {([0, 1] as const).map((d) => (
          <PressableScale
            key={d}
            style={[styles.chip, daysAgo === d && styles.chipActive]}
            onPress={() => setDaysAgo(d)}
            accessibilityState={{ selected: daysAgo === d }}
          >
            <Text style={[styles.chipText, daysAgo === d && styles.chipTextActive]}>
              {d === 0 ? 'Today' : 'Yesterday'}
            </Text>
          </PressableScale>
        ))}
      </View>

      <View style={styles.segment}>
        {servedMeals.map((meal) => (
          <PressableScale
            key={meal}
            style={[styles.segmentItem, mealType === meal && styles.segmentItemActive]}
            onPress={() => setMealType(meal)}
            accessibilityState={{ selected: mealType === meal }}
          >
            <Text style={[styles.segmentText, mealType === meal && styles.segmentTextActive]}>
              {MEAL_LABELS[meal]}
            </Text>
          </PressableScale>
        ))}
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryNumber}>{fed ?? '—'}</Text>
        <Text style={styles.summaryLabel}>
          students at {MEAL_LABELS[mealType].toLowerCase()} · {formatDay(date)}
        </Text>
      </View>

      {!loading && items.length === 0 ? (
        <Text style={styles.emptyLeft}>
          No food in stock yet. Confirm a delivery under "Received from source" first.
        </Text>
      ) : (
        items.map((item) => {
          const recorded = recordedForMeal.get(item.item_id);
          const unit = item.food_items.unit;
          return (
            <View key={item.item_id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>{item.food_items.item_name}</Text>
                <Text style={styles.rowMeta}>
                  {formatQty(item.quantity_available, unit)} in stock
                  {recorded
                    ? ` · ${formatQty(recorded, unit)} used` +
                      (fed ? ` (${formatQty(recorded / fed, unit)} per student)` : '')
                    : ''}
                </Text>
              </View>
              <TextInput
                style={[styles.input, styles.amountInput]}
                placeholderTextColor={colors.placeholder}
                value={amounts[item.item_id] ?? ''}
                onChangeText={(text) => {
                  setAmounts({ ...amounts, [item.item_id]: text });
                  setConfirming(false);
                }}
                keyboardType="decimal-pad"
                placeholder={unit}
                accessibilityLabel={`${item.food_items.item_name} used, in ${unit}`}
              />
            </View>
          );
        })
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {items.length > 0 && (
        <PressableScale
          style={[styles.button, confirming && styles.buttonConfirm]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.buttonText}>
              {confirming
                ? `Confirm: ${entries
                    .map((e) => `${e.item.food_items.item_name} ${formatQty(Number(e.text), e.item.food_items.unit)}`)
                    .join(', ')}`
                : `Save food used at ${MEAL_LABELS[mealType].toLowerCase()}`}
            </Text>
          )}
        </PressableScale>
      )}

      <Text style={styles.sectionTitle}>Food used, last {HISTORY_DAYS} days</Text>
      {history.size === 0 ? (
        <Text style={styles.emptyLeft}>Nothing recorded yet.</Text>
      ) : (
        [...history.entries()].map(([day, meals]) => (
          <View key={day} style={styles.historyDay}>
            <Text style={styles.historyDate}>{formatDay(day)}</Text>
            {MEAL_TYPES.filter((m) => meals.has(m)).map((m) => (
              <Text key={m} style={styles.historyLine}>
                <Text style={styles.historyMeal}>{MEAL_LABELS[m]}: </Text>
                {meals
                  .get(m)!
                  .map((u) => `${u.item.food_items.item_name} ${formatQty(u.quantity, u.item.food_items.unit)}`)
                  .join(', ')}
              </Text>
            ))}
          </View>
        ))
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

function DeliveriesTab() {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, profile } = useSchool();
  const canConfirm = profile.role === 'admin' || profile.role === 'inventory_officer';
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The delivery being confirmed, and the amount that arrived.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDeliveries = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('food_distribution')
      .select(
        'distribution_id, quantity_dispatched, dispatch_date, status, quantity_received, received_date, food_items(item_name, unit)'
      )
      .eq('school_id', school.school_id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      setError(`Could not load deliveries: ${error.message}`);
    } else {
      setError(null);
      setDeliveries((data ?? []) as unknown as Delivery[]);
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  function startConfirm(d: Delivery) {
    setConfirmId(d.distribution_id);
    setReceived(String(d.quantity_dispatched));
    setError(null);
  }

  async function handleConfirm(d: Delivery) {
    const qty = Number(received.trim());
    if (!Number.isFinite(qty) || qty < 0 || qty > d.quantity_dispatched) {
      setError(`Enter the amount that arrived, from 0 to ${formatQty(d.quantity_dispatched, d.food_items.unit)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Adds the amount to the school's stock and records any shortfall.
      const { error } = await supabase.rpc('receive_distribution', {
        p_distribution_id: d.distribution_id,
        p_quantity_received: qty,
      });
      if (error) {
        setError(error.message);
        return;
      }
      setConfirmId(null);
      await loadDeliveries();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const inTransit = deliveries.filter((d) => d.status === 'in_transit');
  const past = deliveries.filter((d) => d.status !== 'in_transit');

  return (
    <FadeInScrollView
      style={styles.tabBody}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={loadDeliveries} />}
    >
      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.sectionTitle}>On the way</Text>
      {inTransit.length === 0 ? (
        <Text style={styles.emptyLeft}>No deliveries on the way.</Text>
      ) : (
        inTransit.map((d) => {
          const unit = d.food_items.unit;
          const isConfirming = confirmId === d.distribution_id;
          return (
            <View key={d.distribution_id} style={styles.card}>
              <Text style={styles.rowName}>
                {d.food_items.item_name} · {formatQty(d.quantity_dispatched, unit)}
              </Text>
              <Text style={styles.rowMeta}>Sent {formatDay(d.dispatch_date)}</Text>
              {!canConfirm ? (
                <Text style={styles.rowMeta}>An admin or inventory officer confirms it on arrival.</Text>
              ) : isConfirming ? (
                <>
                  <Text style={styles.label}>Amount that arrived ({unit})</Text>
                  <View style={styles.inlineRow}>
                    <TextInput
                      style={[styles.input, styles.inlineInput]}
                      placeholderTextColor={colors.placeholder}
                      value={received}
                      onChangeText={setReceived}
                      keyboardType="decimal-pad"
                    />
                    <PressableScale
                      style={styles.inlineButton}
                      onPress={() => handleConfirm(d)}
                      disabled={busy}
                    >
                      {busy ? (
                        <ActivityIndicator color={colors.onPrimary} />
                      ) : (
                        <Text style={styles.inlineButtonText}>Confirm</Text>
                      )}
                    </PressableScale>
                  </View>
                  <PressableScale onPress={() => setConfirmId(null)} disabled={busy}>
                    <Text style={styles.cancelLink}>Cancel</Text>
                  </PressableScale>
                </>
              ) : (
                <PressableScale style={styles.smallButton} onPress={() => startConfirm(d)}>
                  <Text style={styles.inlineButtonText}>Confirm receipt</Text>
                </PressableScale>
              )}
            </View>
          );
        })
      )}

      <Text style={styles.sectionTitle}>Received</Text>
      {past.length === 0 ? (
        <Text style={styles.emptyLeft}>Nothing received yet.</Text>
      ) : (
        past.map((d) => {
          const unit = d.food_items.unit;
          const short = d.status === 'received' ? d.quantity_dispatched - (d.quantity_received ?? 0) : 0;
          return (
            <View key={d.distribution_id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>{d.food_items.item_name}</Text>
                <Text style={styles.rowMeta}>
                  {d.status === 'cancelled'
                    ? `Sent ${formatDay(d.dispatch_date)} · cancelled by the central store`
                    : `Received ${formatDay(d.received_date!)}` +
                      (short > 0 ? ` · ${formatQty(short, unit)} short of ${formatQty(d.quantity_dispatched, unit)}` : '')}
                </Text>
              </View>
              <Text style={d.status === 'cancelled' ? styles.qtyMuted : styles.qtyIn}>
                {d.status === 'cancelled'
                  ? formatQty(d.quantity_dispatched, unit)
                  : `+${formatQty(d.quantity_received ?? 0, unit)}`}
              </Text>
            </View>
          );
        })
      )}
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
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: c.primary, borderColor: c.primary },
  chipText: { fontSize: 14, color: c.text },
  chipTextActive: { color: c.onPrimary, fontWeight: '600' },
  summary: { backgroundColor: c.surface, borderRadius: 12, padding: 16, marginVertical: 16 },
  summaryNumber: { fontSize: 26, fontWeight: '700', color: c.text },
  summaryLabel: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  sectionTitle: { fontSize: 15, fontWeight: '600', marginTop: 24, marginBottom: 10, color: c.text },
  label: { fontSize: 13, color: c.textSecondary, marginBottom: 6, marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: c.text,
  },
  amountInput: { width: 96, textAlign: 'right' },
  inlineRow: { flexDirection: 'row', gap: 8 },
  inlineInput: { flex: 1 },
  inlineButton: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 90,
  },
  inlineButtonText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' },
  smallButton: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    marginTop: 10,
  },
  cancelLink: { color: c.textMuted, fontSize: 14, marginTop: 10 },
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
  rowName: { fontSize: 16, color: c.text },
  rowMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  card: { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 10 },
  historyDay: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.divider },
  historyDate: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 4 },
  historyLine: { fontSize: 14, color: c.textSecondary, marginTop: 2 },
  historyMeal: { color: c.textMuted },
  qtyIn: { color: c.successText, fontWeight: '600' },
  qtyMuted: { color: c.textMuted, textDecorationLine: 'line-through' },
  bottomSpacer: { height: 40 },
});
