import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, RefreshControl } from 'react-native';
import { Card, Divider, HelperText, List, Text, TextInput } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import NetworkDistributionScreen from './NetworkDistributionScreen';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip, SegmentedButtons } from '../components/Paper';
import { Field, ScreenHeader, StatCard } from '../components/ScreenParts';

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
      <ScreenHeader title="Distribution" onBack={() => navigation.goBack()} />

      <SegmentedButtons
        value={tab}
        onValueChange={(t) => setTab(t as typeof tab)}
        buttons={[
          { value: 'usage', label: 'Food used', icon: 'silverware-fork-knife' },
          { value: 'deliveries', label: 'Received from source', icon: 'truck-outline' },
        ]}
      />

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
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={loadData} tintColor={colors.primary} />
      }
    >
      <View style={styles.chipRow}>
        {([0, 1] as const).map((d) => (
          <Chip
            key={d}
            mode={daysAgo === d ? 'flat' : 'outlined'}
            selected={daysAgo === d}
            showSelectedCheck={false}
            icon="calendar-outline"
            onPress={() => setDaysAgo(d)}
          >
            {d === 0 ? 'Today' : 'Yesterday'}
          </Chip>
        ))}
      </View>

      <SegmentedButtons
        value={mealType}
        onValueChange={(meal) => setMealType(meal as MealType)}
        buttons={servedMeals.map((meal) => ({ value: meal, label: MEAL_LABELS[meal] }))}
      />

      <StatCard
        style={styles.summary}
        value={fed ?? '—'}
        label={`students at ${MEAL_LABELS[mealType].toLowerCase()} · ${formatDay(date)}`}
      />

      {!loading && items.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>
          No food in stock yet. Confirm a delivery under "Received from source" first.
        </Text>
      ) : (
        items.map((item, index) => {
          const recorded = recordedForMeal.get(item.item_id);
          const unit = item.food_items.unit;
          return (
            <View key={item.item_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={item.food_items.item_name}
                description={
                  `${formatQty(item.quantity_available, unit)} in stock` +
                  (recorded
                    ? ` · ${formatQty(recorded, unit)} used` +
                      (fed ? ` (${formatQty(recorded / fed, unit)} per student)` : '')
                    : '')
                }
                descriptionNumberOfLines={3}
                style={styles.row}
                contentStyle={styles.rowContent}
                right={() => (
                  <TextInput
                    mode="outlined"
                    dense
                    style={styles.amountInput}
                    contentStyle={styles.amountText}
                    value={amounts[item.item_id] ?? ''}
                    onChangeText={(text) => {
                      setAmounts({ ...amounts, [item.item_id]: text });
                      setConfirming(false);
                    }}
                    keyboardType="decimal-pad"
                    placeholder={unit}
                    accessibilityLabel={`${item.food_items.item_name} used, in ${unit}`}
                  />
                )}
              />
            </View>
          );
        })
      )}

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>

      {items.length > 0 && (
        <Button
          mode="contained"
          icon={confirming ? 'check-all' : 'content-save-outline'}
          buttonColor={confirming ? colors.warning : undefined}
          onPress={handleSave}
          loading={saving}
          disabled={saving}
          contentStyle={styles.buttonContent}
          labelStyle={styles.buttonLabel}
        >
          {confirming
            ? `Confirm: ${entries
                .map((e) => `${e.item.food_items.item_name} ${formatQty(Number(e.text), e.item.food_items.unit)}`)
                .join(', ')}`
            : `Save food used at ${MEAL_LABELS[mealType].toLowerCase()}`}
        </Button>
      )}

      <Text variant="titleSmall" style={styles.sectionTitle}>Food used, last {HISTORY_DAYS} days</Text>
      {history.size === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>Nothing recorded yet.</Text>
      ) : (
        [...history.entries()].map(([day, meals], index) => (
          <View key={day}>
            {index > 0 && <Divider />}
            <View style={styles.historyDay}>
              <Text variant="labelLarge" style={styles.historyDate}>{formatDay(day)}</Text>
              {MEAL_TYPES.filter((m) => meals.has(m)).map((m) => (
                <Text key={m} variant="bodyMedium" style={styles.historyLine}>
                  <Text variant="bodyMedium" style={styles.historyMeal}>{MEAL_LABELS[m]}: </Text>
                  {meals
                    .get(m)!
                    .map((u) => `${u.item.food_items.item_name} ${formatQty(u.quantity, u.item.food_items.unit)}`)
                    .join(', ')}
                </Text>
              ))}
            </View>
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
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={loadDeliveries} tintColor={colors.primary} />
      }
    >
      {error && <HelperText type="error">{error}</HelperText>}

      <Text variant="titleSmall" style={[styles.sectionTitle, styles.firstSection]}>On the way</Text>
      {inTransit.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>No deliveries on the way.</Text>
      ) : (
        inTransit.map((d) => {
          const unit = d.food_items.unit;
          const isConfirming = confirmId === d.distribution_id;
          return (
            <Card key={d.distribution_id} mode="contained" style={styles.card}>
              <Card.Title
                title={`${d.food_items.item_name} · ${formatQty(d.quantity_dispatched, unit)}`}
                subtitle={`Sent ${formatDay(d.dispatch_date)}`}
                left={(props) => <List.Icon {...props} icon="truck-fast-outline" color={colors.primary} />}
              />
              <Card.Content>
                {!canConfirm ? (
                  <Text variant="bodySmall" style={styles.meta}>
                    An admin or inventory officer confirms it on arrival.
                  </Text>
                ) : isConfirming ? (
                  <>
                    <View style={styles.inlineRow}>
                      <Field
                        label={`Amount that arrived (${unit})`}
                        style={styles.inlineInput}
                        value={received}
                        onChangeText={setReceived}
                        keyboardType="decimal-pad"
                      />
                      <Button
                        mode="contained"
                        onPress={() => handleConfirm(d)}
                        loading={busy}
                        disabled={busy}
                        style={styles.inlineButton}
                        contentStyle={styles.buttonContent}
                      >
                        Confirm
                      </Button>
                    </View>
                    <Button
                      mode="text"
                      onPress={() => setConfirmId(null)}
                      disabled={busy}
                      style={styles.cancelButton}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    mode="contained"
                    icon="package-variant-closed-check"
                    onPress={() => startConfirm(d)}
                    style={styles.smallButton}
                  >
                    Confirm receipt
                  </Button>
                )}
              </Card.Content>
            </Card>
          );
        })
      )}

      <Text variant="titleSmall" style={styles.sectionTitle}>Received</Text>
      {past.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>Nothing received yet.</Text>
      ) : (
        past.map((d, index) => {
          const unit = d.food_items.unit;
          const short = d.status === 'received' ? d.quantity_dispatched - (d.quantity_received ?? 0) : 0;
          const cancelled = d.status === 'cancelled';
          return (
            <View key={d.distribution_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={d.food_items.item_name}
                description={
                  cancelled
                    ? `Sent ${formatDay(d.dispatch_date)} · cancelled by the central store`
                    : `Received ${formatDay(d.received_date!)}` +
                      (short > 0 ? ` · ${formatQty(short, unit)} short of ${formatQty(d.quantity_dispatched, unit)}` : '')
                }
                descriptionNumberOfLines={3}
                style={styles.row}
                left={(props) => (
                  <List.Icon
                    {...props}
                    icon={cancelled ? 'close-circle-outline' : 'check-circle-outline'}
                    color={cancelled ? colors.textFaint : colors.successText}
                  />
                )}
                right={() => (
                  <Text variant="titleSmall" style={[styles.qty, cancelled ? styles.qtyMuted : styles.qtyIn]}>
                    {cancelled
                      ? formatQty(d.quantity_dispatched, unit)
                      : `+${formatQty(d.quantity_received ?? 0, unit)}`}
                  </Text>
                )}
              />
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
  tabBody: { flex: 1, marginTop: 16 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  summary: { marginTop: 16 },
  sectionTitle: { marginTop: 24, marginBottom: 10, color: c.text },
  firstSection: { marginTop: 4 },
  meta: { color: c.textMuted },
  amountInput: { width: 104, alignSelf: 'center' },
  amountText: { textAlign: 'right' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineInput: { flex: 1, marginTop: 0 },
  // Lines the button up with the field's outline, below its floating label.
  inlineButton: { marginTop: 6 },
  smallButton: { alignSelf: 'flex-start' },
  cancelButton: { alignSelf: 'flex-start', marginTop: 4 },
  buttonContent: { paddingVertical: 6 },
  // Long "Confirm: …" labels wrap instead of being cut off.
  buttonLabel: { flexShrink: 1, textAlign: 'center' },
  emptyLeft: { color: c.textMuted },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  card: { borderRadius: 16, marginBottom: 10 },
  historyDay: { paddingVertical: 10 },
  historyDate: { color: c.text, marginBottom: 4 },
  historyLine: { color: c.textSecondary, marginTop: 2 },
  historyMeal: { color: c.textMuted },
  qty: { alignSelf: 'center', fontWeight: '600' },
  qtyIn: { color: c.successText },
  qtyMuted: { color: c.textMuted, textDecorationLine: 'line-through' },
  bottomSpacer: { height: 40 },
});
