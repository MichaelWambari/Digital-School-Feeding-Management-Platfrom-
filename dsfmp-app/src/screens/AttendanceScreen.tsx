import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Divider, HelperText, List, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { Button, SegmentedButtons } from '../components/Paper';
import { EmptyText, ScreenHeader, StatCard, StatusPill } from '../components/ScreenParts';

type Beneficiary = {
  beneficiary_id: string;
  full_name: string;
  admission_no: string;
};

const MEAL_TYPES = ['breakfast', 'lunch', 'supper'] as const;
type MealType = (typeof MEAL_TYPES)[number];
const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  supper: 'Supper',
};
const MEAL_ICONS: Record<MealType, string> = {
  breakfast: 'coffee-outline',
  lunch: 'food-outline',
  supper: 'weather-night',
};

// Local calendar date as YYYY-MM-DD, so "today" matches the coordinator's day
// rather than the database server's UTC date.
function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function AttendanceScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  // Network admins can look at any school's attendance; the school's own staff record it.
  const { school, isNetworkAdmin } = useSchool();
  const [mealType, setMealType] = useState<MealType>('lunch');
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  // beneficiary_id -> attendance_id for today's selected meal
  const [present, setPresent] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const date = todayLocal();

  const loadData = useCallback(async () => {
    setLoading(true);
    const [beneficiaryResult, attendanceResult] = await Promise.all([
      supabase
        .from('beneficiaries')
        .select('beneficiary_id, full_name, admission_no')
        .eq('school_id', school.school_id)
        .eq('status', 'active')
        .order('full_name'),
      supabase
        .from('meal_attendance')
        .select('attendance_id, beneficiary_id')
        .eq('school_id', school.school_id)
        .eq('attendance_date', date)
        .eq('meal_type', mealType),
    ]);
    const loadError = beneficiaryResult.error ?? attendanceResult.error;
    if (loadError) {
      setError(`Could not load attendance: ${loadError.message}`);
    } else {
      setError(null);
      setBeneficiaries(beneficiaryResult.data ?? []);
      setPresent(
        new Map((attendanceResult.data ?? []).map((a) => [a.beneficiary_id, a.attendance_id]))
      );
    }
    setLoading(false);
  }, [date, mealType, school.school_id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function markPresent(b: Beneficiary) {
    setBusyId(b.beneficiary_id);
    setError(null);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('meal_attendance')
        .insert({
          beneficiary_id: b.beneficiary_id,
          meal_type: mealType,
          attendance_date: date,
          status: 'present',
          recorded_by: auth.user?.id ?? null,
        })
        .select('attendance_id')
        .single();

      if (error) {
        if (error.code === '23505') {
          // Already recorded (e.g. by an NFC scan or another device) -- just resync.
          await loadData();
        } else if (error.code === '42501') {
          setError('You do not have permission to record attendance.');
        } else {
          setError(error.message);
        }
        return;
      }
      setPresent((prev) => new Map(prev).set(b.beneficiary_id, data.attendance_id));
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function undoPresent(b: Beneficiary) {
    const attendanceId = present.get(b.beneficiary_id);
    if (!attendanceId) return;
    setBusyId(b.beneficiary_id);
    setError(null);
    try {
      // .select() makes RLS-blocked deletes visible: they succeed with zero rows.
      const { data, error } = await supabase
        .from('meal_attendance')
        .delete()
        .eq('attendance_id', attendanceId)
        .select('attendance_id');
      if (error) {
        setError(error.message);
        return;
      }
      if (!data || data.length === 0) {
        setError('You do not have permission to change attendance.');
        return;
      }
      setPresent((prev) => {
        const next = new Map(prev);
        next.delete(b.beneficiary_id);
        return next;
      });
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setBusyId(null);
    }
  }

  const term = search.trim().toLowerCase();
  const filtered = term
    ? beneficiaries.filter(
        (b) =>
          b.full_name.toLowerCase().includes(term) ||
          b.admission_no.toLowerCase().includes(term)
      )
    : beneficiaries;

  return (
    <View style={styles.container}>
      <ScreenHeader title="Attendance" onBack={() => navigation.goBack()} />

      <SegmentedButtons
        value={mealType}
        onValueChange={(meal) => setMealType(meal as MealType)}
        buttons={MEAL_TYPES.map((meal) => ({
          value: meal,
          label: MEAL_LABELS[meal],
          icon: MEAL_ICONS[meal],
        }))}
      />

      <StatCard
        style={styles.summary}
        value={`${present.size} / ${beneficiaries.length}`}
        label={`present · ${date}`}
      />

      {isNetworkAdmin && (
        <Text variant="bodySmall" style={styles.viewOnly}>
          View only. {school.name}'s staff record its attendance.
        </Text>
      )}

      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name or admission no."
        autoCapitalize="none"
        elevation={0}
        style={styles.search}
      />

      {error && <HelperText type="error">{error}</HelperText>}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(b) => b.beneficiary_id}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={Divider}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadData} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>{term ? 'No students match your search.' : 'No active students.'}</EmptyText>
          )
        }
        renderItem={({ item }) => {
          const isPresent = present.has(item.beneficiary_id);
          const isBusy = busyId === item.beneficiary_id;
          return (
            <List.Item
              title={item.full_name}
              description={item.admission_no}
              style={styles.row}
              contentStyle={styles.rowContent}
              right={() =>
                isNetworkAdmin ? (
                  <StatusPill
                    label={isPresent ? 'Present' : 'Not recorded'}
                    tone={isPresent ? 'success' : 'muted'}
                    style={styles.pill}
                  />
                ) : (
                  <Button
                    mode={isPresent ? 'contained-tonal' : 'contained'}
                    icon={isPresent ? 'check' : undefined}
                    compact
                    style={styles.markButton}
                    buttonColor={isPresent ? colors.successBg : undefined}
                    textColor={isPresent ? colors.successText : undefined}
                    // One change at a time; checked here rather than disabling
                    // every row, which would grey them all out while it saves.
                    onPress={() => {
                      if (busyId !== null) return;
                      if (isPresent) undoPresent(item);
                      else markPresent(item);
                    }}
                    loading={isBusy}
                    accessibilityLabel={
                      isPresent
                        ? `${item.full_name} is present. Tap to undo.`
                        : `Mark ${item.full_name} present`
                    }
                  >
                    {isPresent ? 'Present' : 'Mark present'}
                  </Button>
                )
              }
            />
          );
        }}
      />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  summary: { marginTop: 16 },
  viewOnly: { color: c.textMuted, marginBottom: 12 },
  search: { backgroundColor: c.surface },
  list: { marginTop: 12 },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  markButton: { alignSelf: 'center', minWidth: 120 },
  pill: { alignSelf: 'center' },
});
