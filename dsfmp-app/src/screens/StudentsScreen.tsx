import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Divider, HelperText, Searchbar, Text, TextInput } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, ListItem, SegmentedButtons } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';

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
          label="Age"
          value={form.age}
          onChangeText={(age) => setForm({ ...form, age })}
          keyboardType="number-pad"
          placeholder="Optional"
        />
        <Field
          label="NFC tag ID"
          value={form.nfc_tag_id}
          onChangeText={(nfc_tag_id) => setForm({ ...form, nfc_tag_id })}
          autoCapitalize="characters"
          placeholder="Card UID, optional"
          left={<TextInput.Icon icon="nfc-variant" />}
        />

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
          disabled={saving}
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
          !isNetworkAdmin && (
            <Button mode="text" icon="plus" onPress={() => openForm('new')}>
              Add
            </Button>
          )
        }
      />

      {isNetworkAdmin && (
        <Text variant="bodySmall" style={styles.viewOnly}>
          View only. {school.name}'s staff manage its students.
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
              (item.age !== null ? ` · Age ${item.age}` : '') +
              (item.nfc_tag_id ? ' · NFC linked' : '')
            }
            onPress={() => openForm(item)}
            disabled={isNetworkAdmin}
            style={styles.row}
            contentStyle={styles.rowContent}
            right={() => (
              <StatusPill
                label={item.status}
                tone={item.status === 'active' ? 'success' : 'muted'}
                style={styles.pill}
              />
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
  buttonContent: { paddingVertical: 6 },
  saveButton: { marginTop: 8, marginBottom: 40 },
  search: { backgroundColor: c.surface },
  list: { marginTop: 12 },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  pill: { alignSelf: 'center' },
});
