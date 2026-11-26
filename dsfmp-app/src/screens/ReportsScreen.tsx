import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { Card, Divider, HelperText, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { Button, SegmentedButtons } from '../components/Paper';
import { ScreenHeader, StatusPill } from '../components/ScreenParts';
import { formatPacks, formatQty } from '../lib/units';
import { Cell, htmlTable, escapeHtml, reportHtml, safeFileName, saveCsv, savePdf, toCsv } from '../lib/exportFile';

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
  pack_size: number | null;
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


// ISO weekday (1 = Monday ... 7 = Sunday) of a YYYY-MM-DD date.
function isoWeekday(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getDay() || 7;
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
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
  const { school, profile, can } = useSchool();
  const schoolIds = [school.school_id];
  // Bumped on pull-to-refresh so the micronutrient section reloads too.
  const [refreshKey, setRefreshKey] = useState(0);
  const schoolKey = school.school_id;
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
  // Days in the range on which each meal was served (#3): on the
  // timetable that weekday, and someone attended or the meal was closed
  // as served. The attendance % is out of these days only.
  const [servingDays, setServingDays] = useState<Record<MealKey, number>>({
    breakfast: 0,
    lunch: 0,
    supper: 0,
  });
  const [micro, setMicro] = useState<{ target: string; rows: Map<string, Adequacy> } | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const rangeDays = RANGES.find((r) => r.key === range)!.days;

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRefreshKey((k) => k + 1);
    const dates = datesBack(rangeDays);
    const start = dates[dates.length - 1];
    const end = dates[0];

    try {
      const [beneficiaryResult, itemResult, attendance, consumption, scheduleResult, closureResult] = await Promise.all([
        supabase
          .from('beneficiaries')
          .select('*', { count: 'exact', head: true })
          .in('school_id', schoolIds)
          .eq('status', 'active'),
        supabase
          .from('inventory_items')
          .select('item_id, quantity_available, reorder_level, school_id, food_items(*)')
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
        supabase.from('meal_schedules').select('weekday, meal_type').in('school_id', schoolIds),
        supabase
          .from('meal_closures')
          .select('closure_date, meal_type, status')
          .in('school_id', schoolIds)
          .gte('closure_date', start)
          .lte('closure_date', end),
      ]);
      if (beneficiaryResult.error) throw new Error(beneficiaryResult.error.message);
      if (itemResult.error) throw new Error(itemResult.error.message);
      if (scheduleResult.error) throw new Error(scheduleResult.error.message);

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

      // Serving days per meal. Closures (fix 016) are optional; without
      // them, attendance alone decides.
      const scheduled = new Set((scheduleResult.data ?? []).map((m: any) => `${m.weekday}:${m.meal_type}`));
      const closedServed = new Set(
        (closureResult.error ? [] : closureResult.data ?? [])
          .filter((c: any) => c.status === 'closed')
          .map((c: any) => `${c.closure_date}:${c.meal_type}`)
      );
      const served: Record<MealKey, number> = { breakfast: 0, lunch: 0, supper: 0 };
      for (const day of byDay.values()) {
        for (const m of MEALS) {
          if (!scheduled.has(`${isoWeekday(day.date)}:${m.key}`)) continue;
          if (day.counts[m.key] > 0 || closedServed.has(`${day.date}:${m.key}`)) served[m.key] += 1;
        }
      }

      // Food used per item over the range. Each record is one food at one meal.
      const loadedItems: Item[] = (itemResult.data ?? [])
        .map(({ food_items, ...i }: any) => ({
          ...i,
          item_name: food_items.item_name,
          unit: food_items.unit,
          pack_size: food_items.pack_size ?? null,
        }))
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
      setServingDays(served);
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
  const lowStock = items.filter(
    (i) => (i.reorder_level ?? 0) > 0 && i.quantity_available <= (i.reorder_level ?? 0)
  );

  function attendancePercent(meal: MealKey): number | null {
    if (activeCount === 0 || servingDays[meal] === 0) return null;
    return Math.round((mealTotals[meal] / (activeCount * servingDays[meal])) * 100);
  }

  // ---------------- Export (#1) ----------------
  function sections() {
    const dates = datesBack(rangeDays);
    const start = dates[dates.length - 1];
    const end = dates[0];
    const percent = (m: MealKey) => {
      const p = attendancePercent(m);
      return p === null ? '' : `${p}%`;
    };
    const summary: Cell[][] = MEALS.map((m) => [m.label, mealTotals[m.key], servingDays[m.key], percent(m.key)]);
    const daily: Cell[][] = [...days]
      .reverse()
      .map((d) => [d.date, d.counts.breakfast, d.counts.lunch, d.counts.supper, d.total]);
    const food: Cell[][] = used.map((e) => [e.item.item_name, round3(e.quantity), e.item.unit ?? '', e.meals]);
    const stock: Cell[][] = items.map((i) => [
      i.item_name,
      round3(i.quantity_available),
      i.unit ?? '',
      i.reorder_level ?? '',
      lowStock.includes(i) ? 'LOW' : '',
    ]);
    const nutrients: Cell[][] = micro
      ? MICRONUTRIENTS.flatMap((n) => {
          const r = micro.rows.get(n.key);
          if (!r || r.students === 0) return [];
          return [[n.label, `${Number(r.median_percent ?? 0)}%`, r.below_target, r.students]];
        })
      : [];
    return { start, end, summary, daily, food, stock, nutrients };
  }

  async function exportReport(format: 'csv' | 'pdf') {
    setExporting(format);
    setExportError(null);
    try {
      const s = sections();
      const generated = new Date().toLocaleString();
      const base = safeFileName(`${school.name} report ${s.start} to ${s.end}`);
      const target = micro?.target ?? '30';
      const mealHead = ['Meal', 'Students served', 'Days served', 'Average attendance'];
      const dayHead = ['Date', 'Breakfast', 'Lunch', 'Supper', 'Total'];
      const foodHead = ['Food', 'Quantity', 'Unit', 'Meals'];
      const stockHead = ['Food', 'In stock', 'Unit', 'Reorder level', 'Low'];
      const nutrientHead = ['Nutrient', 'Median share of need', `Students below ${target}%`, 'Students assessed'];

      if (format === 'csv') {
        const rows: Cell[][] = [
          [`${school.name}: feeding report`],
          ['Period', s.start, s.end],
          ['Active students', activeCount],
          ['Generated', generated, profile.full_name],
          [],
          ['Meal attendance'],
          mealHead,
          ...s.summary,
          [],
          ['Attendance by day'],
          dayHead,
          ...s.daily,
          [],
          ['Food used'],
          foodHead,
          ...s.food,
          [],
          ['Current stock'],
          stockHead,
          ...s.stock,
        ];
        if (s.nutrients.length > 0) {
          rows.push([], [`Micronutrients (target ${target}% of daily need)`], nutrientHead, ...s.nutrients);
        }
        await saveCsv(`${base}.csv`, toCsv(rows));
      } else {
        const body = [
          `<h1>${escapeHtml(school.name)}: feeding report</h1>`,
          `<p class="meta">${s.start} to ${s.end} · ${activeCount} active students</p>`,
          `<p class="meta">Generated ${escapeHtml(generated)} by ${escapeHtml(profile.full_name)}</p>`,
          '<h2>Meal attendance</h2>',
          htmlTable(mealHead, s.summary, [1, 2, 3]),
          '<p class="note">Average attendance is the share of active students attending, over the days the meal was served (on the timetable, with at least one student recorded).</p>',
          rangeDays > 1 ? '<h2>Attendance by day</h2>' + htmlTable(dayHead, s.daily, [1, 2, 3, 4]) : '',
          '<h2>Food used</h2>',
          s.food.length ? htmlTable(foodHead, s.food, [1, 3]) : '<p>No food used in this period.</p>',
          '<h2>Current stock</h2>',
          s.stock.length ? htmlTable(stockHead, s.stock, [1, 3]) : '<p>No inventory items yet.</p>',
          s.nutrients.length
            ? "<h2>Micronutrients: students' needs met</h2>" +
              htmlTable(nutrientHead, s.nutrients, [1, 2, 3]) +
              `<p class="note">Share of each student's daily need (FAO/WHO 2004) met by school meals; target ${target}%. Food values: Kenya Food Composition Tables 2018.</p>`
            : '',
        ].join('\n');
        await savePdf(`${base}.pdf`, reportHtml(body));
      }

      // A record of who exported what, in the reports table. A failure
      // here doesn't undo the export.
      await supabase.from('reports').insert({
        school_id: school.school_id,
        report_type: `school_report_${format}`,
        start_date: s.start,
        end_date: s.end,
        generated_by: profile.user_id,
      });
    } catch (e) {
      setExportError(`Could not export: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  }

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

      {error && <HelperText type="error">{error}</HelperText>}

      <View style={styles.exportRow}>
        <Button
          mode="outlined"
          icon="file-delimited-outline"
          onPress={() => exportReport('csv')}
          loading={exporting === 'csv'}
          disabled={loading || exporting !== null}
          style={styles.exportButton}
        >
          Export CSV
        </Button>
        <Button
          mode="outlined"
          icon="file-pdf-box"
          onPress={() => exportReport('pdf')}
          loading={exporting === 'pdf'}
          disabled={loading || exporting !== null}
          style={styles.exportButton}
        >
          Export PDF
        </Button>
      </View>
      {exportError && <HelperText type="error">{exportError}</HelperText>}

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
                  {attendancePercent(m.key) === null ? 'not served' : `${attendancePercent(m.key)}% avg`}
                </Text>
              )}
            </Card.Content>
          </Card>
        ))}
      </View>
      <Text variant="bodySmall" style={styles.note}>
        {totalAttendance.toLocaleString()} meals served · {activeCount} active students. The
        % is the share of active students attending that meal, on average over the days it was
        served (on the timetable, with at least one student recorded). Other days don't count.
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

      {can('view_nutrition') && (
        <MicronutrientSection
          rangeDays={rangeDays}
          refreshKey={refreshKey}
          onLoaded={(target, rows) => setMicro({ target, rows })}
        />
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
                  description={[
                    formatPacks(i.quantity_available, { unit: i.unit ?? '', pack_size: i.pack_size }),

                      `Reorder at ${formatQty(i.reorder_level ?? 0, i.unit)}`,
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  descriptionNumberOfLines={2}
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

// ---------------- Micronutrients (fix 018) ----------------
// For each micronutrient: how many students' school meals give them less
// than a target share of their FAO/WHO daily need, and the median share.

const MICRONUTRIENTS = [
  { key: 'iron_mg', label: 'Iron' },
  { key: 'zinc_mg', label: 'Zinc' },
  { key: 'vitamin_a_re_ug', label: 'Vitamin A' },
  { key: 'folate_ug', label: 'Folate' },
  { key: 'vitamin_b12_ug', label: 'Vitamin B12' },
  { key: 'calcium_mg', label: 'Calcium' },
  { key: 'magnesium_mg', label: 'Magnesium' },
  { key: 'thiamin_mg', label: 'Thiamin (B1)' },
  { key: 'riboflavin_mg', label: 'Riboflavin (B2)' },
  { key: 'niacin_mg', label: 'Niacin (B3)' },
  { key: 'vitamin_c_mg', label: 'Vitamin C' },
] as const;

// One school meal a day is usually planned to cover about 30% of daily
// needs; 50% for two meals; all three meals of a boarding school, 100%.
const TARGETS = [
  { value: '30', label: '30% (1 meal)' },
  { value: '50', label: '50%' },
  { value: '100', label: '100% (boarding)' },
];

type Adequacy = {
  nutrient: string;
  students: number;
  below_target: number;
  median_percent: number | null;
  not_assessed: number;
};

function MicronutrientSection({
  rangeDays,
  refreshKey,
  onLoaded,
}: {
  rangeDays: number;
  refreshKey: number;
  onLoaded: (target: string, rows: Map<string, Adequacy>) => void;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [target, setTarget] = useState('30');
  const [rows, setRows] = useState<Map<string, Adequacy>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dates = datesBack(rangeDays);
      const { data, error } = await supabase.rpc('school_nutrient_adequacy', {
        p_school_id: school.school_id,
        p_from: dates[dates.length - 1],
        p_to: dates[0],
        p_target: Number(target),
      });
      if (cancelled) return;
      if (error) {
        setError(
          error.code === 'PGRST202'
            ? 'Run supabase/fixes/018_nutrient_needs.sql to see how meals meet students\' needs.'
            : error.message
        );
        setRows(new Map());
        onLoaded(target, new Map());
      } else {
        setError(null);
        const loaded = new Map(((data ?? []) as Adequacy[]).map((r) => [r.nutrient, r]));
        setRows(loaded);
        onLoaded(target, loaded);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [school.school_id, rangeDays, target, refreshKey]);

  const assessed = Math.max(0, ...[...rows.values()].map((r) => r.students));
  const notAssessed = Math.max(0, ...[...rows.values()].map((r) => r.not_assessed));

  return (
    <>
      <Text variant="titleMedium" style={styles.sectionTitle}>Micronutrients: students' needs met</Text>
      <SegmentedButtons value={target} onValueChange={setTarget} buttons={TARGETS} />
      {error ? (
        <Text variant="bodyMedium" style={[styles.empty, styles.microGap]}>{error}</Text>
      ) : assessed === 0 ? (
        <Text variant="bodyMedium" style={[styles.empty, styles.microGap]}>
          No meals to assess yet in this period. Students need an age (and a sex from age 10), and
          the dish on the Timetable needs servings.
        </Text>
      ) : (
        <Card mode="outlined" style={styles.card}>
          <Card.Content>
            {MICRONUTRIENTS.map((n) => {
              const r = rows.get(n.key);
              if (!r || r.students === 0) return null;
              const median = Number(r.median_percent ?? 0);
              const short = median < Number(target);
              return (
                <View key={n.key} style={styles.barRow}>
                  <Text variant="labelSmall" style={styles.barLabel}>{n.label}</Text>
                  <View style={styles.barTrack}>
                    <View
                      style={{
                        width: `${Math.min(100, median)}%`,
                        backgroundColor: short ? colors.danger : colors.primary,
                      }}
                    />
                  </View>
                  <Text variant="labelSmall" style={[styles.microValue, short && { color: colors.danger }]}>
                    {median}% · {r.below_target}/{r.students}
                  </Text>
                </View>
              );
            })}
          </Card.Content>
        </Card>
      )}
      {!error && assessed > 0 && (
        <Text variant="bodySmall" style={styles.note}>
          Bar = the median student's share of their daily need from school meals (red if below
          {' '}{target}%); then how many of the {assessed} students assessed are below {target}%.
          Needs are the FAO/WHO (2004) recommended intakes for each student's age and sex; iron and
          zinc needs allow for the phytate in the meals. Food values: Kenya Food Composition Tables 2018.
          {notAssessed > 0
            ? ` ${notAssessed} students who ate weren't assessed: add their age, and sex from age 10.`
            : ''}
        </Text>
      )}
    </>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  microGap: { marginTop: 10 },
  microValue: { width: 86, textAlign: 'right', color: c.textSecondary },
  content: { padding: 20 },
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
  exportRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  exportButton: { flex: 1, borderRadius: 12 },
});
