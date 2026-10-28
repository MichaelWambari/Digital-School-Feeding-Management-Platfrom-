import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { Card, DataTable, Divider, HelperText, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip, SegmentedButtons } from '../components/Paper';
import { Field, ScreenHeader, StatusPill } from '../components/ScreenParts';

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
      <ScreenHeader title="Distribution" onBack={() => navigation.goBack()} />

      <SegmentedButtons
        value={tab}
        onValueChange={(t) => setTab(t as typeof tab)}
        buttons={[
          { value: 'dispatch', label: 'Dispatch to schools', icon: 'truck-delivery-outline' },
          { value: 'schools', label: 'Use by school', icon: 'chart-bar' },
        ]}
      />

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
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={loadData} tintColor={colors.primary} />
      }
    >
      <Text variant="labelLarge" style={styles.label}>School</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContent}>
        {schools.map((s) => (
          <Chip
            key={s.school_id}
            mode={s.school_id === schoolId ? 'flat' : 'outlined'}
            selected={s.school_id === schoolId}
            showSelectedCheck={false}
            icon="school-outline"
            onPress={() => {
              setSchoolId(s.school_id);
              setConfirming(false);
            }}
          >
            {s.name}
          </Chip>
        ))}
      </ScrollView>

      <Text variant="labelLarge" style={styles.label}>Food</Text>
      {!loading && foods.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>
          No foods yet. Add foods and record a delivery in Inventory first.
        </Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContent}>
          {foods.map((f) => (
            <Chip
              key={f.food_id}
              mode={f.food_id === foodId ? 'flat' : 'outlined'}
              selected={f.food_id === foodId}
              showSelectedCheck={false}
              onPress={() => {
                setFoodId(f.food_id);
                setConfirming(false);
              }}
            >
              {f.item_name} · {formatQty(f.quantity_available, f.unit)} in store
            </Chip>
          ))}
        </ScrollView>
      )}

      <Field
        label={`Quantity to send${food ? ` (${food.unit})` : ''}`}
        style={styles.quantity}
        value={quantity}
        onChangeText={(text) => {
          setQuantity(text);
          setConfirming(false);
        }}
        keyboardType="decimal-pad"
        placeholder="0"
      />

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>

      <Button
        mode="contained"
        icon={confirming ? 'check-all' : 'truck-delivery-outline'}
        buttonColor={confirming ? colors.warning : undefined}
        onPress={handleDispatch}
        loading={busy && cancelId === null}
        disabled={busy || !food || !school}
        contentStyle={styles.buttonContent}
        labelStyle={styles.buttonLabel}
      >
        {confirming && food && school
          ? `Confirm: send ${formatQty(Number(quantity), food.unit)} of ${food.item_name} to ${school.name}`
          : 'Dispatch'}
      </Button>

      <Text variant="titleSmall" style={styles.sectionTitle}>Recent dispatches</Text>
      {dispatches.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>Nothing dispatched yet.</Text>
      ) : (
        dispatches.map((d, index) => {
          const f = foodById.get(d.food_id);
          const unit = f?.unit ?? null;
          const short = d.status === 'received' ? d.quantity_dispatched - (d.quantity_received ?? 0) : 0;
          const confirmingCancel = cancelId === d.distribution_id;
          return (
            <View key={d.distribution_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={`${f?.item_name ?? 'Food'} · ${formatQty(d.quantity_dispatched, unit)} to ${schoolName(d.school_id)}`}
                titleNumberOfLines={2}
                description={
                  `Sent ${formatDay(d.dispatch_date)}` +
                  (d.status === 'received'
                    ? ` · received ${formatDay(d.received_date!)}` +
                      (short > 0 ? `, ${formatQty(short, unit)} short` : ' in full')
                    : '')
                }
                style={styles.row}
                contentStyle={styles.rowContent}
                right={() =>
                  d.status === 'in_transit' ? (
                    <View style={styles.rowRight}>
                      <StatusPill label="In transit" tone="warning" />
                      <Button
                        mode={confirmingCancel ? 'contained' : 'outlined'}
                        compact
                        buttonColor={confirmingCancel ? colors.danger : undefined}
                        textColor={confirmingCancel ? colors.onPrimary : colors.danger}
                        onPress={() => handleCancel(d)}
                        disabled={busy}
                        style={styles.cancelButton}
                      >
                        {confirmingCancel ? 'Confirm cancel' : 'Cancel'}
                      </Button>
                    </View>
                  ) : d.status === 'cancelled' ? (
                    <StatusPill label="Cancelled" tone="muted" style={styles.pill} />
                  ) : (
                    <StatusPill
                      label={short > 0 ? 'Short' : 'Received'}
                      tone={short > 0 ? 'danger' : 'success'}
                      style={styles.pill}
                    />
                  )
                }
              />
            </View>
          );
        })
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

function SchoolsTab() {
  const { colors, styles } = useThemedStyles(makeStyles);
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
    if (shown.length === 0) {
      return <Text variant="bodyMedium" style={styles.emptyLeft}>No food sent or used yet.</Text>;
    }
    return (
      <DataTable>
        <DataTable.Header style={styles.tableRow}>
          <DataTable.Title style={styles.foodCol}>Food</DataTable.Title>
          <DataTable.Title numeric>Sent</DataTable.Title>
          <DataTable.Title numeric>Used</DataTable.Title>
          <DataTable.Title numeric>In stock</DataTable.Title>
        </DataTable.Header>
        {shown.map((f) => {
          const t = rows!.get(f.food_id)!;
          return (
            <DataTable.Row key={f.food_id} style={styles.tableRow}>
              <DataTable.Cell style={styles.foodCol}>{f.item_name}</DataTable.Cell>
              <DataTable.Cell numeric>{formatQty(t.sent, f.unit)}</DataTable.Cell>
              <DataTable.Cell numeric>{formatQty(t.used, f.unit)}</DataTable.Cell>
              <DataTable.Cell numeric>{formatQty(t.inStock, f.unit)}</DataTable.Cell>
            </DataTable.Row>
          );
        })}
      </DataTable>
    );
  }

  return (
    <FadeInScrollView
      style={styles.tabBody}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={loadData} tintColor={colors.primary} />
      }
    >
      <View style={styles.chipRow}>
        {RANGES.map((r) => (
          <Chip
            key={r.key}
            mode={range === r.key ? 'flat' : 'outlined'}
            selected={range === r.key}
            showSelectedCheck={false}
            icon="calendar-range"
            onPress={() => setRange(r.key)}
          >
            {r.label}
          </Chip>
        ))}
      </View>
      <Text variant="bodySmall" style={styles.hint}>
        Sent: dispatched in this period. Used: recorded at the school's meals. In stock: now.
      </Text>

      {error && <HelperText type="error">{error}</HelperText>}

      <Card mode="contained" style={styles.card}>
        <Card.Title title="All schools" titleVariant="titleMedium" titleStyle={styles.cardTitle} />
        <Card.Content>{renderTable(network)}</Card.Content>
      </Card>

      {schools.map((s) => {
        const transit = inTransit.get(s.school_id) ?? 0;
        return (
          <Card key={s.school_id} mode="contained" style={styles.card}>
            <Card.Title
              title={s.name}
              titleVariant="titleMedium"
              titleStyle={styles.cardTitle}
              right={() =>
                transit > 0 ? (
                  <StatusPill
                    label={`${transit} ${transit === 1 ? 'delivery' : 'deliveries'} in transit`}
                    tone="warning"
                    style={styles.transitPill}
                  />
                ) : null
              }
            />
            <Card.Content>{renderTable(totals.get(s.school_id))}</Card.Content>
          </Card>
        );
      })}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  tabBody: { flex: 1, marginTop: 16 },
  label: { color: c.textSecondary, marginBottom: 8, marginTop: 12 },
  hint: { color: c.textMuted, marginBottom: 12 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chipsContent: { gap: 8 },
  quantity: { marginTop: 16 },
  buttonContent: { paddingVertical: 6 },
  // Long "Confirm: …" labels wrap instead of being cut off.
  buttonLabel: { flexShrink: 1, textAlign: 'center' },
  sectionTitle: { marginTop: 24, marginBottom: 4, color: c.text },
  emptyLeft: { color: c.textMuted },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  rowRight: { alignItems: 'flex-end', justifyContent: 'center', gap: 6 },
  pill: { alignSelf: 'center' },
  cancelButton: { borderColor: c.danger },
  card: { borderRadius: 16, marginBottom: 12 },
  cardTitle: { fontWeight: '700', color: c.text },
  transitPill: { marginRight: 16 },
  tableRow: { paddingHorizontal: 0 },
  foodCol: { flex: 1.4 },
  bottomSpacer: { height: 40 },
});
