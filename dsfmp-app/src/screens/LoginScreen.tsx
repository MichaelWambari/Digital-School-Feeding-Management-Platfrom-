import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { Avatar, Divider, HelperText, Surface, Text, TextInput } from 'react-native-paper';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn } from '../components/Motion';
import { Button } from '../components/Paper';

export default function LoginScreen() {
  const { styles } = useThemedStyles(makeStyles);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
      <FadeIn style={styles.content}>
        <View style={styles.brand}>
          <Avatar.Icon size={64} icon="silverware-fork-knife" />
          <Text variant="headlineMedium" style={styles.title}>DSFMP</Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            Digital School Feeding Management Platform
          </Text>
        </View>

        <Surface style={styles.card} elevation={1}>
          <TextInput
            mode="outlined"
            label="Email"
            placeholder="you@school.ac.ke"
            left={<TextInput.Icon icon="email-outline" />}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            mode="outlined"
            label="Password"
            style={styles.passwordInput}
            left={<TextInput.Icon icon="lock-outline" />}
            right={
              <TextInput.Icon
                icon={showPassword ? 'eye-off' : 'eye'}
                onPress={() => setShowPassword((shown) => !shown)}
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
              />
            }
            secureTextEntry={!showPassword}
            autoComplete="current-password"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={handleLogin}
            error={!!error}
          />
          <HelperText type="error" visible={!!error}>
            {error}
          </HelperText>

          <Button
            mode="contained"
            onPress={handleLogin}
            loading={loading === 'password'}
            disabled={loading !== null}
            contentStyle={styles.buttonContent}
          >
            Login
          </Button>

          <View style={styles.dividerRow}>
            <Divider style={styles.dividerLine} />
            <Text variant="bodySmall" style={styles.dividerText}>or</Text>
            <Divider style={styles.dividerLine} />
          </View>

          <Button
            mode="outlined"
            icon="google"
            onPress={handleGoogle}
            loading={loading === 'google'}
            disabled={loading !== null}
            contentStyle={styles.buttonContent}
          >
            Continue with Google
          </Button>
          <Text variant="bodySmall" style={styles.hint}>
            Use the Google account with the email your network admin added.
          </Text>
        </Surface>
      </FadeIn>
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
  // Keeps the form a comfortable width on tablets and the web.
  content: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  brand: { alignItems: 'center', marginBottom: 28 },
  title: { fontWeight: '700', marginTop: 14, color: c.text },
  subtitle: { color: c.textMuted, textAlign: 'center', marginTop: 4 },
  card: { borderRadius: 16, padding: 20 },
  passwordInput: { marginTop: 12 },
  buttonContent: { paddingVertical: 6 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 18 },
  dividerLine: { flex: 1 },
  dividerText: { color: c.textMuted, marginHorizontal: 12 },
  hint: { color: c.textMuted, textAlign: 'center', marginTop: 12 },
});
