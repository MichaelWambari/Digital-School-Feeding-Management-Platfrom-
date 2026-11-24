import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Divider, HelperText, Searchbar, Text, TextInput } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, IconButton, ListItem, SegmentedButtons } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';
import LinkCardPanel from '../components/LinkCardPanel';

type Beneficiary = {
  beneficiary_id: string;
  full_name: string;
  age: number | null;
  sex?: 'female' | 'male' | null; // fix 018
  date_of_birth?: string | null; // fix 020, YYYY-MM-DD
  admission_no: string;
  nfc_tag_id: string | null;
  status: 'active' | 'inactive';
};

type FormState = {
  full_name: string;
  date_of_birth: string;
  age: string;
  sex: '' | 'female' | 'male';
  admission_no: string;
  nfc_tag_id: string;
  status: 'active' | 'inactive';
};

const EMPTY_FORM: FormState = {
  full_name: '',
  date_of_birth: '',
  age: '',
  sex: '',
  admission_no: '',
  nfc_tag_id: '',
  status: 'active',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Whole years from a YYYY-MM-DD date of birth to today, or null if the
// text isn't a real date.
export function ageFromBirth(dob: string): number | null {
  if (!DATE_PATTERN.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const born = new Date(y, m - 1, d);
  if (born.getFullYear() !== y || born.getMonth() !== m - 1 || born.getDate() !== d) return null;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() < m - 1 || (now.getMonth() === m - 1 && now.getDate() < d)) age--;
  return age;
}

export default function StudentsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, can } = useSchool();
  // The database checks the same permission.
  const canManage = can('manage_students');
  // Tapping a student opens their feeding report, for those who may see it.
  const canReport = can('view_attendance') || can('view_nutrition');
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // null = showing the list; 'new' = adding; otherwise the row being edited
  const [editing, setEditing] = useState<Beneficiary | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // True while the student's card is being linked by a tap (fix 024).
  const [linking, setLinking] = useState(false);

  const loadBeneficiaries = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('beneficiaries')
      // '*' so the list still loads before fix 018 adds sex.
      .select('*')
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

  const handleCardLinked = useCallback(
    (tag: string) => {
      // Already saved by the database; show it in the form and the list.
      setForm((f) => ({ ...f, nfc_tag_id: tag }));
      setEditing((e) => (e && e !== 'new' ? { ...e, nfc_tag_id: tag } : e));
      loadBeneficiaries();
    },
    [loadBeneficiaries]
  );

  function openForm(target: Beneficiary | 'new') {
    setForm(
      target === 'new'
        ? EMPTY_FORM
        : {
            full_name: target.full_name,
            date_of_birth: target.date_of_birth ?? '',
            age: target.age?.toString() ?? '',
            sex: target.sex ?? '',
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
    const dob = form.date_of_birth.trim();
    const dobAge = dob ? ageFromBirth(dob) : null;
    if (dob && dobAge === null) {
      setFormError('Enter the date of birth as YYYY-MM-DD, e.g. 2014-03-21.');
      return;
    }
    if (dobAge !== null && (dobAge < 0 || dobAge > 30)) {
      setFormError(dobAge < 0 ? "The date of birth can't be in the future." : 'Check the date of birth.');
      return;
    }
    const age = dobAge ?? (ageText ? Number(ageText) : null);
    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) {
      setFormError('Age must be a whole number.');
      return;
    }
    // Sent only when there is one, or there was one, so saving still
    // works before fix 020 adds the column.
    const hadDob = editing !== 'new' && !!editing && 'date_of_birth' in editing;

    const payload = {
      full_name: fullName,
      ...(dob || hadDob ? { date_of_birth: dob || null } : {}),
      age,
      sex: form.sex || null,
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
      <FadeInScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader
          title={editing === 'new' ? 'Add student' : 'Edit student'}
          onBack={() => setEditing(null)}
          backLabel="Cancel"
          backDisabled={saving}
        />

        <Field
          label="Full name *"
          value={form.full_name}
          onChangeText={(full_name) => setForm({ ...form, full_name })}
          placeholder="e.g. Jane Wanjiku"
        />
        <Field
          label="Admission number *"
          value={form.admission_no}
          onChangeText={(admission_no) => setForm({ ...form, admission_no })}
          autoCapitalize="characters"
          placeholder="e.g. ADM-1024"
        />
        <Field
          label="Date of birth"
          value={form.date_of_birth}
          onChangeText={(date_of_birth) => setForm({ ...form, date_of_birth })}
          keyboardType="numbers-and-punctuation"
          placeholder="YYYY-MM-DD, optional"
          maxLength={10}
        />
        {form.date_of_birth.trim() ? (
          <Text variant="bodySmall" style={styles.fieldHint}>
            {ageFromBirth(form.date_of_birth.trim()) !== null
              ? `Age ${ageFromBirth(form.date_of_birth.trim())}, worked out from the date of birth.`
              : 'Use YYYY-MM-DD, e.g. 2014-03-21.'}
          </Text>
        ) : (
          <Field
            label="Age"
            value={form.age}
            onChangeText={(age) => setForm({ ...form, age })}
            keyboardType="number-pad"
            placeholder="If the date of birth isn't known"
          />
        )}
        <Text variant="labelLarge" style={styles.label}>Sex</Text>
        <SegmentedButtons
          value={form.sex}
          onValueChange={(sex) => setForm({ ...form, sex: sex as FormState['sex'] })}
          buttons={[
            { value: 'female', label: 'Female', icon: 'gender-female' },
            { value: 'male', label: 'Male', icon: 'gender-male' },
          ]}
        />
        <Text variant="bodySmall" style={styles.fieldHint}>
          Age and sex set the student's daily nutrient needs (FAO/WHO). From age 10, boys' and
          girls' needs differ, so the feeding report needs both. With a date of birth the age
          stays right as the student grows older.
        </Text>
        <Field
          label="NFC tag ID"
          value={form.nfc_tag_id}
          onChangeText={(nfc_tag_id) => setForm({ ...form, nfc_tag_id })}
          autoCapitalize="characters"
          placeholder="Card UID, optional"
          left={<TextInput.Icon icon="nfc-variant" />}
        />
        {editing !== 'new' && canManage && (
          <LinkCardPanel
            schoolId={school.school_id}
            beneficiaryId={editing.beneficiary_id}
            firstName={editing.full_name.split(' ')[0]}
            onLinked={handleCardLinked}
            onBusyChange={setLinking}
          />
        )}

        <Text variant="labelLarge" style={styles.label}>Status</Text>
        <SegmentedButtons
          value={form.status}
          onValueChange={(status) => setForm({ ...form, status: status as FormState['status'] })}
          buttons={[
            { value: 'active', label: 'Active', icon: 'check-circle-outline' },
            { value: 'inactive', label: 'Inactive', icon: 'pause-circle-outline' },
          ]}
        />

        <HelperText type="error" visible={!!formError}>
          {formError}
        </HelperText>

        <Button
          mode="contained"
          onPress={handleSave}
          loading={saving}
          disabled={saving || linking}
          contentStyle={styles.buttonContent}
          style={styles.saveButton}
        >
          Save
        </Button>
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
    <View style={[styles.container, styles.content]}>
      <ScreenHeader
        title="Students"
        onBack={() => navigation.goBack()}
        right={
          canManage && (
            <Button mode="text" icon="plus" onPress={() => openForm('new')}>
              Add
            </Button>
          )
        }
      />

      {!canManage && (
        <Text variant="bodySmall" style={styles.viewOnly}>
          View only. You don't have permission to manage students.
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

      {loadError && (
        <HelperText type="error">Could not load students: {loadError}</HelperText>
      )}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(b) => b.beneficiary_id}
        ItemSeparatorComponent={Divider}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadBeneficiaries} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>{term ? 'No students match your search.' : 'No students yet.'}</EmptyText>
          )
        }
        renderItem={({ item }) => (
          <ListItem
            title={item.full_name}
            description={
              item.admission_no +
              ((item.date_of_birth ? ageFromBirth(item.date_of_birth) : item.age) !== null
                ? ` · Age ${item.date_of_birth ? ageFromBirth(item.date_of_birth) : item.age}`
                : '') +
              (item.nfc_tag_id ? ' · NFC linked' : '')
            }
            onPress={() =>
              canReport
                ? navigation.navigate('StudentReport', {
                    beneficiaryId: item.beneficiary_id,
                    name: item.full_name,
                    admissionNo: item.admission_no,
                  })
                : openForm(item)
            }
            disabled={!canReport && !canManage}
            style={styles.row}
            contentStyle={styles.rowContent}
            right={() => (
              <View style={styles.rowRight}>
                <StatusPill
                  label={item.status}
                  tone={item.status === 'active' ? 'success' : 'muted'}
                  style={styles.pill}
                />
                {canReport && canManage && (
                  <IconButton
                    icon="pencil-outline"
                    accessibilityLabel={`Edit ${item.full_name}`}
                    onPress={() => openForm(item)}
                  />
                )}
              </View>
            )}
          />
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
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 20 },
  viewOnly: { color: c.textMuted, marginBottom: 12 },
  label: { color: c.textSecondary, marginTop: 16, marginBottom: 8 },
  fieldHint: { color: c.textMuted, marginTop: 6 },
  buttonContent: { paddingVertical: 6 },
  saveButton: { marginTop: 8, marginBottom: 40 },
  search: { backgroundColor: c.surface },
  list: { marginTop: 12 },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  pill: { alignSelf: 'center' },
  rowRight: { flexDirection: 'row', alignItems: 'center' },
});
