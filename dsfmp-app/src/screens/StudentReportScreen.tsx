import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, RefreshControl } from 'react-native';
import { Card, Divider, HelperText, IconButton, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { SegmentedButtons } from '../components/Paper';
import { ScreenHeader, StatCard, StatusPill } from '../components/ScreenParts';
import {
  NEED_GOOD_AT,
  NEED_LOW_AT,
  NEED_STATUS,
  NutrientDonut,
  formatPercent,
  needStatus,
} from '../components/NutrientDonut';
import { EnergyLineChart } from '../components/EnergyLineChart';

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
  cooked?: boolean; // fix 020: values are after cooking losses
  vitamin_a_re_ug?: number | null; // fix 018: vitamin A in retinol equivalents
  amino_protein_g?: number | null; // fix 023: protein from foods with amino acid data
} & Partial<Record<NutrientKey | AminoKey, number | null>>;

// Essential amino acids (fix 023, KFCT 2018 Table 3a), and the FAO
// reference pattern in mg per g protein: FAO (2013) Dietary protein
// quality evaluation in human nutrition, FNP 92, Table 5, "older child,
// adolescent, adult" (from age 3). Methionine and cysteine count
// together, as do phenylalanine and tyrosine.
type AminoKey =
  | 'his_mg' | 'ile_mg' | 'leu_mg' | 'lys_mg' | 'met_mg' | 'cys_mg'
  | 'phe_mg' | 'tyr_mg' | 'thr_mg' | 'trp_mg' | 'val_mg';
const AMINO_ACIDS: { label: string; keys: AminoKey[]; pattern: number }[] = [
  { label: 'Histidine', keys: ['his_mg'], pattern: 16 },
  { label: 'Isoleucine', keys: ['ile_mg'], pattern: 30 },
  { label: 'Leucine', keys: ['leu_mg'], pattern: 61 },
  { label: 'Lysine', keys: ['lys_mg'], pattern: 48 },
  { label: 'Methionine + cysteine', keys: ['met_mg', 'cys_mg'], pattern: 23 },
  { label: 'Phenylalanine + tyrosine', keys: ['phe_mg', 'tyr_mg'], pattern: 41 },
  { label: 'Threonine', keys: ['thr_mg'], pattern: 25 },
  { label: 'Tryptophan', keys: ['trp_mg'], pattern: 6.6 },
  { label: 'Valine', keys: ['val_mg'], pattern: 40 },
];
// FAO's example cut-offs for protein quality claims: 100+ excellent,
// 75-99 good, below 75 no claim.
const QUALITY_GOOD_AT = 100;
const QUALITY_LOW_AT = 75;
const QUALITY = 'protein_quality';

// Amino acid score of a set of meals: each essential amino acid per g of
// the protein that has amino acid data, as a % of the FAO pattern. The
// lowest is the score; that amino acid is the limiting one.
function proteinQuality(meals: Record_[]) {
  const withData = meals.filter((r) => r.lys_mg != null && Number(r.amino_protein_g ?? 0) > 0);
  const protein = withData.reduce((s, r) => s + Number(r.amino_protein_g), 0);
  if (protein <= 0) return null;
  const allProtein = withData.reduce((s, r) => s + Number(r.protein_g ?? 0), 0);
  const acids = AMINO_ACIDS.map((a) => {
    const mg = withData.reduce((s, r) => s + a.keys.reduce((t, k) => t + Number(r[k] ?? 0), 0), 0);
    const perGram = mg / protein;
    return { ...a, perGram, percent: (100 * perGram) / a.pattern };
  });
  const limiting = acids.reduce((lo, a) => (a.percent < lo.percent ? a : lo));
  return {
    score: limiting.percent,
    limiting,
    acids,
    meals: withData.length,
    // Share of the protein covered by foods with amino acid data.
    coverage: allProtein > 0 ? (100 * protein) / allProtein : 100,
  };
}

type Group = 'micro' | 'macro';
type Nutrient = { key: NutrientKey; label: string; unit: string; digits: number; group: Group };
// Micronutrients first: they are what school meals most often fall short on.
// Folate is in dietary folate equivalents; vitamin A in retinol activity equivalents.
// Energy isn't a ring: it has its own line chart.
const NUTRIENTS: Nutrient[] = [
  { key: 'iron_mg', label: 'Iron', unit: 'mg', digits: 1, group: 'micro' },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', digits: 1, group: 'micro' },
  { key: 'vitamin_a_ug', label: 'Vitamin A', unit: 'µg RAE', digits: 0, group: 'micro' },
  { key: 'folate_ug', label: 'Folate', unit: 'µg DFE', digits: 0, group: 'micro' },
  { key: 'vitamin_b12_ug', label: 'Vitamin B12', unit: 'µg', digits: 2, group: 'micro' },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', digits: 0, group: 'micro' },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', digits: 0, group: 'micro' },
  { key: 'thiamin_mg', label: 'Thiamin (B1)', unit: 'mg', digits: 2, group: 'micro' },
  { key: 'riboflavin_mg', label: 'Riboflavin (B2)', unit: 'mg', digits: 2, group: 'micro' },
  { key: 'niacin_mg', label: 'Niacin (B3)', unit: 'mg', digits: 1, group: 'micro' },
  { key: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg', digits: 0, group: 'micro' },
  { key: 'protein_g', label: 'Protein', unit: 'g', digits: 1, group: 'macro' },
  { key: 'carbohydrate_g', label: 'Carbohydrates', unit: 'g', digits: 1, group: 'macro' },
  { key: 'fat_g', label: 'Fat', unit: 'g', digits: 1, group: 'macro' },
  { key: 'fibre_g', label: 'Fibre', unit: 'g', digits: 1, group: 'macro' },
];
const TOTAL_KEYS: NutrientKey[] = [...NUTRIENTS.map((n) => n.key), 'energy_kcal'];
const GROUPS = [
  { value: 'micro', label: 'Micronutrients' },
  { value: 'macro', label: 'Macronutrients' },
];
// Rings per row: 11 micronutrients in threes, 4 macronutrients in twos.
const COLUMNS: Record<Group, number> = { micro: 3, macro: 2 };

// One row of student_nutrient_adequacy (fix 018; energy and macronutrients
// from fix 021): the student's average per day of meals against their daily need.
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
// Vitamin A needs are in retinol equivalents, so that row uses the RE total.
const needKey = (key: NutrientKey) => (key === 'vitamin_a_ug' ? 'vitamin_a_re_ug' : key);
const MISSING_TEXT: Record<string, string> = {
  age: "Add the student's age to compare with their daily needs.",
  sex: "Add the student's sex: from age 10, boys' and girls' daily needs differ.",
  age_range: 'Daily needs are only set for ages 4 to 18.',
};

// The unit a need is compared in. Taken from here rather than the database,
// where the µ can come back garbled if the fix was pasted with another encoding.
const unitForNeed = (n: Nutrient) =>
  n.key === 'vitamin_a_ug' ? 'µg RE' : n.key === 'niacin_mg' ? 'mg NE' : n.unit;

// What to know about one nutrient, shown in its details.
const NUTRIENT_NOTES: Partial<Record<NutrientKey, string>> = {
  vitamin_a_ug: 'Compared in retinol equivalents (RE), the unit FAO/WHO set the need in.',
  folate_ug: 'In dietary folate equivalents (DFE).',
  niacin_mg:
    'Food tables give preformed niacin only; the body also makes niacin from protein, so the real share is higher.',
  fat_g: 'The need is 30% of the daily energy need (FAO: 25–35% for ages 4 to 18).',
  fibre_g: 'Need: Institute of Medicine (2005) adequate intake.',
  protein_g: 'Need: Institute of Medicine (2005) recommended intake.',
  carbohydrate_g: 'Need: Institute of Medicine (2005) recommended intake, the same from age 4 to 18.',
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
  const firstName = name.split(' ')[0];
  const seesNutrition = can('view_nutrition');
  const [range, setRange] = useState('30');
  const [group, setGroup] = useState<Group>('micro');
  const [selectedNutrient, setSelectedNutrient] = useState<NutrientKey | typeof QUALITY | null>(null);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [records, setRecords] = useState<Map<string, Record_>>(new Map());
  const [needs, setNeeds] = useState<Map<string, Need>>(new Map());
  const [selectedEnergyDate, setSelectedEnergyDate] = useState<string | null>(null);
  // The History meal opened to show all its nutrients.
  const [openMeal, setOpenMeal] = useState<string | null>(null);
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
    const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])) as Record<NutrientKey, number>;
    const energyByDay = new Map<string, number>();
    let estimated = 0;
    let incomplete = 0;
    // Meals recorded before fix 017 have no folate, B12 etc.
    let older = 0;
    let phytate = 0;
    // Meals worked out from raw food values (before fix 020, or older records).
    let raw = 0;
    for (const a of attendance) {
      byMeal[a.meal_type] = (byMeal[a.meal_type] ?? 0) + 1;
      const r = records.get(a.attendance_id);
      if (r && r.meal_name) {
        estimated += 1;
        if (!r.complete) incomplete += 1;
        if (r.folate_ug == null) older += 1;
        if (!r.cooked) raw += 1;
        for (const k of TOTAL_KEYS) totals[k] += Number(r[k] ?? 0);
        phytate += Number(r.phytate_mg ?? 0);
        energyByDay.set(a.attendance_date, (energyByDay.get(a.attendance_date) ?? 0) + Number(r.energy_kcal ?? 0));
      }
    }
    const daysFed = new Set(attendance.map((a) => a.attendance_date)).size;
    const daysEstimated = energyByDay.size;
    const absorption = phytateZinc(phytate, totals.zinc_mg);
    return { byMeal, totals, energyByDay, estimated, incomplete, older, raw, absorption, daysFed, daysEstimated };
  }, [attendance, records]);

  // % of daily needs: only from meals recorded since fix 018.
  const needList = [...needs.values()];
  const hasNeeds = needList.some((r) => r.days > 0);
  const needMissing = needList.find((r) => r.days > 0 && r.missing)?.missing ?? null;
  const showNeeds = hasNeeds && !needMissing;
  const ironBasis = needs.get('iron_mg')?.variant === 'iron_5' ? '5%' : '10%';
  const zincBasis = needs.get('zinc_mg')?.variant?.replace('zinc_', '') ?? 'moderate';
  // Energy and macronutrient needs come with fix 021.
  const hasMacroNeeds = needs.get('energy_kcal')?.requirement != null;

  const percentOf = (key: NutrientKey) => {
    const p = showNeeds ? needs.get(needKey(key))?.percent : null;
    return p != null ? Number(p) : null;
  };

  // Energy provided on each day eaten, oldest first.
  const energyDays = useMemo(
    () =>
      [...summary.energyByDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, kcal]) => ({ date, kcal })),
    [summary.energyByDay]
  );
  const energyTotal = energyDays.reduce((sum, d) => sum + d.kcal, 0);
  const energyNeed = showNeeds && hasMacroNeeds ? Number(needs.get('energy_kcal')!.requirement) : null;
  const selectedDay = energyDays.find((d) => d.date === selectedEnergyDate) ?? null;

  const shown = NUTRIENTS.filter((n) => n.group === group);
  const columns = COLUMNS[group];
  // The macronutrients add a protein quality ring.
  const ringCount = shown.length + (group === 'macro' ? 1 : 0);
  const spacers = (columns - (ringCount % columns)) % columns;
  // Protein quality of the meals in the period with amino acid data (fix 023).
  const quality = useMemo(
    () => proteinQuality(attendance.map((a) => records.get(a.attendance_id)).filter((r): r is Record_ => !!r?.meal_name)),
    [attendance, records]
  );
  const selected = shown.find((n) => n.key === selectedNutrient) ?? null;

  const changeGroup = (value: string) => {
    setGroup(value as Group);
    setSelectedNutrient(null);
  };

  // The details card for the ring that was tapped.
  const renderDetails = (n: Nutrient) => {
    const need = needs.get(needKey(n.key));
    const percent = percentOf(n.key);
    const status = percent != null ? NEED_STATUS[needStatus(percent)] : null;
    const needUnit = unitForNeed(n);
    // The need compares only meals recorded since needs were added, so its
    // average can cover fewer days than the total below.
    const fromNeed = need?.per_day != null && showNeeds;
    const perDay = fromNeed ? Number(need!.per_day) : summary.totals[n.key] / Math.max(1, summary.daysEstimated);
    const perDayDays = fromNeed ? need!.days : summary.daysEstimated;
    const rows: [string, string][] = [
      [
        `Per day (average of ${perDayDays} ${perDayDays === 1 ? 'day' : 'days'})`,
        `${fmt(perDay, n.digits)} ${fromNeed ? unitForNeed(n) : n.unit}`,
      ],
    ];
    if (showNeeds && need?.requirement != null) {
      rows.push([`${firstName}'s daily need`, `${fmt(Number(need.requirement), 1)} ${needUnit}`]);
    }
    if (percent != null) {
      rows.push([
        'Share of the need',
        percent > 100 ? `${formatPercent(percent)} · ${fmt(percent / 100, 1)}× the need` : formatPercent(percent),
      ]);
    }
    rows.push([`Total over ${summary.daysEstimated} days`, `${fmt(summary.totals[n.key], n.digits)} ${n.unit}`]);

    const notes: string[] = [];
    if (n.key === 'iron_mg' && showNeeds) {
      notes.push(`The need assumes ${ironBasis} of the iron is absorbed, from the phytate in these meals.`);
    }
    if (n.key === 'zinc_mg' && showNeeds) {
      notes.push(`The need assumes ${zincBasis} zinc absorption, from the phytate in these meals.`);
    }
    if (NUTRIENT_NOTES[n.key]) notes.push(NUTRIENT_NOTES[n.key]!);
    if (percent != null && percent > 100) {
      notes.push(
        'Over 100% means the meals give more than the daily need on average, so the ring is full. ' +
          "That's fine: it's food provided, not a supplement."
      );
    } else if (percent != null && percent < NEED_LOW_AT) {
      notes.push(
        `Under ${NEED_LOW_AT}% is less than one school meal's usual share (WFP plans school meals to cover 30–50% of a day's needs).`
      );
    }

    return (
      <Card mode="contained" style={styles.card}>
        <Card.Content>
          <View style={styles.detailHead}>
            <Text variant="titleMedium" style={styles.detailTitle}>{n.label}</Text>
            {status ? (
              <StatusPill
                label={percent! >= 100 ? 'Need met' : status.label}
                tone={status === NEED_STATUS.good ? 'success' : status === NEED_STATUS.moderate ? 'warning' : 'danger'}
              />
            ) : null}
            <IconButton
              icon="close"
              size={18}
              onPress={() => setSelectedNutrient(null)}
              accessibilityLabel="Close details"
              style={styles.close}
            />
          </View>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.tableRow}>
              <Text variant="bodyMedium" style={styles.cellName}>{label}</Text>
              <Text variant="bodyMedium" style={styles.cellValue}>{value}</Text>
            </View>
          ))}
          {n.key === 'zinc_mg' && summary.absorption && (
            <View style={styles.absorption}>
              <Text variant="bodyMedium" style={styles.cellName}>Zinc absorption</Text>
              <StatusPill
                label={`${summary.absorption.level} · phytate:zinc ${fmt(summary.absorption.ratio, 0)}`}
                tone={summary.absorption.level === 'low' ? 'warning' : summary.absorption.level === 'moderate' ? 'info' : 'success'}
              />
            </View>
          )}
          {notes.map((note) => (
            <Text key={note} variant="bodySmall" style={styles.detailNote}>{note}</Text>
          ))}
          {n.key === 'zinc_mg' && summary.absorption && (
            <Text variant="bodySmall" style={styles.detailNote}>
              Phytate in whole maize and beans binds zinc and iron: above 15, much of the zinc isn't
              absorbed (WHO/FAO). Foods with no phytate value count as none.
            </Text>
          )}
        </Card.Content>
      </Card>
    );
  };

  // The protein quality ring's details: each essential amino acid
  // against the FAO pattern, the lowest first.
  const renderQualityDetails = () => {
    const status = quality ? NEED_STATUS[needStatus(quality.score, QUALITY_GOOD_AT, QUALITY_LOW_AT)] : null;
    return (
      <Card mode="contained" style={styles.card}>
        <Card.Content>
          <View style={styles.detailHead}>
            <Text variant="titleMedium" style={styles.detailTitle}>Protein quality</Text>
            {quality && status ? (
              <StatusPill
                label={quality.score >= 100 ? 'Complete' : status.label}
                tone={status === NEED_STATUS.good ? 'success' : status === NEED_STATUS.moderate ? 'warning' : 'danger'}
              />
            ) : null}
            <IconButton
              icon="close"
              size={18}
              onPress={() => setSelectedNutrient(null)}
              accessibilityLabel="Close details"
              style={styles.close}
            />
          </View>
          {quality ? (
            <>
              <Text variant="bodyMedium" style={styles.detailLead}>
                Amino acid score {formatPercent(quality.score)}:{' '}
                {quality.score >= 100
                  ? 'the protein has every essential amino acid in the amounts a growing child needs.'
                  : `${quality.limiting.label.toLowerCase()} runs out first, so only about ${formatPercent(
                      quality.score
                    )} of the protein can be used to build the body.`}
              </Text>
              <View style={[styles.tableRow, styles.tableHead]}>
                <Text variant="labelMedium" style={styles.cellName}>Essential amino acid</Text>
                <Text variant="labelMedium" style={styles.cellValue}>mg per g protein</Text>
                <Text variant="labelMedium" style={styles.cellValue}>of FAO pattern</Text>
              </View>
              {[...quality.acids]
                .sort((a, b) => a.percent - b.percent)
                .map((a) => {
                  const limiting = a.label === quality.limiting.label;
                  return (
                    <View key={a.label} style={styles.tableRow}>
                      <Text variant="bodyMedium" style={[styles.cellName, limiting && styles.limiting]}>
                        {a.label}
                        {limiting ? (quality.score >= 100 ? ' (lowest)' : ' (limiting)') : ''}
                      </Text>
                      <Text variant="bodyMedium" style={styles.cellValue}>
                        {fmt(a.perGram, 1)} of {fmt(a.pattern, 1)}
                      </Text>
                      <Text variant="bodyMedium" style={[styles.cellValue, a.percent < QUALITY_LOW_AT && styles.low]}>
                        {formatPercent(a.percent)}
                      </Text>
                    </View>
                  );
                })}
              <Text variant="bodySmall" style={styles.detailNote}>
                Score = the lowest essential amino acid per gram of protein, as a share of the FAO
                (2013) reference pattern for children over 3 and adolescents. Green is
                {` ${QUALITY_GOOD_AT}% or more, yellow ${QUALITY_LOW_AT}–${QUALITY_GOOD_AT - 1}%, red under ${QUALITY_LOW_AT}%`} (FAO's
                example cut-offs). Maize protein is short of lysine; beans, milk, eggs, meat and omena
                make up for it.
              </Text>
              <Text variant="bodySmall" style={styles.detailNote}>
                From {quality.meals} meals in this period. Amino acids are from the Kenya Food
                Composition Tables 2018 (Table 3a); maize's methionine, cysteine and tryptophan are
                filled from KFCT green maize because KFCT lists them as trace. Not corrected for
                digestibility, so plant protein scores a little high.
                {quality.coverage < 99
                  ? ` ${fmt(100 - quality.coverage, 0)}% of the protein is from foods with no amino acid data and isn't counted.`
                  : ''}
              </Text>
            </>
          ) : (
            <Text variant="bodyMedium" style={styles.detailLead}>
              No meals in this period have amino acid data yet. They appear for meals recorded once
              supabase/fixes/023_amino_acids.sql has been run.
            </Text>
          )}
        </Card.Content>
      </Card>
    );
  };

  // Everything one meal provided, with each value's share of the
  // student's daily need where that need is known.
  const renderMealNutrients = (r: Record_) => {
    const energyNeed = showNeeds ? needs.get('energy_kcal')?.requirement : null;
    const cell = (key: NutrientKey | 'energy_kcal', label: string, unit: string, digits: number) => {
      // Vitamin A is compared in retinol equivalents, like its ring.
      const useRe = key === 'vitamin_a_ug' && r.vitamin_a_re_ug != null && showNeeds;
      const raw = useRe ? r.vitamin_a_re_ug : r[key];
      const value = raw == null ? null : Number(raw);
      const need = key === 'energy_kcal' ? energyNeed : showNeeds ? needs.get(needKey(key))?.requirement : null;
      const percent = value != null && need ? (100 * value) / Number(need) : null;
      return (
        <View key={key} style={styles.mealCell}>
          <Text variant="labelSmall" style={styles.mealLabel} numberOfLines={1}>{label}</Text>
          <Text variant="bodyMedium" style={styles.mealValue}>
            {value == null ? '—' : `${fmt(value, digits)} ${useRe ? 'µg RE' : unit}`}
          </Text>
          {percent != null ? (
            <Text variant="labelSmall" style={styles.mealPercent}>{formatPercent(percent)} of day's need</Text>
          ) : null}
        </View>
      );
    };
    return (
      <View style={styles.mealPanel}>
        <Text variant="labelMedium" style={styles.mealGroup}>Energy and macronutrients</Text>
        <View style={styles.mealGrid}>
          {cell('energy_kcal', 'Energy', 'kcal', 0)}
          {NUTRIENTS.filter((n) => n.group === 'macro').map((n) => cell(n.key, n.label, n.unit, n.digits))}
          {(() => {
            const pq = proteinQuality([r]);
            return (
              <View style={styles.mealCell}>
                <Text variant="labelSmall" style={styles.mealLabel} numberOfLines={1}>Protein quality</Text>
                <Text variant="bodyMedium" style={styles.mealValue}>{pq ? formatPercent(pq.score) : '—'}</Text>
                {pq ? (
                  <Text variant="labelSmall" style={styles.mealPercent} numberOfLines={1}>
                    {pq.score >= 100 ? 'complete' : `limited by ${pq.limiting.label.toLowerCase()}`}
                  </Text>
                ) : null}
              </View>
            );
          })()}
        </View>
        <Text variant="labelMedium" style={[styles.mealGroup, styles.mealGroupGap]}>Micronutrients</Text>
        <View style={styles.mealGrid}>
          {NUTRIENTS.filter((n) => n.group === 'micro').map((n) =>
            cell(n.key, n.label.replace(/ \(B\d\)$/, ''), n.unit, n.digits)
          )}
        </View>
        {r.folate_ug == null ? (
          <Text variant="bodySmall" style={styles.detailNote}>
            Recorded before folate, B12 and the B vitamins were tracked, so those show as —.
          </Text>
        ) : null}
        {!r.complete ? (
          <Text variant="bodySmall" style={styles.detailNote}>
            A food in this dish has missing values, so some amounts are low.
          </Text>
        ) : null}
        <Text variant="bodySmall" style={styles.detailNote}>
          {r.cooked ? 'After cooking losses. ' : 'From raw food values. '}
          One meal is usually 30–50% of a day's needs.
        </Text>
      </View>
    );
  };

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
            provided, not what {firstName} actually ate.
          </Text>
          {summary.estimated === 0 ? (
            <Text variant="bodyMedium" style={styles.empty}>
              No estimates yet for this period. They appear for meals recorded once the dish on the
              Timetable has a serving.
            </Text>
          ) : (
            <>
              <SegmentedButtons value={group} onValueChange={changeGroup} buttons={GROUPS} />
              <Text variant="titleSmall" style={styles.sectionTitle}>
                Daily needs met
                {hasNeeds ? ` · ${needs.get('iron_mg')?.days ?? 0} days eaten` : ''}
              </Text>
              {needMissing ? (
                <Text variant="bodySmall" style={styles.lowNote}>{MISSING_TEXT[needMissing]}</Text>
              ) : !hasNeeds ? (
                <Text variant="bodySmall" style={styles.meta}>
                  Shown for meals recorded since daily needs were added, once the dish on the Timetable
                  has a serving.
                </Text>
              ) : group === 'macro' && !hasMacroNeeds ? (
                <Text variant="bodySmall" style={styles.meta}>
                  Run supabase/fixes/021_macronutrient_needs.sql to compare these with daily needs.
                </Text>
              ) : null}
              <View style={styles.donuts}>
                {shown.map((n) => {
                  const need = needs.get(needKey(n.key));
                  return (
                    <NutrientDonut
                      key={n.key}
                      style={group === 'micro' ? styles.donutThird : styles.donutHalf}
                      label={n.label.replace(/ \(B\d\)$/, '')}
                      percent={percentOf(n.key)}
                      selected={selectedNutrient === n.key}
                      onPress={() => setSelectedNutrient(selectedNutrient === n.key ? null : n.key)}
                      detail={
                        showNeeds && need?.per_day != null && need.requirement != null
                          ? `${fmt(Number(need.per_day), n.digits)} of ${fmt(Number(need.requirement), 1)} ${unitForNeed(n)}`
                          : `${fmt(summary.totals[n.key] / Math.max(1, summary.daysEstimated), n.digits)} ${n.unit} a day`
                      }
                    />
                  );
                })}
                {group === 'macro' && (
                  <NutrientDonut
                    style={styles.donutHalf}
                    label="Protein quality"
                    percent={quality ? quality.score : null}
                    goodAt={QUALITY_GOOD_AT}
                    lowAt={QUALITY_LOW_AT}
                    fullLabel="Complete"
                    percentOf="of the FAO amino acid pattern"
                    selected={selectedNutrient === QUALITY}
                    onPress={() => setSelectedNutrient(selectedNutrient === QUALITY ? null : QUALITY)}
                    detail={
                      quality
                        ? `${quality.score >= 100 ? 'Lowest' : 'Limited by'} ${quality.limiting.label.toLowerCase()}`
                        : 'No amino acid data yet'
                    }
                  />
                )}
                {Array.from({ length: spacers }, (_, i) => (
                  <View key={`spacer-${i}`} style={group === 'micro' ? styles.donutThird : styles.donutHalf} />
                ))}
              </View>
              {group === 'macro' && selectedNutrient === QUALITY ? (
                renderQualityDetails()
              ) : selected ? (
                renderDetails(selected)
              ) : (
                <Text variant="bodySmall" style={styles.meta}>
                  Tap a ring to see its details.
                  {showNeeds
                    ? ` Each ring is the average per day eaten as a share of ${firstName}'s daily need, ` +
                      `full at 100%: green ${NEED_GOOD_AT}% or more, yellow ${NEED_LOW_AT}–${NEED_GOOD_AT - 1}%, ` +
                      `red under ${NEED_LOW_AT}%.`
                    : ''}
                </Text>
              )}
              <Text variant="bodySmall" style={styles.footnote}>
                Per day = average over the days with an estimate. Values are from the Kenya Food
                Composition Tables 2018
                {summary.raw < summary.estimated
                  ? ', after the vitamins, minerals and phytate lost in cooking (KFCT retention factors, ' +
                    'by how the dish cooks each food).'
                  : '.'}
                {summary.raw > 0 && summary.raw < summary.estimated
                  ? ` ${summary.raw} older meals use raw values, so they count more vitamins and phytate.`
                  : ''}
                {hasNeeds
                  ? ' Micronutrient needs are the FAO/WHO (2004) recommended intakes for the student\'s age ' +
                    'and sex. They count meals recorded since needs were added.'
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
            </>
          )}

          {energyDays.length > 0 && (
            <>
              <Text variant="titleSmall" style={styles.sectionTitle}>Energy per day (kcal)</Text>
              <Text variant="bodySmall" style={styles.meta}>
                {selectedDay
                  ? `${formatDay(selectedDay.date)}: ${fmt(selectedDay.kcal, 0)} kcal` +
                    (energyNeed
                      ? ` · ${Math.round((100 * selectedDay.kcal) / energyNeed)}% of the daily need · ` +
                        NEED_STATUS[needStatus((100 * selectedDay.kcal) / energyNeed)].label
                      : '')
                  : `Average ${fmt(energyTotal / energyDays.length, 0)} kcal a day eaten · ` +
                    `${fmt(energyTotal, 0)} kcal over ${energyDays.length} days. Tap the chart to see a day.`}
              </Text>
              <EnergyLineChart
                days={energyDays}
                need={energyNeed}
                selectedDate={selectedEnergyDate}
                onSelect={setSelectedEnergyDate}
              />
              <Text variant="bodySmall" style={styles.footnote}>
                {energyNeed
                  ? `Colours compare each day with ${firstName}'s daily energy need of ${fmt(energyNeed, 0)} kcal ` +
                    '(FAO/WHO/UNU 2004, moderate activity).'
                  : needMissing
                  ? MISSING_TEXT[needMissing]
                  : hasNeeds && !hasMacroNeeds
                  ? 'Run supabase/fixes/021_macronutrient_needs.sql to colour each day by the daily energy need.'
                  : ''}
              </Text>
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
          const hasMeal = seesNutrition && !!r?.meal_name;
          const open = hasMeal && openMeal === a.attendance_id;
          return (
            <View key={a.attendance_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={`${formatDay(a.attendance_date)} · ${MEAL_LABELS[a.meal_type]}`}
                description={
                  !seesNutrition
                    ? undefined
                    : r?.meal_name
                    ? `${r.meal_name} · ${fmt(Number(r.energy_kcal ?? 0), 0)} kcal · ` +
                      (open ? 'tap to close' : 'tap for all nutrients')
                    : r
                    ? 'No dish on the timetable'
                    : 'Recorded before nutrition tracking'
                }
                style={styles.row}
                onPress={hasMeal ? () => setOpenMeal(open ? null : a.attendance_id) : undefined}
                accessibilityState={hasMeal ? { expanded: open } : undefined}
                right={() => (
                  <View style={styles.rowRight}>
                    {hasMeal && !r!.complete ? (
                      <StatusPill label="incomplete" tone="warning" style={styles.pill} />
                    ) : null}
                    {hasMeal ? (
                      <List.Icon icon={open ? 'chevron-up' : 'chevron-down'} color={colors.textMuted} />
                    ) : null}
                  </View>
                )}
              />
              {open && renderMealNutrients(r!)}
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
  card: { borderRadius: 16, marginBottom: 4 },
  detailHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  detailTitle: { color: c.text, fontWeight: '700' },
  close: { marginLeft: 'auto', margin: 0 },
  detailNote: { color: c.textMuted, marginTop: 8 },
  tableRow: { flexDirection: 'row', paddingVertical: 4 },
  lowNote: { color: c.warning, marginBottom: 8 },
  absorption: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  cellName: { flex: 1.3, color: c.text },
  cellValue: { flex: 1, color: c.textSecondary, textAlign: 'right' },
  footnote: { color: c.textMuted, marginTop: 10 },
  empty: { color: c.textMuted },
  donuts: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8, marginBottom: 8 },
  donutThird: { width: '32%' },
  donutHalf: { width: '48%' },
  row: { paddingRight: 0 },
  pill: { alignSelf: 'center' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  detailLead: { color: c.text, marginBottom: 10 },
  tableHead: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.divider, marginBottom: 2 },
  limiting: { fontWeight: '700' },
  low: { color: c.danger, fontWeight: '600' },
  mealPanel: { backgroundColor: c.surface, borderRadius: 12, padding: 12, marginBottom: 10 },
  mealGroup: { color: c.textSecondary, marginBottom: 6 },
  mealGroupGap: { marginTop: 10 },
  mealGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  mealCell: { width: '33.33%', paddingRight: 8 },
  mealLabel: { color: c.textMuted },
  mealValue: { color: c.text, fontWeight: '600' },
  mealPercent: { color: c.textMuted },
  bottomSpacer: { height: 40 },
});
