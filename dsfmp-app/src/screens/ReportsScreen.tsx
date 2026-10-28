import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { Card, Divider, HelperText, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { SegmentedButtons } from '../components/Paper';
import { ScreenHeader, StatusPill } from '../components/ScreenParts';

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
  school_id: string;
};

type DayRow = { date: string; counts: Record<MealKey, number>; total: number };
type ItemUsed = { item: Item; quantity: number; meals: number };

// Local calendar date as YYYY-MM-DD, matching how attendance and food-used dates are saved.
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
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, schools, isNetworkAdmin } = useSchool();
  // Network admins can report on the selected school or the whole network.
  const [scope, setScope] = useState<'school' | 'all'>('school');
  const allSchools = isNetworkAdmin && scope === 'all';
  const schoolIds = allSchools ? schools.map((s) => s.school_id) : [school.school_id];
  const schoolKey = schoolIds.join(',');
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
  const [used, setUsed] = useState<ItemUsed[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const rangeDays = RANGES.find((r) => r.key === range)!.days;

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    const dates = datesBack(rangeDays);
    const start = dates[dates.length - 1];
    const end = dates[0];

    try {
      const [beneficiaryResult, itemResult, attendance, consumption] = await Promise.all([
        supabase
          .from('beneficiaries')
          .select('*', { count: 'exact', head: true })
          .in('school_id', schoolIds)
          .eq('status', 'active'),
        supabase
          .from('inventory_items')
          .select('item_id, quantity_available, reorder_level, school_id, food_items(item_name, unit)')
          .in('school_id', schoolIds),
        fetchAllRows<{ attendance_date: string; meal_type: string }>((from, to) =>
          supabase
            .from('meal_attendance')
            .select('attendance_date, meal_type')
            .in('school_id', schoolIds)
            .gte('attendance_date', start)
            .lte('attendance_date', end)
            .order('attendance_id')
            .range(from, to)
        ),
        fetchAllRows<{ item_id: string; quantity: number }>((from, to) =>
          supabase
            .from('food_consumption')
            .select('item_id, quantity')
            .in('school_id', schoolIds)
            .gte('consumption_date', start)
            .lte('consumption_date', end)
            .order('consumption_id')
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

      // Food used per item over the range. Each record is one food at one meal.
      const loadedItems: Item[] = (itemResult.data ?? [])
        .map(({ food_items, ...i }: any) => ({ ...i, item_name: food_items.item_name, unit: food_items.unit }))
        .sort((a: Item, b: Item) => a.item_name.localeCompare(b.item_name));
      const byItem = new Map<string, ItemUsed>(
        loadedItems.map((item) => [item.item_id, { item, quantity: 0, meals: 0 }])
      );
      for (const c of consumption) {
        const entry = byItem.get(c.item_id);
        if (!entry) continue;
        entry.quantity += Number(c.quantity);
        entry.meals += 1;
      }

      setActiveCount(beneficiaryResult.count ?? 0);
      setItems(loadedItems);
      setDays([...byDay.values()]);
      setMealTotals(totals);
      setUsed([...byItem.values()].filter((e) => e.meals > 0).sort((a, b) => b.meals - a.meals));
    } catch (e) {
      setError(`Could not load report: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
    // schoolKey changes whenever schoolIds does, so it stands in for the array here.
  }, [rangeDays, schoolKey]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const totalAttendance = mealTotals.breakfast + mealTotals.lunch + mealTotals.supper;
  const busiestDay = Math.max(1, ...days.map((d) => d.total));
  const schoolName = (id: string) => schools.find((s) => s.school_id === id)?.name ?? '';
  const lowStock = items.filter(
    (i) => (i.reorder_level ?? 0) > 0 && i.quantity_available <= (i.reorder_level ?? 0)
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={loadReport} tintColor={colors.primary} />
      }
    >
      <ScreenHeader title="Reports" onBack={() => navigation.goBack()} />

      <SegmentedButtons
        value={range}
        onValueChange={(r) => setRange(r as RangeKey)}
        buttons={RANGES.map((r) => ({ value: r.key, label: r.label }))}
      />

      {isNetworkAdmin && schools.length > 1 && (
        <SegmentedButtons
          style={styles.scopeSegment}
          value={scope}
          onValueChange={(s) => setScope(s as typeof scope)}
          buttons={[
            { value: 'school', label: school.name, icon: 'school-outline' },
            { value: 'all', label: 'All schools', icon: 'domain' },
          ]}
        />
      )}

      {error && <HelperText type="error">{error}</HelperText>}

      {/* ---------------- Attendance ---------------- */}
      <Text variant="titleMedium" style={styles.sectionTitle}>Meal attendance</Text>
      <View style={styles.tiles}>
        {MEALS.map((m) => (
          <Card key={m.key} mode="contained" style={styles.tile}>
            <Card.Content style={styles.tileContent}>
              <View style={[styles.tileSwatch, { backgroundColor: m.color }]} />
              <Text variant="headlineSmall" style={styles.tileNumber}>
                {mealTotals[m.key].toLocaleString()}
              </Text>
              <Text variant="bodySmall" style={styles.tileLabel}>{m.label}</Text>
              {activeCount > 0 && (
                <Text variant="labelSmall" style={styles.tileMeta}>
                  {Math.round((mealTotals[m.key] / (activeCount * rangeDays)) * 100)}% avg
                </Text>
              )}
            </Card.Content>
          </Card>
        ))}
      </View>
      <Text variant="bodySmall" style={styles.note}>
        {totalAttendance.toLocaleString()} meals served · {activeCount} active students. The
        % is the share of active students attending that meal each day, on average.
      </Text>

      {rangeDays > 1 && (
        <Card mode="outlined" style={styles.card}>
          <Card.Content>
            <View style={styles.legend}>
              {MEALS.map((m) => (
                <View key={m.key} style={styles.legendItem}>
                  <View style={[styles.legendSwatch, { backgroundColor: m.color }]} />
                  <Text variant="labelSmall" style={styles.legendText}>{m.label}</Text>
                </View>
              ))}
            </View>
            {days.map((day) => (
              <View key={day.date} style={styles.barRow}>
                <Text variant="labelSmall" style={styles.barLabel}>{formatDay(day.date)}</Text>
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
                <Text variant="labelSmall" style={styles.barValue}>{day.total}</Text>
              </View>
            ))}
          </Card.Content>
        </Card>
      )}

      {/* ---------------- Food used ---------------- */}
      <Text variant="titleMedium" style={styles.sectionTitle}>Food used</Text>
      {used.length === 0 ? (
        <Text variant="bodyMedium" style={styles.empty}>No food used in this period.</Text>
      ) : (
        <Card mode="outlined" style={styles.card}>
          {used.map((e, index) => (
            <View key={e.item.item_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={e.item.item_name}
                description={
                  (allSchools ? `${schoolName(e.item.school_id)} · ` : '') +
                  `used at ${e.meals.toLocaleString()} ${e.meals === 1 ? 'meal' : 'meals'}`
                }
                right={() => (
                  <Text variant="titleSmall" style={styles.rowValue}>
                    {formatQty(e.quantity, e.item.unit)}
                  </Text>
                )}
              />
            </View>
          ))}
        </Card>
      )}

      {/* ---------------- Stock ---------------- */}
      <Text variant="titleMedium" style={styles.sectionTitle}>Current stock</Text>
      <Text variant="bodySmall" style={[styles.note, styles.stockNote]}>
        {lowStock.length === 0
          ? 'No items are low on stock.'
          : `${lowStock.length} ${lowStock.length === 1 ? 'item is' : 'items are'} at or below the reorder level.`}
      </Text>
      {items.length === 0 ? (
        <Text variant="bodyMedium" style={styles.empty}>No inventory items yet.</Text>
      ) : (
        <Card mode="outlined" style={styles.card}>
          {items.map((i, index) => {
            const low = lowStock.includes(i);
            return (
              <View key={i.item_id}>
                {index > 0 && <Divider />}
                <List.Item
                  title={i.item_name}
                  description={
                    (allSchools ? `${schoolName(i.school_id)} · ` : '') +
                    `Reorder at ${formatQty(i.reorder_level ?? 0, i.unit)}`
                  }
                  right={() => (
                    <View style={styles.rowRight}>
                      <Text variant="titleSmall" style={styles.rowValue}>
                        {formatQty(i.quantity_available, i.unit)}
                      </Text>
                      {low && <StatusPill label="Low" tone="warning" style={styles.lowPill} />}
                    </View>
                  )}
                />
              </View>
            );
          })}
        </Card>
      )}
      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 20 },
  scopeSegment: { marginTop: 10 },
  sectionTitle: { fontWeight: '700', marginTop: 28, marginBottom: 10, color: c.text },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, borderRadius: 16 },
  tileContent: { paddingHorizontal: 12 },
  tileSwatch: { width: 18, height: 4, borderRadius: 2, marginBottom: 8 },
  tileNumber: { fontWeight: '700', color: c.text },
  tileLabel: { color: c.textSecondary, marginTop: 2 },
  tileMeta: { color: c.textMuted, marginTop: 2 },
  note: { color: c.textMuted, marginTop: 10 },
  stockNote: { marginTop: 0 },
  card: { borderRadius: 16, marginTop: 12, overflow: 'hidden' },
  legend: { flexDirection: 'row', gap: 14, paddingBottom: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { color: c.textSecondary },
  barRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  barLabel: { width: 92, color: c.textSecondary },
  barTrack: {
    flex: 1,
    height: 14,
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderRadius: 3,
    overflow: 'hidden',
  },
  barValue: { width: 40, textAlign: 'right', color: c.textSecondary },
  empty: { color: c.textMuted },
  rowRight: { alignItems: 'flex-end', justifyContent: 'center' },
  rowValue: { alignSelf: 'center', fontWeight: '600', color: c.text },
  lowPill: { alignSelf: 'flex-end', marginTop: 4 },
  bottomSpacer: { height: 40 },
});
