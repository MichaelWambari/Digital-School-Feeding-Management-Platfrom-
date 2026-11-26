import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { Avatar, Divider, HelperText, Surface, Text, TextInput } from 'react-native-paper';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn } from '../components/Motion';
import { Button, SegmentedButtons } from '../components/Paper';

// Sign in, or (for a headteacher setting up their school) create an
// account. A new account then names its school (CreateSchoolScreen).
export default function LoginScreen() {
  const { styles } = useThemedStyles(makeStyles);
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  // Who is signing up: a headteacher setting up a school, or a food supplier.
  const [accountType, setAccountType] = useState<'school' | 'supplier'>('school');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState<'password' | 'google' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const signingUp = mode === 'signup';
  const resetting = mode === 'reset';

  function switchMode() {
    setMode(signingUp || resetting ? 'signin' : 'signup');
    setError(null);
    setInfo(null);
    setConfirm('');
  }

  function startReset() {
    setMode('reset');
    setError(null);
    setInfo(null);
  }

  // Emails a link to choose a new password. Opening it signs the user in
  // and AppNavigator shows ChangePasswordScreen (PASSWORD_RECOVERY).
  async function handleReset() {
    if (!email.trim()) {
      setError('Enter the email you sign in with.');
      return;
    }
    setLoading('reset');
    setError(null);
    setInfo(null);
    try {
      const redirectTo =
        Platform.OS === 'web' ? window.location.origin : Linking.createURL('reset-password');
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
      if (error) {
        setError(describeAuthError(error.message));
        return;
      }
      // The same message whether or not the account exists, so the form
      // can't be used to find out who has an account.
      setInfo(
        'If an account uses this email, a link to choose a new password is on its way. ' +
          'Open it on this device. Google accounts sign in with Google instead.'
      );
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setLoading(null);
    }
  }

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
    if (signingUp) {
      if (!fullName.trim()) {
        setError('Enter your full name.');
        return;
      }
      if (password.length < 8) {
        setError('Choose a password of at least 8 characters.');
        return;
      }
      if (password !== confirm) {
        setError("The passwords don't match.");
        return;
      }
    }
    setLoading('password');
    setError(null);
    setInfo(null);
    try {
      if (signingUp) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim(), account_type: accountType } },
        });
        if (error) {
          setError(describeAuthError(error.message));
        } else if (!data.session) {
          // Supabase's own "Confirm email" setting is on.
          setInfo('Check your email and confirm your account, then sign in here.');
          setMode('signin');
        }
        // With a session, AppNavigator moves on to the emailed code, then
        // to naming the school.
        return;
      }
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
      // Supabase only returns here if this address matches its Redirect URLs
      // (e.g. exp://** for Expo Go); otherwise it goes to the Site URL.
      if (__DEV__) console.log('Google sign-in returns to', redirectTo);
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
          <Text variant="titleMedium" style={styles.cardTitle}>
            {resetting ? 'Forgot your password?' : signingUp ? 'Create an account' : 'Sign in'}
          </Text>
          <Text variant="bodySmall" style={styles.cardSubtitle}>
            {resetting
              ? "Enter your email and we'll send you a link to choose a new password."
              : !signingUp
              ? 'Headteachers, coordinators and suppliers'
              : accountType === 'school'
              ? "For a headteacher setting up their school. Coordinators don't sign up: your headteacher adds you."
              : 'For a business that supplies food to schools. Schools choose which suppliers they work with.'}
          </Text>
          {signingUp && (
            <SegmentedButtons
              style={styles.fieldGap}
              value={accountType}
              onValueChange={(v) => setAccountType(v as 'school' | 'supplier')}
              buttons={[
                { value: 'school', label: "I'm a headteacher", icon: 'school-outline' },
                { value: 'supplier', label: "I'm a supplier", icon: 'truck-outline' },
              ]}
            />
          )}
          {signingUp && (
            <TextInput
              mode="outlined"
              label="Full name"
              style={styles.fieldGap}
              left={<TextInput.Icon icon="account-outline" />}
              autoComplete="name"
              value={fullName}
              onChangeText={setFullName}
            />
          )}
          <TextInput
            mode="outlined"
            label="Email"
            style={signingUp ? styles.passwordInput : undefined}
            placeholder="you@school.ac.ke"
            left={<TextInput.Icon icon="email-outline" />}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            onSubmitEditing={resetting ? handleReset : undefined}
          />
          {!resetting && (
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
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={signingUp ? undefined : handleLogin}
              error={!!error}
            />
          )}
          {signingUp && (
            <TextInput
              mode="outlined"
              label="Type the password again"
              style={styles.passwordInput}
              left={<TextInput.Icon icon="lock-check-outline" />}
              secureTextEntry={!showPassword}
              autoComplete="new-password"
              value={confirm}
              onChangeText={setConfirm}
              onSubmitEditing={handleLogin}
            />
          )}
          {info ? (
            <HelperText type="info" visible>
              {info}
            </HelperText>
          ) : (
            <HelperText type="error" visible={!!error}>
              {error}
            </HelperText>
          )}

          {resetting ? (
            <Button
              mode="contained"
              onPress={handleReset}
              loading={loading === 'reset'}
              disabled={loading !== null}
              contentStyle={styles.buttonContent}
            >
              Send reset link
            </Button>
          ) : (
            <Button
              mode="contained"
              onPress={handleLogin}
              loading={loading === 'password'}
              disabled={loading !== null}
              contentStyle={styles.buttonContent}
            >
              {signingUp ? 'Create account' : 'Login'}
            </Button>
          )}
          {mode === 'signin' && (
            <Button mode="text" onPress={startReset} disabled={loading !== null} style={styles.switchButton}>
              Forgot password?
            </Button>
          )}
          <Button mode="text" onPress={switchMode} disabled={loading !== null} style={styles.switchButton}>
            {signingUp || resetting ? 'Back to sign in' : 'New headteacher or supplier? Create an account'}
          </Button>

          {!resetting && (
            <>
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
                Coordinators: use the Google account with the email your headteacher added. A new headteacher or supplier can also start here.
              </Text>
            </>
          )}
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
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'An account with that email already exists. Sign in instead.';
  }
  if (m.includes('email not confirmed')) {
    return 'Confirm your email first: open the link Supabase sent you, then sign in.';
  }
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) {
    return 'New accounts are switched off. Turn on "Allow new users to sign up" in Supabase (Authentication > Sign In / Providers).';
  }
  if (m.includes('rate limit') || m.includes('security purposes')) {
    return 'Too many emails were sent. Wait a few minutes and try again.';
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
  fieldGap: { marginTop: 12 },
  cardTitle: { color: c.text, fontWeight: '600' },
  cardSubtitle: { color: c.textMuted, marginTop: 2 },
  switchButton: { marginTop: 8 },
  buttonContent: { paddingVertical: 6 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 18 },
  dividerLine: { flex: 1 },
  dividerText: { color: c.textMuted, marginHorizontal: 12 },
  hint: { color: c.textMuted, textAlign: 'center', marginTop: 12 },
});
