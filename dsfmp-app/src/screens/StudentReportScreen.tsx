import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, RefreshControl } from 'react-native';
import { Card, Divider, HelperText, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { SegmentedButtons } from '../components/Paper';
import { ScreenHeader, StatCard, StatusPill } from '../components/ScreenParts';

type MealType = 'breakfast' | 'lunch' | 'supper';
type Attendance = { attendance_id: string; attendance_date: string; meal_type: MealType };
type NutrientKey =
  | 'energy_kcal'
  | 'protein_g'
  | 'carbohydrate_g'
  | 'fat_g'
  | 'fibre_g'
  | 'calcium_mg'
  | 'iron_mg'
  | 'zinc_mg'
  | 'vitamin_a_ug'
  | 'vitamin_c_mg';
type Record_ = {
  attendance_id: string;
  meal_name: string | null;
  complete: boolean;
} & Partial<Record<NutrientKey, number | null>>;

const NUTRIENTS: { key: NutrientKey; label: string; unit: string; digits: number }[] = [
  { key: 'energy_kcal', label: 'Energy', unit: 'kcal', digits: 0 },
  { key: 'protein_g', label: 'Protein', unit: 'g', digits: 1 },
  { key: 'carbohydrate_g', label: 'Carbohydrates', unit: 'g', digits: 1 },
  { key: 'fat_g', label: 'Fat', unit: 'g', digits: 1 },
  { key: 'fibre_g', label: 'Fibre', unit: 'g', digits: 1 },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', digits: 0 },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', digits: 1 },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', digits: 1 },
  { key: 'vitamin_a_ug', label: 'Vitamin A', unit: 'µg', digits: 0 },
  { key: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg', digits: 0 },
];

const MEALS: MealType[] = ['breakfast', 'lunch', 'supper'];
const MEAL_LABELS: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', supper: 'Supper' };
const RANGES = [
  { key: '7', label: '7 days', days: 7 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: 'Term (90 days)', days: 90 },
];

function localDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const fmt = (n: number, digits: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });

// One student's feeding history: meals attended and the estimated
// nutrients of the standard servings they were provided.
export default function StudentReportScreen({ navigation, route }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { can } = useSchool();
  const { beneficiaryId, name, admissionNo } = route.params as {
    beneficiaryId: string;
    name: string;
    admissionNo: string;
  };
  const seesNutrition = can('view_nutrition');
  const [range, setRange] = useState('30');
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [records, setRecords] = useState<Map<string, Record_>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const days = RANGES.find((r) => r.key === range)!.days;
  const start = localDate(days - 1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [attendanceResult, nutritionResult] = await Promise.all([
      supabase
        .from('meal_attendance')
        .select('attendance_id, attendance_date, meal_type')
        .eq('beneficiary_id', beneficiaryId)
        .gte('attendance_date', start)
        .order('attendance_date', { ascending: false }),
      seesNutrition
        ? supabase
            .from('attendance_nutrition')
            .select('attendance_id, meal_name, complete, ' + NUTRIENTS.map((n) => n.key).join(', '))
            .eq('beneficiary_id', beneficiaryId)
            .gte('attendance_date', start)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (attendanceResult.error) {
      setError(`Could not load the report: ${attendanceResult.error.message}`);
    } else {
      setAttendance((attendanceResult.data ?? []) as Attendance[]);
      // Without fix 012 there are no nutrition records; attendance still shows.
      const rows = nutritionResult.error ? [] : ((nutritionResult.data ?? []) as unknown as Record_[]);
      setRecords(new Map(rows.map((r) => [r.attendance_id, r])));
    }
    setLoading(false);
  }, [beneficiaryId, start, seesNutrition]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = useMemo(() => {
    const byMeal: Record<MealType, number> = { breakfast: 0, lunch: 0, supper: 0 };
    const totals = Object.fromEntries(NUTRIENTS.map((n) => [n.key, 0])) as Record<NutrientKey, number>;
    const energyByDay = new Map<string, number>();
    let estimated = 0;
    let incomplete = 0;
    for (const a of attendance) {
      byMeal[a.meal_type] = (byMeal[a.meal_type] ?? 0) + 1;
      const r = records.get(a.attendance_id);
      if (r && r.meal_name) {
        estimated += 1;
        if (!r.complete) incomplete += 1;
        for (const n of NUTRIENTS) totals[n.key] += Number(r[n.key] ?? 0);
        energyByDay.set(a.attendance_date, (energyByDay.get(a.attendance_date) ?? 0) + Number(r.energy_kcal ?? 0));
      }
    }
    const daysFed = new Set(attendance.map((a) => a.attendance_date)).size;
    const daysEstimated = energyByDay.size;
    return { byMeal, totals, energyByDay, estimated, incomplete, daysFed, daysEstimated };
  }, [attendance, records]);

  // The last 14 days of the range, oldest first, for the energy chart.
  const chartDays = Array.from({ length: Math.min(days, 14) }, (_, i) => localDate(Math.min(days, 14) - 1 - i));
  const maxEnergy = Math.max(1, ...chartDays.map((d) => summary.energyByDay.get(d) ?? 0));

  return (
    <FadeInScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
    >
      <ScreenHeader title={name} onBack={() => navigation.goBack()} backLabel="Students" />
      <Text variant="bodySmall" style={styles.meta}>{admissionNo} · Feeding report</Text>

      <SegmentedButtons
        value={range}
        onValueChange={setRange}
        buttons={RANGES.map((r) => ({ value: r.key, label: r.label }))}
      />

      {error && <HelperText type="error">{error}</HelperText>}

      <Text variant="titleMedium" style={styles.sectionTitle}>Meals attended</Text>
      <View style={styles.tiles}>
        <StatCard style={styles.tile} value={attendance.length} label={`meals · ${summary.daysFed} days`} />
        {MEALS.map((m) => (
          <StatCard key={m} style={styles.tile} value={summary.byMeal[m]} label={MEAL_LABELS[m].toLowerCase()} />
        ))}
      </View>

      {seesNutrition ? (
        <>
          <Text variant="titleMedium" style={styles.sectionTitle}>Estimated nutrition provided</Text>
          <Text variant="bodySmall" style={styles.meta}>
            Worked out from each dish's standard serving and the meals attended. It shows the food
            provided, not what {name.split(' ')[0]} actually ate.
          </Text>
          {summary.estimated === 0 ? (
            <Text variant="bodyMedium" style={styles.empty}>
              No estimates yet for this period. They appear for meals recorded once the dish on the
              Timetable has a serving.
            </Text>
          ) : (
            <Card mode="contained" style={styles.card}>
              <Card.Content>
                <View style={styles.tableHead}>
                  <Text variant="labelMedium" style={styles.cellName}>Nutrient</Text>
                  <Text variant="labelMedium" style={styles.cellValue}>Per day</Text>
                  <Text variant="labelMedium" style={styles.cellValue}>Total</Text>
                </View>
                {NUTRIENTS.map((n) => (
                  <View key={n.key} style={styles.tableRow}>
                    <Text variant="bodyMedium" style={styles.cellName}>{n.label}</Text>
                    <Text variant="bodyMedium" style={styles.cellValue}>
                      {fmt(summary.totals[n.key] / Math.max(1, summary.daysEstimated), n.digits)} {n.unit}
                    </Text>
                    <Text variant="bodyMedium" style={styles.cellValue}>
                      {fmt(summary.totals[n.key], n.digits)} {n.unit}
                    </Text>
                  </View>
                ))}
                <Text variant="bodySmall" style={styles.footnote}>
                  Per day = average over the {summary.daysEstimated} days with an estimate.
                  {summary.estimated < attendance.length
                    ? ` ${attendance.length - summary.estimated} meals had no dish or serving set and aren't counted.`
                    : ''}
                  {summary.incomplete > 0
                    ? ` ${summary.incomplete} meals used a food with missing values, so some totals are low.`
                    : ''}
                </Text>
              </Card.Content>
            </Card>
          )}

          {summary.estimated > 0 && (
            <>
              <Text variant="titleSmall" style={styles.sectionTitle}>Energy per day (kcal)</Text>
              <View style={styles.chart}>
                {chartDays.map((d) => {
                  const e = summary.energyByDay.get(d) ?? 0;
                  return (
                    <View key={d} style={styles.chartCol}>
                      <View style={styles.chartBarArea}>
                        <View
                          style={[styles.chartBar, { height: `${(e / maxEnergy) * 100}%` }, e === 0 && styles.chartBarEmpty]}
                        />
                      </View>
                      <Text variant="labelSmall" style={styles.chartLabel}>{Number(d.slice(8))}</Text>
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </>
      ) : (
        <Text variant="bodySmall" style={styles.meta}>
          You don't have permission to see students' nutrition; ask the headteacher.
        </Text>
      )}

      <Text variant="titleMedium" style={styles.sectionTitle}>History</Text>
      {attendance.length === 0 ? (
        <Text variant="bodyMedium" style={styles.empty}>No meals recorded in this period.</Text>
      ) : (
        attendance.map((a, index) => {
          const r = records.get(a.attendance_id);
          return (
            <View key={a.attendance_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={`${formatDay(a.attendance_date)} · ${MEAL_LABELS[a.meal_type]}`}
                description={
                  !seesNutrition
                    ? undefined
                    : r?.meal_name
                    ? `${r.meal_name} · ${fmt(Number(r.energy_kcal ?? 0), 0)} kcal · ${fmt(Number(r.protein_g ?? 0), 1)} g protein`
                    : r
                    ? 'No dish on the timetable'
                    : 'Recorded before nutrition tracking'
                }
                style={styles.row}
                right={() =>
                  seesNutrition && r?.meal_name && !r.complete ? (
                    <StatusPill label="incomplete" tone="warning" style={styles.pill} />
                  ) : null
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

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  meta: { color: c.textMuted, marginBottom: 12 },
  sectionTitle: { color: c.text, marginTop: 20, marginBottom: 8 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexGrow: 1, flexBasis: '45%' },
  card: { borderRadius: 16 },
  tableHead: { flexDirection: 'row', paddingBottom: 6 },
  tableRow: { flexDirection: 'row', paddingVertical: 4 },
  cellName: { flex: 1.3, color: c.text },
  cellValue: { flex: 1, color: c.textSecondary, textAlign: 'right' },
  footnote: { color: c.textMuted, marginTop: 10 },
  empty: { color: c.textMuted },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 4 },
  chartCol: { flex: 1, alignItems: 'center', height: '100%' },
  chartBarArea: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  chartBar: { width: '100%', backgroundColor: c.primary, borderRadius: 4, minHeight: 2 },
  chartBarEmpty: { backgroundColor: c.border },
  chartLabel: { color: c.textFaint, marginTop: 4 },
  row: { paddingRight: 0 },
  pill: { alignSelf: 'center' },
  bottomSpacer: { height: 40 },
});
