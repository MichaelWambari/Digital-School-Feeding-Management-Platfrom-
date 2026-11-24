import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Divider, HelperText, List, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { Button, SegmentedButtons } from '../components/Paper';
import { EmptyText, ScreenHeader, StatCard, StatusPill } from '../components/ScreenParts';
import UnknownCardsPanel from '../components/UnknownCardsPanel';

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

// The meal to open on, from today's timetable: the one being served
// now, else the one that ended last (to check it), else the day's first.
// Falls back to lunch if today has no timetable.
async function currentMeal(schoolId: string): Promise<MealType> {
  const now = new Date();
  const isoWeekday = now.getDay() === 0 ? 7 : now.getDay();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const { data } = await supabase
    .from('meal_schedules')
    .select('meal_type, start_time, end_time')
    .eq('school_id', schoolId)
    .eq('weekday', isoWeekday)
    .order('start_time');
  const meals = (data ?? []) as { meal_type: MealType; start_time: string; end_time: string }[];
  if (meals.length === 0) return 'lunch';
  const serving = meals.find((m) => m.start_time <= time && time < m.end_time);
  if (serving) return serving.meal_type;
  const ended = meals.filter((m) => m.end_time <= time);
  if (ended.length > 0) return ended[ended.length - 1].meal_type;
  return meals[0].meal_type;
}

export default function AttendanceScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, can } = useSchool();
  // The database checks the same permission.
  const canManage = can('record_attendance');
  // null until the current meal is worked out from the timetable.
  const [mealType, setMealType] = useState<MealType | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  // beneficiary_id -> attendance_id for today's selected meal
  const [present, setPresent] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const date = todayLocal();

  useEffect(() => {
    let cancelled = false;
    currentMeal(school.school_id)
      .catch(() => 'lunch' as MealType)
      .then((meal) => {
        if (!cancelled) setMealType(meal);
      });
    return () => {
      cancelled = true;
    };
  }, [school.school_id]);

  const loadData = useCallback(async () => {
    if (!mealType) return;
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

  // Live updates: a meal recorded by an NFC tap or on another device
  // shows up without a refresh. Realtime applies the table's row level
  // security, so only this school's rows arrive.
  useEffect(() => {
    if (!mealType) return;
    const channel = supabase
      .channel(`attendance-${school.school_id}-${date}-${mealType}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'meal_attendance',
          filter: `school_id=eq.${school.school_id}`,
        },
        (payload) => {
          const row = payload.new as {
            attendance_id: string;
            beneficiary_id: string;
            attendance_date: string;
            meal_type: string;
          };
          if (row.attendance_date !== date || row.meal_type !== mealType) return;
          setPresent((prev) => new Map(prev).set(row.beneficiary_id, row.attendance_id));
        }
      )
      // Deletes can't be filtered and only carry the row's id, so match
      // it against the meals on screen.
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'meal_attendance' },
        (payload) => {
          const removedId = (payload.old as { attendance_id?: string }).attendance_id;
          if (!removedId) return;
          setPresent((prev) => {
            const entry = [...prev].find(([, attendanceId]) => attendanceId === removedId);
            if (!entry) return prev;
            const next = new Map(prev);
            next.delete(entry[0]);
            return next;
          });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [date, mealType, school.school_id]);

  async function markPresent(b: Beneficiary) {
    if (!mealType) return;
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
      {/* A card refused as unknown at the reader can be linked here (fix 027). */}
      {can('manage_students') && <UnknownCardsPanel schoolId={school.school_id} />}

      <SegmentedButtons
        value={mealType ?? ''}
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

      {!canManage && (
        <Text variant="bodySmall" style={styles.viewOnly}>
          View only. You don't have permission to record attendance.
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
                !canManage ? (
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
