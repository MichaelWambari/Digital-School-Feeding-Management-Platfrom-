import React, { useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Avatar, HelperText, Surface, Text, TextInput } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn } from '../components/Motion';
import { Button } from '../components/Paper';

// Shown to an account that doesn't belong to a school yet: the headteacher
// names their school, which creates it and makes them its headteacher.
export default function CreateSchoolScreen({
  defaultName,
  onCreated,
  onSwitch,
}: {
  defaultName: string;
  onCreated: () => void;
  // Sets up a supplier account instead.
  onSwitch: () => void;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [fullName, setFullName] = useState(defaultName === 'New User' ? '' : defaultName);
  const [schoolName, setSchoolName] = useState('');
  const [county, setCounty] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!fullName.trim()) {
      setError('Enter your full name.');
      return;
    }
    if (!schoolName.trim()) {
      setError('Enter the name of your school.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error } = await supabase.rpc('create_my_school', {
        p_school_name: schoolName.trim(),
        p_full_name: fullName.trim(),
        p_county: county.trim() || null,
        p_location: location.trim() || null,
        p_timezone: 'Africa/Nairobi',
      });
      if (error) {
        setError(
          error.code === 'PGRST202'
            ? 'The database needs updating. Run supabase/fixes/013_headteacher_signup.sql.'
            : error.message
        );
        return;
      }
      onCreated();
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <FadeIn style={styles.content}>
        <View style={styles.brand}>
          <Avatar.Icon size={64} icon="school-outline" />
          <Text variant="headlineSmall" style={styles.title}>Set up your school</Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            You'll be its headteacher. You can add a coordinator, students and the meal timetable
            next.
          </Text>
        </View>

        <Surface style={styles.card} elevation={1}>
          <TextInput mode="outlined" label="Your full name" value={fullName} onChangeText={setFullName} />
          <TextInput
            mode="outlined"
            label="School name"
            style={styles.gap}
            value={schoolName}
            onChangeText={setSchoolName}
            placeholder="e.g. Tumaini Primary School"
          />
          <TextInput
            mode="outlined"
            label="County (optional)"
            style={styles.gap}
            value={county}
            onChangeText={setCounty}
            placeholder="e.g. Nakuru"
          />
          <TextInput
            mode="outlined"
            label="Town or area (optional)"
            style={styles.gap}
            value={location}
            onChangeText={setLocation}
            onSubmitEditing={handleCreate}
          />
          <HelperText type="error" visible={!!error}>
            {error}
          </HelperText>
          <Button
            mode="contained"
            icon="check"
            onPress={handleCreate}
            loading={saving}
            disabled={saving}
            contentStyle={styles.buttonContent}
          >
            Create my school
          </Button>
          <Button mode="text" onPress={onSwitch} disabled={saving} style={styles.linkButton}>
            I'm a food supplier instead
          </Button>
          <Button
            mode="text"
            icon="logout"
            textColor={colors.danger}
            onPress={() => supabase.auth.signOut()}
            disabled={saving}
            style={styles.linkButton}
          >
            Logout
          </Button>
        </Surface>
      </FadeIn>
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  content: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  brand: { alignItems: 'center', marginBottom: 24 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 14, color: c.text },
  subtitle: { color: c.textMuted, textAlign: 'center', marginTop: 6 },
  card: { borderRadius: 16, padding: 20 },
  gap: { marginTop: 12 },
  buttonContent: { paddingVertical: 6 },
  linkButton: { marginTop: 8 },
});
