import React, { useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Avatar, HelperText, Surface, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { describeSupplierError } from '../lib/suppliers';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn } from '../components/Motion';
import { Button } from '../components/Paper';
import { SupplierFields, checkSupplierForm, supplierForm, supplierParams } from '../components/SupplierForm';

// Shown to a new account that chose "I'm a supplier": the business details
// create its supplier profile. Foods, documents and schools come next.
export default function CreateSupplierScreen({
  defaultName,
  defaultEmail,
  onCreated,
  onSwitch,
}: {
  defaultName: string;
  defaultEmail: string;
  onCreated: () => void;
  // Goes back to setting up a school instead.
  onSwitch: () => void;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [form, setForm] = useState(() =>
    supplierForm(null, { contact_name: defaultName === 'New User' ? '' : defaultName, email: defaultEmail })
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const problem = checkSupplierForm(form);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error } = await supabase.rpc('create_my_supplier', supplierParams(form));
      if (error) {
        setError(describeSupplierError(error));
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
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <FadeIn style={styles.content}>
        <View style={styles.brand}>
          <Avatar.Icon size={64} icon="truck-outline" />
          <Text variant="headlineSmall" style={styles.title}>Set up your supplier account</Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            Schools see these details when they decide whether to work with you. Next you'll add the
            foods you supply, your documents and the schools you'd like to supply.
          </Text>
        </View>

        <Surface style={styles.card} elevation={1}>
          <SupplierFields form={form} onChange={setForm} disabled={saving} />
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
            Create my supplier account
          </Button>
          <Button mode="text" onPress={onSwitch} disabled={saving} style={styles.linkButton}>
            I'm setting up a school instead
          </Button>
          <Button
            mode="text"
            icon="logout"
            textColor={colors.danger}
            onPress={() => supabase.auth.signOut()}
            disabled={saving}
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
  content: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  brand: { alignItems: 'center', marginBottom: 24 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 14, color: c.text },
  subtitle: { color: c.textMuted, textAlign: 'center', marginTop: 6 },
  card: { borderRadius: 16, padding: 20, paddingTop: 8 },
  buttonContent: { paddingVertical: 6 },
  linkButton: { marginTop: 8 },
});
