import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView, PressableScale } from '../components/Motion';

type Beneficiary = {
  beneficiary_id: string;
  full_name: string;
  age: number | null;
  admission_no: string;
  nfc_tag_id: string | null;
  status: 'active' | 'inactive';
};

type FormState = {
  full_name: string;
  age: string;
  admission_no: string;
  nfc_tag_id: string;
  status: 'active' | 'inactive';
};

const EMPTY_FORM: FormState = {
  full_name: '',
  age: '',
  admission_no: '',
  nfc_tag_id: '',
  status: 'active',
};

export default function StudentsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  // Network admins can look at any school's students; the school's own staff manage them.
  const { school, isNetworkAdmin } = useSchool();
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // null = showing the list; 'new' = adding; otherwise the row being edited
  const [editing, setEditing] = useState<Beneficiary | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadBeneficiaries = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('beneficiaries')
      .select('beneficiary_id, full_name, age, admission_no, nfc_tag_id, status')
      .eq('school_id', school.school_id)
      .order('full_name');
    if (error) {
      setLoadError(error.message);
    } else {
      setLoadError(null);
      setBeneficiaries(data ?? []);
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    loadBeneficiaries();
  }, [loadBeneficiaries]);

  function openForm(target: Beneficiary | 'new') {
    setForm(
      target === 'new'
        ? EMPTY_FORM
        : {
            full_name: target.full_name,
            age: target.age?.toString() ?? '',
            admission_no: target.admission_no,
            nfc_tag_id: target.nfc_tag_id ?? '',
            status: target.status,
          }
    );
    setFormError(null);
    setEditing(target);
  }

  async function handleSave() {
    const fullName = form.full_name.trim();
    const admissionNo = form.admission_no.trim();
    const ageText = form.age.trim();

    if (!fullName || !admissionNo) {
      setFormError('Full name and admission number are required.');
      return;
    }
    const age = ageText ? Number(ageText) : null;
    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) {
      setFormError('Age must be a whole number.');
      return;
    }

    const payload = {
      full_name: fullName,
      age,
      admission_no: admissionNo,
      nfc_tag_id: form.nfc_tag_id.trim() || null,
      status: form.status,
    };

    setSaving(true);
    setFormError(null);
    try {
      const query =
        editing === 'new'
          ? supabase.from('beneficiaries').insert({ ...payload, school_id: school.school_id })
          : supabase
              .from('beneficiaries')
              .update(payload)
              .eq('beneficiary_id', (editing as Beneficiary).beneficiary_id);
      // .select() makes RLS-blocked updates visible: they succeed with zero rows.
      const { data, error } = await query.select('beneficiary_id');

      if (error) {
        setFormError(describeError(error));
        return;
      }
      if (!data || data.length === 0) {
        setFormError('You do not have permission to manage students.');
        return;
      }
      setEditing(null);
      await loadBeneficiaries();
    } catch {
      setFormError('Unable to connect. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <PressableScale onPress={() => setEditing(null)} disabled={saving}>
            <Text style={styles.back}>‹ Cancel</Text>
          </PressableScale>
          <Text style={styles.headerTitle}>
            {editing === 'new' ? 'Add student' : 'Edit student'}
          </Text>
          <View style={styles.headerSpacer} />
        </View>

        <Text style={styles.label}>Full name *</Text>
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.placeholder}
          value={form.full_name}
          onChangeText={(full_name) => setForm({ ...form, full_name })}
          placeholder="e.g. Jane Wanjiku"
        />

        <Text style={styles.label}>Admission number *</Text>
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.placeholder}
          value={form.admission_no}
          onChangeText={(admission_no) => setForm({ ...form, admission_no })}
          autoCapitalize="characters"
          placeholder="e.g. ADM-1024"
        />

        <Text style={styles.label}>Age</Text>
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.placeholder}
          value={form.age}
          onChangeText={(age) => setForm({ ...form, age })}
          keyboardType="number-pad"
          placeholder="Optional"
        />

        <Text style={styles.label}>NFC tag ID</Text>
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.placeholder}
          value={form.nfc_tag_id}
          onChangeText={(nfc_tag_id) => setForm({ ...form, nfc_tag_id })}
          autoCapitalize="characters"
          placeholder="Card UID, optional"
        />

        <Text style={styles.label}>Status</Text>
        <View style={styles.segment}>
          {(['active', 'inactive'] as const).map((status) => (
            <PressableScale
              key={status}
              style={[styles.segmentItem, form.status === status && styles.segmentItemActive]}
              onPress={() => setForm({ ...form, status })}
              accessibilityState={{ selected: form.status === status }}
            >
              <Text
                style={[styles.segmentText, form.status === status && styles.segmentTextActive]}
              >
                {status === 'active' ? 'Active' : 'Inactive'}
              </Text>
            </PressableScale>
          ))}
        </View>

        {formError && <Text style={styles.error}>{formError}</Text>}

        <PressableScale style={styles.button} onPress={handleSave} disabled={saving}>
          {saving ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.buttonText}>Save</Text>
          )}
        </PressableScale>
      </FadeInScrollView>
    );
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
        <PressableScale onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹ Back</Text>
        </PressableScale>
        <Text style={styles.headerTitle}>Students</Text>
        {isNetworkAdmin ? (
          <View style={styles.headerSpacer} />
        ) : (
          <PressableScale onPress={() => openForm('new')}>
            <Text style={styles.add}>+ Add</Text>
          </PressableScale>
        )}
      </View>

      {isNetworkAdmin && (
        <Text style={styles.viewOnly}>View only. {school.name}'s staff manage its students.</Text>
      )}

      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name or admission no."
        autoCapitalize="none"
      />

      {loadError && <Text style={styles.error}>Could not load students: {loadError}</Text>}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(b) => b.beneficiary_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadBeneficiaries} />}
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.empty}>
              {term ? 'No students match your search.' : 'No students yet.'}
            </Text>
          )
        }
        renderItem={({ item }) => (
          <PressableScale
            style={styles.row}
            onPress={() => openForm(item)}
            disabled={isNetworkAdmin}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>{item.full_name}</Text>
              <Text style={styles.rowMeta}>
                {item.admission_no}
                {item.age !== null ? ` · Age ${item.age}` : ''}
                {item.nfc_tag_id ? ' · NFC linked' : ''}
              </Text>
            </View>
            <Text style={[styles.badge, item.status === 'inactive' && styles.badgeInactive]}>
              {item.status}
            </Text>
          </PressableScale>
        )}
      />
    </View>
  );
}

function describeError(error: { code?: string; message: string }) {
  if (error.code === '23505') {
    return error.message.includes('nfc_tag_id')
      ? 'That NFC tag is already assigned to another student.'
      : 'That admission number is already registered at this school.';
  }
  if (error.code === '42501') {
    return 'You do not have permission to manage students.';
  }
  return error.message;
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: c.text },
  headerSpacer: { width: 60 },
  back: { color: c.primary, fontSize: 15 },
  add: { color: c.primary, fontSize: 15, fontWeight: '600' },
  viewOnly: { fontSize: 13, color: c.textMuted, marginBottom: 12 },
  label: { fontSize: 13, color: c.textSecondary, marginBottom: 6, marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: c.text,
  },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: c.border, borderRadius: 8 },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: c.primary, borderRadius: 7 },
  segmentText: { fontSize: 14, color: c.textSecondary },
  segmentTextActive: { color: c.onPrimary, fontWeight: '600' },
  error: { color: c.danger, fontSize: 13, marginTop: 12 },
  button: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 14,
    marginTop: 28,
    marginBottom: 40,
    alignItems: 'center',
  },
  buttonText: { color: c.onPrimary, fontSize: 16, fontWeight: '600' },
  list: { marginTop: 12 },
  empty: { textAlign: 'center', color: c.textMuted, marginTop: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 16, color: c.text },
  rowMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  badge: {
    fontSize: 12,
    color: c.successText,
    backgroundColor: c.successBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },
  badgeInactive: { color: c.textMuted, backgroundColor: c.surface },
});
