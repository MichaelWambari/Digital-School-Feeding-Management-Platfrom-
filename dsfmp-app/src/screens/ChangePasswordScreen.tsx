import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Avatar, HelperText, Surface, Text, TextInput } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn } from '../components/Motion';
import { Button } from '../components/Paper';

// Shown at the first sign-in of a login someone else created (or after a
// headteacher reset its password), so only the user knows their password.
// Also shown after opening a "forgot password" link (recovery).
export default function ChangePasswordScreen({
  onChanged,
  recovery = false,
}: {
  onChanged: () => void;
  recovery?: boolean;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (password.length < 8) {
      setError('The password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(
          updateError.message.toLowerCase().includes('different')
            ? recovery
              ? 'Choose a password different from your old one.'
              : 'Choose a password different from the one you were given.'
            : updateError.message
        );
        return;
      }
      const { error: rpcError } = await supabase.rpc('password_changed');
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
      onChanged();
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <FadeIn style={styles.content}>
        <View style={styles.brand}>
          <Avatar.Icon size={64} icon="lock-reset" />
          <Text variant="headlineSmall" style={styles.title}>
            {recovery ? 'Choose a new password' : 'Choose your password'}
          </Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            {recovery
              ? 'You opened a password reset link. Choose a new password to finish signing in.'
              : 'You signed in with a password someone gave you. Choose one only you know.'}
          </Text>
        </View>

        <Surface style={styles.card} elevation={1}>
          <TextInput
            mode="outlined"
            label="New password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            disabled={saving}
          />
          <TextInput
            mode="outlined"
            label="Type it again"
            style={styles.secondInput}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            disabled={saving}
            onSubmitEditing={handleSave}
          />
          <HelperText type="error" visible={!!error}>
            {error}
          </HelperText>

          <Button
            mode="contained"
            onPress={handleSave}
            loading={saving}
            disabled={saving}
            contentStyle={styles.buttonContent}
          >
            Save password
          </Button>
          <Button
            mode="text"
            icon="logout"
            textColor={colors.danger}
            onPress={() => supabase.auth.signOut()}
            style={styles.linkButton}
          >
            Logout
          </Button>
        </Surface>
      </FadeIn>
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: c.background },
  content: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  brand: { alignItems: 'center', marginBottom: 28 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 14, color: c.text },
  subtitle: { color: c.textMuted, textAlign: 'center', marginTop: 6 },
  card: { borderRadius: 16, padding: 20 },
  secondInput: { marginTop: 12 },
  buttonContent: { paddingVertical: 6 },
  linkButton: { marginTop: 12 },
});
