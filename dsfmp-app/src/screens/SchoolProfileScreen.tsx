import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { HelperText, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button } from '../components/Paper';
import { Field, ScreenHeader } from '../components/ScreenParts';

const FIELDS = [
  { key: 'name', label: 'School name *', placeholder: '' },
  { key: 'registration_no', label: 'Registration number', placeholder: 'Ministry of Education code' },
  { key: 'location', label: 'Location', placeholder: 'e.g. Nakuru town' },
  { key: 'county', label: 'County', placeholder: 'e.g. Nakuru' },
  { key: 'phone', label: 'Phone', placeholder: 'e.g. 0712 345 678' },
  { key: 'email', label: 'Email', placeholder: 'e.g. office@school.ac.ke' },
  { key: 'timezone', label: 'Timezone *', placeholder: 'Africa/Nairobi' },
] as const;

type Key = (typeof FIELDS)[number]['key'];

// The school's details. Only the headteacher can change them.
export default function SchoolProfileScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { school, isHeadteacher, reload } = useSchool();
  const [form, setForm] = useState<Record<Key, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, school[f.key] ?? ''])) as Record<Key, string>
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'info'; text: string } | null>(null);

  async function handleSave() {
    const values = Object.fromEntries(
      FIELDS.map((f) => [f.key, form[f.key].trim() || null])
    ) as Record<Key, string | null>;
    if (!values.name) {
      setMessage({ type: 'error', text: 'The school name is required.' });
      return;
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: values.timezone ?? '' });
    } catch {
      setMessage({ type: 'error', text: 'Enter a timezone such as Africa/Nairobi.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const { data, error } = await supabase
        .from('schools')
        .update(values)
        .eq('school_id', school.school_id)
        .select('school_id');
      if (error) {
        setMessage({
          type: 'error',
          text: error.code === '23505' ? 'Another school already has that name.' : error.message,
        });
        return;
      }
      if (!data || data.length === 0) {
        setMessage({ type: 'error', text: 'Only the headteacher can change the school profile.' });
        return;
      }
      setMessage({ type: 'info', text: 'Saved.' });
      await reload();
    } catch {
      setMessage({ type: 'error', text: 'Unable to connect. Check your connection and try again.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="School profile" onBack={() => navigation.goBack()} backDisabled={saving} />
      {!isHeadteacher && (
        <Text variant="bodySmall" style={styles.hint}>View only. The headteacher keeps the school profile.</Text>
      )}

      {FIELDS.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          value={form[f.key]}
          onChangeText={(text) => setForm({ ...form, [f.key]: text })}
          placeholder={f.placeholder}
          disabled={!isHeadteacher}
          autoCapitalize={f.key === 'email' || f.key === 'timezone' ? 'none' : 'sentences'}
          keyboardType={f.key === 'email' ? 'email-address' : f.key === 'phone' ? 'phone-pad' : 'default'}
        />
      ))}

      {isHeadteacher && (
        <>
          <HelperText type={message?.type ?? 'info'} visible={!!message}>
            {message?.text}
          </HelperText>
          <Button
            mode="contained"
            onPress={handleSave}
            loading={saving}
            disabled={saving}
            contentStyle={styles.buttonContent}
          >
            Save
          </Button>
        </>
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  hint: { color: c.textMuted, marginBottom: 4 },
  buttonContent: { paddingVertical: 6 },
  bottomSpacer: { height: 40 },
});
