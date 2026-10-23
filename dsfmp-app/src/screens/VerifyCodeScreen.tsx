import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn, PressableScale } from '../components/Motion';

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
      <FadeIn>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>
          {sending && !sentTo
            ? 'Sending your sign-in code…'
            : sentTo
            ? `We sent a 6-digit code to ${sentTo}. It expires in 10 minutes.`
            : 'We could not send your sign-in code.'}
        </Text>

        <TextInput
          style={styles.codeInput}
          placeholderTextColor={colors.placeholder}
          value={code}
          onChangeText={handleChange}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={6}
          placeholder="••••••"
          autoFocus
          editable={!verifying}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <PressableScale style={styles.button} onPress={() => handleVerify()} disabled={verifying}>
          {verifying ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.buttonText}>Verify</Text>
          )}
        </PressableScale>

        <PressableScale
          style={styles.linkButton}
          onPress={sendCode}
          disabled={sending || wait > 0}
        >
          <Text style={[styles.link, (sending || wait > 0) && styles.linkDisabled]}>
            {sending ? 'Sending…' : wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
          </Text>
        </PressableScale>

        <PressableScale style={styles.linkButton} onPress={() => supabase.auth.signOut()}>
          <Text style={styles.logout}>Use a different account</Text>
        </PressableScale>
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
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center', color: c.text },
  subtitle: { fontSize: 14, color: c.textMuted, textAlign: 'center', marginTop: 8, marginBottom: 28 },
  codeInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingVertical: 14,
    fontSize: 28,
    letterSpacing: 10,
    textAlign: 'center',
    color: c.text,
  },
  error: { color: c.danger, fontSize: 13, marginTop: 12, textAlign: 'center' },
  button: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 14,
    marginTop: 24,
    alignItems: 'center',
  },
  buttonText: { color: c.onPrimary, fontSize: 16, fontWeight: '600' },
  linkButton: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  link: { color: c.primary, fontSize: 14, fontWeight: '600' },
  linkDisabled: { color: c.textMuted, fontWeight: '400' },
  logout: { color: c.danger, fontSize: 14 },
});
