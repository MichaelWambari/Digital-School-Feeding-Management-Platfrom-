import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';

const MEALS = [
  { key: 'breakfast', label: 'Breakfast', color: '#f59e0b' },
  { key: 'lunch', label: 'Lunch', color: '#2563eb' },
  { key: 'supper', label: 'Supper', color: '#7c3aed' },
] as const;
type MealKey = (typeof MEALS)[number]['key'];

const RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'Last 30 days', days: 30 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

// Supabase returns at most 1000 rows per request, so larger results are paged.
const PAGE_SIZE = 1000;

type Item = {
  item_id: string;
  item_name: string;
  quantity_available: number;
  unit: string | null;
  reorder_level: number | null;
};

type DayRow = { date: string; counts: Record<MealKey, number>; total: number };
type ItemIssued = { item: Item; quantity: number; servings: number };

// Local calendar date as YYYY-MM-DD, matching how attendance and distribution dates are saved.
function localDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function datesBack(days: number) {
  const dates: string[] = [];
  const d = new Date();
  for (let i = 0; i < days; i++) {
    dates.push(localDate(d));
    d.setDate(d.getDate() - 1);
  }
  return dates; // newest first
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

export default function ReportsScreen({ navigation }: any) {
  const [range, setRange] = useState<RangeKey>('week');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [days, setDays] = useState<DayRow[]>([]);
  const [mealTotals, setMealTotals] = useState<Record<MealKey, number>>({
    breakfast: 0,
    lunch: 0,
    supper: 0,
  });
  const [issued, setIssued] = useState<ItemIssued[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const rangeDays = RANGES.find((r) => r.key === range)!.days;

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    const dates = datesBack(rangeDays);
    const start = dates[dates.length - 1];
    const end = dates[0];

    try {
      const [beneficiaryResult, itemResult, attendance, distributions] = await Promise.all([
        supabase
          .from('beneficiaries')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'active'),
        supabase
          .from('inventory_items')
          .select('item_id, item_name, quantity_available, unit, reorder_level')
          .order('item_name'),
        fetchAllRows<{ attendance_date: string; meal_type: string }>((from, to) =>
          supabase
            .from('meal_attendance')
            .select('attendance_date, meal_type')
            .gte('attendance_date', start)
            .lte('attendance_date', end)
            .order('attendance_id')
            .range(from, to)
        ),
        fetchAllRows<{ item_id: string; quantity_issued: number }>((from, to) =>
          supabase
            .from('food_distribution')
            .select('item_id, quantity_issued')
            .gte('distribution_date', start)
            .lte('distribution_date', end)
            .order('distribution_id')
            .range(from, to)
        ),
      ]);
      if (beneficiaryResult.error) throw new Error(beneficiaryResult.error.message);
      if (itemResult.error) throw new Error(itemResult.error.message);

      // Attendance per day and meal, with a row for every day even when nobody attended.
      const byDay = new Map<string, DayRow>(
        dates.map((date) => [
          date,
          { date, counts: { breakfast: 0, lunch: 0, supper: 0 }, total: 0 },
        ])
      );
      const totals: Record<MealKey, number> = { breakfast: 0, lunch: 0, supper: 0 };
      for (const a of attendance) {
        const day = byDay.get(a.attendance_date);
        const meal = a.meal_type as MealKey;
        if (!day || !(meal in totals)) continue;
        day.counts[meal] += 1;
        day.total += 1;
        totals[meal] += 1;
      }

      // Food issued per item over the range.
      const loadedItems = itemResult.data ?? [];
      const byItem = new Map<string, ItemIssued>(
        loadedItems.map((item) => [item.item_id, { item, quantity: 0, servings: 0 }])
      );
      for (const d of distributions) {
        const entry = byItem.get(d.item_id);
        if (!entry) continue;
        entry.quantity += Number(d.quantity_issued);
        entry.servings += 1;
      }

      setActiveCount(beneficiaryResult.count ?? 0);
      setItems(loadedItems);
      setDays([...byDay.values()]);
      setMealTotals(totals);
      setIssued(
        [...byItem.values()].filter((e) => e.servings > 0).sort((a, b) => b.servings - a.servings)
      );
    } catch (e) {
      setError(`Could not load report: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [rangeDays]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const totalAttendance = mealTotals.breakfast + mealTotals.lunch + mealTotals.supper;
  const busiestDay = Math.max(1, ...days.map((d) => d.total));
  const lowStock = items.filter(
    (i) => (i.reorder_level ?? 0) > 0 && i.quantity_available <= (i.reorder_level ?? 0)
  );

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={loadReport} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reports</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.segment}>
        {RANGES.map((r) => (
          <TouchableOpacity
            key={r.key}
            style={[styles.segmentItem, range === r.key && styles.segmentItemActive]}
            onPress={() => setRange(r.key)}
            accessibilityState={{ selected: range === r.key }}
          >
            <Text style={[styles.segmentText, range === r.key && styles.segmentTextActive]}>
              {r.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {/* ---------------- Attendance ---------------- */}
      <Text style={styles.sectionTitle}>Meal attendance</Text>
      <View style={styles.tiles}>
        {MEALS.map((m) => (
          <View key={m.key} style={styles.tile}>
            <Text style={styles.tileNumber}>{mealTotals[m.key].toLocaleString()}</Text>
            <Text style={styles.tileLabel}>{m.label}</Text>
            {activeCount > 0 && (
              <Text style={styles.tileMeta}>
                {Math.round((mealTotals[m.key] / (activeCount * rangeDays)) * 100)}% avg
              </Text>
            )}
          </View>
        ))}
      </View>
      <Text style={styles.note}>
        {totalAttendance.toLocaleString()} meals served · {activeCount} active beneficiaries. The
        % is the share of active beneficiaries attending that meal each day, on average.
      </Text>

      {rangeDays > 1 && (
        <View style={styles.card}>
          <View style={styles.legend}>
            {MEALS.map((m) => (
              <View key={m.key} style={styles.legendItem}>
                <View style={[styles.legendSwatch, { backgroundColor: m.color }]} />
                <Text style={styles.legendText}>{m.label}</Text>
              </View>
            ))}
          </View>
          {days.map((day) => (
            <View key={day.date} style={styles.barRow}>
              <Text style={styles.barLabel}>{formatDay(day.date)}</Text>
              <View style={styles.barTrack}>
                {MEALS.map((m) =>
                  day.counts[m.key] > 0 ? (
                    <View
                      key={m.key}
                      style={{
                        width: `${(day.counts[m.key] / busiestDay) * 100}%`,
                        backgroundColor: m.color,
                      }}
                    />
                  ) : null
                )}
              </View>
              <Text style={styles.barValue}>{day.total}</Text>
            </View>
          ))}
        </View>
      )}

      {/* ---------------- Distribution ---------------- */}
      <Text style={styles.sectionTitle}>Food distributed</Text>
      {issued.length === 0 ? (
        <Text style={styles.empty}>No food distributed in this period.</Text>
      ) : (
        <View style={styles.card}>
          {issued.map((e) => (
            <View key={e.item.item_id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>{e.item.item_name}</Text>
                <Text style={styles.rowMeta}>
                  {e.servings.toLocaleString()} {e.servings === 1 ? 'serving' : 'servings'}
                </Text>
              </View>
              <Text style={styles.rowValue}>{formatQty(e.quantity, e.item.unit)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* ---------------- Stock ---------------- */}
      <Text style={styles.sectionTitle}>Current stock</Text>
      <Text style={styles.note}>
        {lowStock.length === 0
          ? 'No items are low on stock.'
          : `${lowStock.length} ${lowStock.length === 1 ? 'item is' : 'items are'} at or below the reorder level.`}
      </Text>
      {items.length === 0 ? (
        <Text style={styles.empty}>No inventory items yet.</Text>
      ) : (
        <View style={styles.card}>
          {items.map((i) => {
            const low = lowStock.includes(i);
            return (
              <View key={i.item_id} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowName}>{i.item_name}</Text>
                  <Text style={styles.rowMeta}>
                    Reorder at {formatQty(i.reorder_level ?? 0, i.unit)}
                  </Text>
                </View>
                <Text style={[styles.rowValue, low && styles.lowValue]}>
                  {formatQty(i.quantity_available, i.unit)}
                  {low ? ' · Low' : ''}
                </Text>
              </View>
            );
          })}
        </View>
      )}
      <View style={styles.bottomSpacer} />
    </ScrollView>
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
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: '#ccc', borderRadius: 8 },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: '#2563eb', borderRadius: 7 },
  segmentText: { fontSize: 14, color: '#444' },
  segmentTextActive: { color: '#fff', fontWeight: '600' },
  error: { color: '#dc2626', fontSize: 13, marginTop: 12 },
  sectionTitle: { fontSize: 17, fontWeight: '700', marginTop: 28, marginBottom: 10 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, backgroundColor: '#f3f4f6', borderRadius: 12, padding: 12 },
  tileNumber: { fontSize: 22, fontWeight: '700' },
  tileLabel: { fontSize: 13, color: '#444', marginTop: 2 },
  tileMeta: { fontSize: 12, color: '#666', marginTop: 2 },
  note: { fontSize: 13, color: '#666', marginTop: 10 },
  card: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginTop: 12,
  },
  legend: { flexDirection: 'row', gap: 14, paddingVertical: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { fontSize: 12, color: '#444' },
  barRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  barLabel: { width: 92, fontSize: 12, color: '#444' },
  barTrack: {
    flex: 1,
    height: 14,
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 3,
    overflow: 'hidden',
  },
  barValue: { width: 40, textAlign: 'right', fontSize: 12, color: '#444' },
  empty: { color: '#666', fontSize: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 15 },
  rowMeta: { fontSize: 12, color: '#666', marginTop: 2 },
  rowValue: { fontSize: 15, fontWeight: '600' },
  lowValue: { color: '#b45309' },
  bottomSpacer: { height: 40 },
});
