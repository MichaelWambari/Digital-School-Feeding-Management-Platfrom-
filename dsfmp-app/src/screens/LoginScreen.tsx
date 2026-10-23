import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { PressableScale } from '../components/Motion';

export default function LoginScreen() {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'password' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // On the web, a failed Google sign-in comes back as an error in the URL.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const params = authParams(window.location.href);
    if (params.get('error_description') || params.get('error')) {
      setError(describeAuthError(params.get('error_description') ?? params.get('error') ?? ''));
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  async function handleLogin() {
    if (!email.trim() || !password) {
      setError('Enter both your email and password.');
      return;
    }
    setLoading('password');
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setError(describeAuthError(error.message));
      // On success AppNavigator moves on to the emailed-code step.
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setLoading(null);
    }
  }

  async function handleGoogle() {
    setLoading('google');
    setError(null);
    try {
      if (Platform.OS === 'web') {
        // The page goes to Google and comes back here signed in.
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: window.location.origin, queryParams: { prompt: 'select_account' } },
        });
        if (error) setError(describeAuthError(error.message));
        return;
      }

      // On a phone, Google opens in a browser sheet that returns to the app.
      const redirectTo = Linking.createURL('auth-callback');
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
      });
      if (error || !data.url) {
        setError(describeAuthError(error?.message ?? 'Could not start Google sign-in.'));
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== 'success') return; // closed by the user

      const params = authParams(result.url);
      const code = params.get('code');
      if (!code) {
        setError(describeAuthError(params.get('error_description') ?? 'Google sign-in did not finish.'));
        return;
      }
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) setError(describeAuthError(exchangeError.message));
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>DSFMP</Text>
      <Text style={styles.subtitle}>Digital School Feeding Management Platform</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        placeholder="you@school.ac.ke"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        placeholder="••••••••"
        secureTextEntry
        autoComplete="current-password"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={handleLogin}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <PressableScale style={styles.button} onPress={handleLogin} disabled={loading !== null}>
        {loading === 'password' ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>Login</Text>
        )}
      </PressableScale>

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <PressableScale style={styles.googleButton} onPress={handleGoogle} disabled={loading !== null}>
        {loading === 'google' ? (
          <ActivityIndicator color={colors.text} />
        ) : (
          <>
            <Text style={styles.googleMark}>G</Text>
            <Text style={styles.googleText}>Continue with Google</Text>
          </>
        )}
      </PressableScale>
      <Text style={styles.hint}>Use the Google account with the email your network admin added.</Text>
    </View>
  );
}

// Reads auth results from a redirect URL's query string or #fragment.
function authParams(url: string) {
  const params = new URLSearchParams(url.split('?')[1]?.split('#')[0] ?? '');
  new URLSearchParams(url.split('#')[1] ?? '').forEach((value, key) => params.set(key, value));
  return params;
}

function describeAuthError(message: string) {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Wrong email or password.';
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) {
    return "This Google account isn't registered. Ask your network admin to add your email in Staff.";
  }
  if (m.includes('provider is not enabled')) {
    return 'Google sign-in is not turned on for this app yet.';
  }
  return message;
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: c.background },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 4, color: c.text },
  subtitle: { fontSize: 13, color: c.textMuted, textAlign: 'center', marginBottom: 32 },
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
  error: { color: c.danger, fontSize: 13, marginTop: 12 },
  button: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 14,
    marginTop: 28,
    alignItems: 'center',
  },
  buttonText: { color: c.onPrimary, fontSize: 16, fontWeight: '600' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: c.divider },
  dividerText: { fontSize: 13, color: c.textMuted, marginHorizontal: 12 },
  googleButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingVertical: 13,
    minHeight: 50,
  },
  googleMark: { fontSize: 18, fontWeight: '700', color: c.primary, marginRight: 10 },
  googleText: { fontSize: 15, fontWeight: '600', color: c.text },
  hint: { fontSize: 12, color: c.textMuted, textAlign: 'center', marginTop: 10 },
});
