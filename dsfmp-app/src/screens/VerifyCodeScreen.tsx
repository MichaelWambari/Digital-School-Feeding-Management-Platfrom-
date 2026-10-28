import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Avatar, HelperText, Surface, Text, TextInput } from 'react-native-paper';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn } from '../components/Motion';
import { Button } from '../components/Paper';

const RESEND_SECONDS = 30;

// The second sign-in step after a password login: a 6-digit code is
// emailed by the login-code Edge Function and entered here. The database
// keeps this login locked until the code is verified.
export default function VerifyCodeScreen({ onVerified }: { onVerified: () => void }) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  // Kept in a ref so a new onVerified from the parent doesn't resend the code.
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const sendCode = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('login-code', { body: { action: 'send' } });
      if (error) {
        setError(await describeFunctionError(error));
        return;
      }
      if (data?.verified) {
        onVerifiedRef.current();
        return;
      }
      setSentTo(data?.sent_to ?? 'your email');
      setWait(RESEND_SECONDS);
    } finally {
      setSending(false);
    }
  }, []);

  useEffect(() => {
    sendCode();
  }, [sendCode]);

  // Counts down until another code can be requested.
  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  async function handleVerify(value = code) {
    if (!/^\d{6}$/.test(value)) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('login-code', {
        body: { action: 'verify', code: value },
      });
      if (error) {
        setError(await describeFunctionError(error));
        setCode('');
        return;
      }
      if (data?.verified) onVerifiedRef.current();
    } finally {
      setVerifying(false);
    }
  }

  function handleChange(text: string) {
    const digits = text.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    // Check as soon as all six digits are in.
    if (digits.length === 6) handleVerify(digits);
  }

  return (
    <View style={styles.container}>
      <FadeIn style={styles.content}>
        <View style={styles.brand}>
          <Avatar.Icon size={64} icon="email-lock-outline" />
          <Text variant="headlineSmall" style={styles.title}>Check your email</Text>
          <Text variant="bodyMedium" style={styles.subtitle}>
            {sending && !sentTo
              ? 'Sending your sign-in code…'
              : sentTo
              ? `We sent a 6-digit code to ${sentTo}. It expires in 10 minutes.`
              : 'We could not send your sign-in code.'}
          </Text>
        </View>

        <Surface style={styles.card} elevation={1}>
          <TextInput
            mode="outlined"
            label="Sign-in code"
            style={styles.codeInput}
            contentStyle={styles.codeText}
            value={code}
            onChangeText={handleChange}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            placeholder="••••••"
            autoFocus
            disabled={verifying}
            error={!!error}
          />
          <HelperText type="error" visible={!!error} style={styles.error}>
            {error}
          </HelperText>

          <Button
            mode="contained"
            onPress={() => handleVerify()}
            loading={verifying}
            disabled={verifying}
            contentStyle={styles.buttonContent}
          >
            Verify
          </Button>

          <Button
            mode="text"
            icon="email-sync-outline"
            onPress={sendCode}
            disabled={sending || wait > 0}
            style={styles.linkButton}
          >
            {sending ? 'Sending…' : wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
          </Button>
          <Button
            mode="text"
            icon="account-switch-outline"
            textColor={colors.danger}
            onPress={() => supabase.auth.signOut()}
          >
            Use a different account
          </Button>
        </Surface>
      </FadeIn>
    </View>
  );
}

async function describeFunctionError(error: unknown) {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    if (response.status === 404) {
      return 'Sign-in codes are not set up yet: the login-code function is not deployed. See "Sign-in codes" in the README.';
    }
    const body = await response.json().catch(() => null);
    if (body?.error) return String(body.error);
    if (response.status === 401) {
      return 'Supabase rejected the login for login-code. Turn off "Verify JWT" for the function, or sign in again.';
    }
    return body?.message ?? error.message;
  }
  if (error instanceof FunctionsFetchError) {
    return 'Could not reach the sign-in code service. Check your connection and try again.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: c.background },
  content: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  brand: { alignItems: 'center', marginBottom: 28 },
  title: { fontWeight: '700', textAlign: 'center', marginTop: 14, color: c.text },
  subtitle: { color: c.textMuted, textAlign: 'center', marginTop: 6 },
  card: { borderRadius: 16, padding: 20 },
  codeInput: { fontSize: 28 },
  codeText: { letterSpacing: 10, textAlign: 'center' },
  error: { textAlign: 'center' },
  buttonContent: { paddingVertical: 6 },
  linkButton: { marginTop: 12 },
});
