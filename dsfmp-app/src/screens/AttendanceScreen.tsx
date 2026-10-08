import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';

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

// Local calendar date as YYYY-MM-DD, so "today" matches the coordinator's day
// rather than the database server's UTC date.
function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function AttendanceScreen({ navigation }: any) {
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
        .eq('status', 'active')
        .order('full_name'),
      supabase
        .from('meal_attendance')
        .select('attendance_id, beneficiary_id')
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
  }, [date, mealType]);

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
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Attendance</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.segment}>
        {MEAL_TYPES.map((meal) => (
          <TouchableOpacity
            key={meal}
            style={[styles.segmentItem, mealType === meal && styles.segmentItemActive]}
            onPress={() => setMealType(meal)}
            accessibilityState={{ selected: mealType === meal }}
          >
            <Text style={[styles.segmentText, mealType === meal && styles.segmentTextActive]}>
              {MEAL_LABELS[meal]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryNumber}>
          {present.size} / {beneficiaries.length}
        </Text>
        <Text style={styles.summaryLabel}>present · {date}</Text>
      </View>

      <TextInput
        style={styles.input}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name or admission no."
        autoCapitalize="none"
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(b) => b.beneficiary_id}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.empty}>
              {term ? 'No beneficiaries match your search.' : 'No active beneficiaries.'}
            </Text>
          )
        }
        renderItem={({ item }) => {
          const isPresent = present.has(item.beneficiary_id);
          const isBusy = busyId === item.beneficiary_id;
          return (
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>{item.full_name}</Text>
                <Text style={styles.rowMeta}>{item.admission_no}</Text>
              </View>
              <TouchableOpacity
                style={[styles.markButton, isPresent && styles.markButtonDone]}
                onPress={() => (isPresent ? undoPresent(item) : markPresent(item))}
                disabled={isBusy || busyId !== null}
                accessibilityLabel={
                  isPresent
                    ? `${item.full_name} is present. Tap to undo.`
                    : `Mark ${item.full_name} present`
                }
              >
                {isBusy ? (
                  <ActivityIndicator color={isPresent ? '#166534' : '#fff'} />
                ) : (
                  <Text style={[styles.markText, isPresent && styles.markTextDone]}>
                    {isPresent ? '✓ Present' : 'Mark present'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          );
        }}
      />
    </View>
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
  summary: {
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    padding: 16,
    marginVertical: 16,
  },
  summaryNumber: { fontSize: 26, fontWeight: '700' },
  summaryLabel: { fontSize: 13, color: '#666', marginTop: 2 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  error: { color: '#dc2626', fontSize: 13, marginTop: 12 },
  list: { marginTop: 12 },
  empty: { textAlign: 'center', color: '#666', marginTop: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 16 },
  rowMeta: { fontSize: 13, color: '#666', marginTop: 2 },
  markButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 110,
    alignItems: 'center',
  },
  markButtonDone: { backgroundColor: '#dcfce7' },
  markText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  markTextDone: { color: '#166534' },
});
