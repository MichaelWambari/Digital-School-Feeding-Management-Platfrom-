import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, RefreshControl, Pressable } from 'react-native';
import { Card, Divider, HelperText, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { SegmentedButtons } from '../components/Paper';
import { ScreenHeader, StatCard, StatusPill } from '../components/ScreenParts';
import { NEED_GOOD_AT, NEED_LOW_AT, NutrientDonut } from '../components/NutrientDonut';

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
  | 'magnesium_mg'
  | 'zinc_mg'
  | 'vitamin_a_ug'
  | 'thiamin_mg'
  | 'riboflavin_mg'
  | 'niacin_mg'
  | 'folate_ug'
  | 'vitamin_b12_ug'
  | 'vitamin_c_mg'
  | 'phytate_mg';
type Record_ = {
  attendance_id: string;
  meal_name: string | null;
  complete: boolean;
} & Partial<Record<NutrientKey, number | null>>;

type Nutrient = { key: NutrientKey; label: string; unit: string; digits: number; micro: boolean };
// Micronutrients first: they are what school meals most often fall short on.
// Folate is in dietary folate equivalents; vitamin A in retinol activity equivalents.
const NUTRIENTS: Nutrient[] = [
  { key: 'iron_mg', label: 'Iron', unit: 'mg', digits: 1, micro: true },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', digits: 1, micro: true },
  { key: 'vitamin_a_ug', label: 'Vitamin A', unit: 'µg RAE', digits: 0, micro: true },
  { key: 'folate_ug', label: 'Folate', unit: 'µg DFE', digits: 0, micro: true },
  { key: 'vitamin_b12_ug', label: 'Vitamin B12', unit: 'µg', digits: 2, micro: true },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', digits: 0, micro: true },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', digits: 0, micro: true },
  { key: 'thiamin_mg', label: 'Thiamin (B1)', unit: 'mg', digits: 2, micro: true },
  { key: 'riboflavin_mg', label: 'Riboflavin (B2)', unit: 'mg', digits: 2, micro: true },
  { key: 'niacin_mg', label: 'Niacin (B3)', unit: 'mg', digits: 1, micro: true },
  { key: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg', digits: 0, micro: true },
  { key: 'energy_kcal', label: 'Energy', unit: 'kcal', digits: 0, micro: false },
  { key: 'protein_g', label: 'Protein', unit: 'g', digits: 1, micro: false },
  { key: 'carbohydrate_g', label: 'Carbohydrates', unit: 'g', digits: 1, micro: false },
  { key: 'fat_g', label: 'Fat', unit: 'g', digits: 1, micro: false },
  { key: 'fibre_g', label: 'Fibre', unit: 'g', digits: 1, micro: false },
];

// One row of student_nutrient_adequacy (fix 018): the student's average
// per day of meals against their FAO/WHO daily need.
type Need = {
  nutrient: string;
  per_day: number | null;
  requirement: number | null;
  unit: string | null;
  percent: number | null;
  variant: string | null;
  days: number;
  phytate_zinc: number | null;
  missing: 'age' | 'sex' | 'age_range' | null;
};
// Below this share of the daily need a value is shown in red: roughly what
// one school meal a day should cover (WFP models school meals at 30-50%).
const LOW_PERCENT = 30;
// Vitamin A needs are in retinol equivalents, so that row uses the RE total.
const needKey = (key: NutrientKey) => (key === 'vitamin_a_ug' ? 'vitamin_a_re_ug' : key);
const MISSING_TEXT: Record<string, string> = {
  age: "Add the student's age to compare with their daily needs.",
  sex: "Add the student's sex: from age 10, boys' and girls' daily needs differ.",
  age_range: 'Daily needs are only set for ages 4 to 18.',
};

// Phytate:zinc molar ratio (phytate 660 g/mol, zinc 65.4 g/mol). Above 15
// means low zinc absorption, 5-15 moderate, below 5 good (WHO/FAO, 2004).
function phytateZinc(phytateMg: number, zincMg: number) {
  if (zincMg <= 0 || phytateMg <= 0) return null;
  const ratio = phytateMg / 660 / (zincMg / 65.4);
  return { ratio, level: ratio > 15 ? 'low' : ratio >= 5 ? 'moderate' : 'good' };
}

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
  const [needs, setNeeds] = useState<Map<string, Need>>(new Map());
  const [selectedEnergyDate, setSelectedEnergyDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const days = RANGES.find((r) => r.key === range)!.days;
  const start = localDate(days - 1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [attendanceResult, nutritionResult, needsResult] = await Promise.all([
      supabase
        .from('meal_attendance')
        .select('attendance_id, attendance_date, meal_type')
        .eq('beneficiary_id', beneficiaryId)
        .gte('attendance_date', start)
        .order('attendance_date', { ascending: false }),
      seesNutrition
        ? supabase
            .from('attendance_nutrition')
            // '*' so the report still loads before fix 017 adds the micronutrient columns.
            .select('*')
            .eq('beneficiary_id', beneficiaryId)
            .gte('attendance_date', start)
        : Promise.resolve({ data: [], error: null }),
      // % of daily needs met (fix 018); the report works without it.
      seesNutrition
        ? supabase.rpc('student_nutrient_adequacy', {
            p_beneficiary_id: beneficiaryId,
            p_from: start,
            p_to: localDate(0),
          })
        : Promise.resolve({ data: [], error: null }),
    ]);
    const needRows = needsResult.error ? [] : ((needsResult.data ?? []) as Need[]);
    setNeeds(new Map(needRows.map((r) => [r.nutrient, r])));
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
    // Meals recorded before fix 017 have no folate, B12 etc.
    let older = 0;
    let phytate = 0;
    for (const a of attendance) {
      byMeal[a.meal_type] = (byMeal[a.meal_type] ?? 0) + 1;
      const r = records.get(a.attendance_id);
      if (r && r.meal_name) {
        estimated += 1;
        if (!r.complete) incomplete += 1;
        if (r.folate_ug == null) older += 1;
        for (const n of NUTRIENTS) totals[n.key] += Number(r[n.key] ?? 0);
        phytate += Number(r.phytate_mg ?? 0);
        energyByDay.set(a.attendance_date, (energyByDay.get(a.attendance_date) ?? 0) + Number(r.energy_kcal ?? 0));
      }
    }
    const daysFed = new Set(attendance.map((a) => a.attendance_date)).size;
    const daysEstimated = energyByDay.size;
    const absorption = phytateZinc(phytate, totals.zinc_mg);
    return { byMeal, totals, energyByDay, estimated, incomplete, older, absorption, daysFed, daysEstimated };
  }, [attendance, records]);

  // % of daily needs: only from meals recorded since fix 018.
  const needList = [...needs.values()];
  const hasNeeds = needList.some((r) => r.days > 0);
  const needMissing = needList.find((r) => r.days > 0 && r.missing)?.missing ?? null;
  const ironBasis = needs.get('iron_mg')?.variant === 'iron_5' ? '5%' : '10%';
  const zincBasis = needs.get('zinc_mg')?.variant?.replace('zinc_', '') ?? 'moderate';

  // Energy accumulated over the days eaten, oldest first: each day's energy
  // and the running total up to and including it.
  const energyDays = useMemo(() => {
    let total = 0;
    return [...summary.energyByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => {
        total += day;
        return { date, day, total };
      });
  }, [summary.energyByDay]);
  const shownEnergyDays = energyDays.slice(-14);
  const energyTotal = energyDays.length ? energyDays[energyDays.length - 1].total : 0;
  const maxCumulative = Math.max(1, energyTotal);
  const selectedDay = energyDays.find((d) => d.date === selectedEnergyDate) ?? null;

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
            <>
            <Text variant="titleSmall" style={styles.sectionTitle}>
              Micronutrients: daily needs met
              {hasNeeds ? ` · ${needs.get('iron_mg')?.days ?? 0} days eaten` : ''}
            </Text>
            {hasNeeds && !needMissing ? (
              <>
                <View style={styles.donuts}>
                  {NUTRIENTS.filter((n) => n.micro).map((n) => {
                    const need = needs.get(needKey(n.key));
                    const percent = need?.percent != null ? Number(need.percent) : null;
                    return (
                      <NutrientDonut
                        key={n.key}
                        style={styles.donut}
                        label={n.label.replace(/ \(B\d\)$/, '')}
                        percent={percent}
                        detail={
                          need?.per_day != null && need.requirement != null
                            ? `${fmt(Number(need.per_day), n.digits)} of ${fmt(Number(need.requirement), 1)} ${n.key === 'vitamin_a_ug' ? 'µg RE' : n.unit}`
                            : undefined
                        }
                      />
                    );
                  })}
                </View>
                <Text variant="bodySmall" style={styles.meta}>
                  Each ring is the average per day eaten as a share of {name.split(' ')[0]}'s daily need
                  (FAO/WHO), full at 100%: green {NEED_GOOD_AT}% or more, yellow {NEED_LOW_AT}–{NEED_GOOD_AT - 1}%,
                  red under {NEED_LOW_AT}%.
                </Text>
              </>
            ) : (
              <Text variant="bodyMedium" style={styles.empty}>
                {needMissing
                  ? MISSING_TEXT[needMissing]
                  : 'Shown for meals recorded since daily needs were added, once the dish on the Timetable has a serving.'}
              </Text>
            )}
            <Text variant="titleSmall" style={styles.sectionTitle}>Details</Text>
            <Card mode="contained" style={styles.card}>
              <Card.Content>
                {[true, false].map((micro) => (
                  <View key={String(micro)}>
                    <View style={[styles.tableHead, !micro && styles.tableGap]}>
                      <Text variant="labelMedium" style={styles.cellName}>
                        {micro ? 'Micronutrients' : 'Energy and macronutrients'}
                      </Text>
                      <Text variant="labelMedium" style={styles.cellValue}>Per day</Text>
                      <Text variant="labelMedium" style={styles.cellValue}>
                        {micro && hasNeeds ? '% of daily need' : 'Total'}
                      </Text>
                    </View>
                    {NUTRIENTS.filter((n) => n.micro === micro).map((n) => {
                      const need = micro && hasNeeds ? needs.get(needKey(n.key)) : undefined;
                      return (
                        <View key={n.key} style={styles.tableRow}>
                          <Text variant="bodyMedium" style={styles.cellName}>{n.label}</Text>
                          <Text variant="bodyMedium" style={styles.cellValue}>
                            {fmt(summary.totals[n.key] / Math.max(1, summary.daysEstimated), n.digits)} {n.unit}
                          </Text>
                          {micro && hasNeeds ? (
                            <Text
                              variant="bodyMedium"
                              style={[
                                styles.cellValue,
                                need?.percent != null && need.percent < LOW_PERCENT && styles.low,
                              ]}
                            >
                              {need?.percent != null
                                ? `${fmt(Number(need.percent), 0)}% of ${fmt(Number(need.requirement), 1)}`
                                : '—'}
                            </Text>
                          ) : (
                            <Text variant="bodyMedium" style={styles.cellValue}>
                              {fmt(summary.totals[n.key], n.digits)} {n.unit}
                            </Text>
                          )}
                        </View>
                      );
                    })}
                    {micro && needMissing && (
                      <Text variant="bodySmall" style={styles.lowNote}>{MISSING_TEXT[needMissing]}</Text>
                    )}
                  </View>
                ))}
                {summary.absorption && (
                  <View style={styles.absorption}>
                    <Text variant="bodyMedium" style={styles.cellName}>Zinc absorption</Text>
                    <StatusPill
                      label={`${summary.absorption.level} · phytate:zinc ${fmt(summary.absorption.ratio, 0)}`}
                      tone={summary.absorption.level === 'low' ? 'warning' : summary.absorption.level === 'moderate' ? 'info' : 'success'}
                    />
                  </View>
                )}
                <Text variant="bodySmall" style={styles.footnote}>
                  Per day = average over the {summary.daysEstimated} days with an estimate. Values are
                  from the Kenya Food Composition Tables 2018.
                  {hasNeeds
                    ? ` % of daily need compares the average per day of school meals with the FAO/WHO (2004) ` +
                      `recommended intake for the student's age and sex (vitamin A in retinol equivalents). ` +
                      `Iron is judged at ${ironBasis} absorption and zinc at ${zincBasis} absorption, from the ` +
                      `phytate in these meals. Red is below ${LOW_PERCENT}%. It counts meals recorded since ` +
                      `needs were added.`
                    : ''}
                  {summary.absorption
                    ? ' Phytate in whole maize and beans binds zinc and iron: above 15, much of the zinc ' +
                      "isn't absorbed (WHO/FAO). Foods with no phytate value count as none."
                    : ''}
                  {summary.estimated < attendance.length
                    ? ` ${attendance.length - summary.estimated} meals had no dish or serving set and aren't counted.`
                    : ''}
                  {summary.incomplete > 0
                    ? ` ${summary.incomplete} meals used a food with missing values, so some totals are low.`
                    : ''}
                  {summary.older > 0
                    ? ` ${summary.older} meals were recorded before folate, B12 and the B vitamins were tracked, so those totals are low.`
                    : ''}
                </Text>
              </Card.Content>
            </Card>
            </>
          )}

          {energyDays.length > 0 && (
            <>
              <Text variant="titleSmall" style={styles.sectionTitle}>Energy accumulated (kcal)</Text>
              <Text variant="bodySmall" style={styles.meta}>
                {selectedDay
                  ? `${formatDay(selectedDay.date)}: ${fmt(selectedDay.day, 0)} kcal that day · ` +
                    `${fmt(selectedDay.total, 0)} kcal in total so far`
                  : `${fmt(energyTotal, 0)} kcal over ${energyDays.length} days eaten. Tap a bar for that day.`}
              </Text>
              <View style={styles.chart}>
                {shownEnergyDays.map((d) => {
                  const selected = selectedDay?.date === d.date;
                  return (
                    <Pressable
                      key={d.date}
                      style={styles.chartCol}
                      onPress={() => setSelectedEnergyDate(selected ? null : d.date)}
                      accessibilityRole="button"
                      accessibilityLabel={`${formatDay(d.date)}: ${Math.round(d.day)} kcal, ${Math.round(d.total)} kcal in total`}
                      hitSlop={4}
                    >
                      <View style={styles.chartBarArea}>
                        {/* that day's energy on top of what had built up before */}
                        <View
                          style={[
                            styles.chartBar,
                            styles.chartBarToday,
                            { height: `${(d.day / maxCumulative) * 100}%` },
                            selected && styles.chartBarSelected,
                          ]}
                        />
                        {d.total - d.day > 0 && (
                          <View
                            style={[
                              styles.chartBar,
                              styles.chartBarBefore,
                              { height: `${((d.total - d.day) / maxCumulative) * 100}%` },
                            ]}
                          />
                        )}
                      </View>
                      <Text variant="labelSmall" style={[styles.chartLabel, selected && styles.chartLabelSelected]}>
                        {Number(d.date.slice(8))}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.legend}>
                <View style={[styles.legendSwatch, styles.chartBarToday]} />
                <Text variant="labelSmall" style={styles.legendText}>That day</Text>
                <View style={[styles.legendSwatch, styles.chartBarBefore]} />
                <Text variant="labelSmall" style={styles.legendText}>Earlier days</Text>
              </View>
              {energyDays.length > shownEnergyDays.length && (
                <Text variant="bodySmall" style={styles.meta}>
                  Showing the last {shownEnergyDays.length} days eaten; totals count from the start of the period.
                </Text>
              )}
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
  tableGap: { marginTop: 14 },
  low: { color: c.danger, fontWeight: '600' },
  lowNote: { color: c.warning, marginTop: 4 },
  absorption: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  cellName: { flex: 1.3, color: c.text },
  cellValue: { flex: 1, color: c.textSecondary, textAlign: 'right' },
  footnote: { color: c.textMuted, marginTop: 10 },
  empty: { color: c.textMuted },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 4 },
  chartCol: { flex: 1, alignItems: 'center', height: '100%' },
  chartBarArea: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  chartBar: { width: '100%', borderRadius: 4, minHeight: 2 },
  // 2px gap between the day's segment and the earlier total below it.
  chartBarToday: { backgroundColor: c.primary, marginBottom: 2 },
  chartBarBefore: { backgroundColor: c.primary, opacity: 0.35 },
  chartBarSelected: { opacity: 0.75 },
  chartLabelSelected: { color: c.text, fontWeight: '700' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2, marginBottom: 0 },
  legendText: { color: c.textSecondary, marginRight: 10 },
  donuts: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 16, marginBottom: 8 },
  donut: { width: '31%' },
  chartLabel: { color: c.textFaint, marginTop: 4 },
  row: { paddingRight: 0 },
  pill: { alignSelf: 'center' },
  bottomSpacer: { height: 40 },
});
