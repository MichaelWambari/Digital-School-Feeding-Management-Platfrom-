import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, HelperText, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { Button, Chip } from './Paper';

// Link a student's card by tapping it on one of the school's readers
// (supabase/fixes/024_card_linking.sql). The app asks the database to
// give the reader's next tap to this student, then checks the request
// until the reader has used it, it fails, or 60 seconds pass.

type Reader = { device_id: string; device_name: string | null; location: string | null };

type State =
  | { kind: 'idle' }
  | { kind: 'waiting'; requestId: string; deviceId: string; endsAt: number }
  | { kind: 'linked'; tag: string }
  | { kind: 'failed'; message: string };

const WAIT_SECONDS = 60;
const POLL_MS = 1500;

type Props = {
  schoolId: string;
  beneficiaryId: string;
  firstName: string;
  // Called with the card's UID once it is saved on the student.
  onLinked: (tag: string) => void;
  // True while waiting for a tap, so the form can hold off saving
  // (a save then would put the old card back).
  onBusyChange?: (busy: boolean) => void;
};

export default function LinkCardPanel({ schoolId, beneficiaryId, firstName, onLinked, onBusyChange }: Props) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [readers, setReaders] = useState<Reader[] | null>(null);
  const [readersError, setReadersError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [starting, setStarting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(WAIT_SECONDS);
  // The pending request, so it can be cancelled if the screen closes.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    supabase
      .from('nfc_devices')
      .select('device_id, device_name, location')
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .order('device_id')
      .then(({ data, error }) => {
        if (!live) return;
        if (error) {
          setReadersError(error.message);
          return;
        }
        setReaders(data ?? []);
        if (data && data.length > 0) setDeviceId(data[0].device_id);
      });
    return () => {
      live = false;
    };
  }, [schoolId]);

  useEffect(() => {
    onBusyChange?.(state.kind === 'waiting');
  }, [state.kind, onBusyChange]);

  // Cancel a pending request when the panel goes away.
  useEffect(
    () => () => {
      if (pending.current) supabase.rpc('cancel_card_link', { p_request_id: pending.current }).then(() => {});
    },
    []
  );

  const finish = useCallback((next: State) => {
    pending.current = null;
    setState(next);
  }, []);

  // While waiting: count down, and check the request.
  useEffect(() => {
    if (state.kind !== 'waiting') return;
    const { requestId, endsAt } = state;

    const tick = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    }, 250);

    const poll = setInterval(async () => {
      if (Date.now() > endsAt) {
        supabase.rpc('cancel_card_link', { p_request_id: requestId }).then(() => {});
        finish({ kind: 'failed', message: 'No card was tapped in time. Try again.' });
        return;
      }
      const { data } = await supabase
        .from('card_link_requests')
        .select('status, nfc_tag_id, error')
        .eq('request_id', requestId)
        .maybeSingle();
      if (!data || data.status === 'pending') return;

      if (data.status === 'linked' && data.nfc_tag_id) {
        finish({ kind: 'linked', tag: data.nfc_tag_id });
        onLinked(data.nfc_tag_id);
      } else if (data.error === 'card_in_use' && data.nfc_tag_id) {
        // The holder is shown only if they are at this school (RLS).
        const { data: holder } = await supabase
          .from('beneficiaries')
          .select('full_name, admission_no')
          .eq('nfc_tag_id', data.nfc_tag_id)
          .maybeSingle();
        finish({
          kind: 'failed',
          message: holder
            ? `That card already belongs to ${holder.full_name} (${holder.admission_no}). Use another card, or remove it from them first.`
            : "That card already belongs to a student at another school. Use another card.",
        });
      } else if (data.status === 'cancelled') {
        finish({ kind: 'failed', message: 'Linking was cancelled (perhaps started again on another phone).' });
      } else {
        finish({ kind: 'failed', message: `The card could not be linked (${data.error ?? data.status}).` });
      }
    }, POLL_MS);

    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [state, finish, onLinked]);

  async function start() {
    if (!deviceId) return;
    setStarting(true);
    const { data, error } = await supabase.rpc('start_card_link', {
      p_beneficiary_id: beneficiaryId,
      p_device_id: deviceId,
    });
    setStarting(false);
    if (error) {
      finish({ kind: 'failed', message: describeError(error) });
      return;
    }
    pending.current = data.request_id;
    setSecondsLeft(WAIT_SECONDS);
    // Timed from the phone's own clock, so a phone set to the wrong time still gets 60 s.
    setState({ kind: 'waiting', requestId: data.request_id, deviceId, endsAt: Date.now() + WAIT_SECONDS * 1000 });
  }

  async function cancel() {
    if (state.kind !== 'waiting') return;
    await supabase.rpc('cancel_card_link', { p_request_id: state.requestId });
    finish({ kind: 'idle' });
  }

  if (readersError) {
    return <HelperText type="error">Could not load the school's readers: {readersError}</HelperText>;
  }
  if (readers === null) return null;
  if (readers.length === 0) {
    return (
      <Text variant="bodySmall" style={styles.hint}>
        To link a card by tapping it, the school needs an active NFC reader.
      </Text>
    );
  }

  const readerLabel = (r: Reader) => r.device_name || r.device_id;

  return (
    <View style={styles.panel}>
      {state.kind === 'waiting' ? (
        <>
          <View style={styles.waitingRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text variant="titleSmall" style={styles.waitingText}>
              Tap {firstName}'s card on {readerLabel(readers.find((r) => r.device_id === state.deviceId)!)}
            </Text>
          </View>
          <Text variant="bodySmall" style={styles.hint}>
            Waiting {secondsLeft} s. The reader's next tap will be linked to {firstName}, so keep other
            students away from it.
          </Text>
          <Button mode="outlined" icon="close" onPress={cancel} style={styles.button}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          {readers.length > 1 && (
            <View style={styles.readers}>
              {readers.map((r) => (
                <Chip
                  key={r.device_id}
                  selected={deviceId === r.device_id}
                  showSelectedOverlay
                  onPress={() => setDeviceId(r.device_id)}
                  icon="nfc-variant"
                  style={styles.chip}
                >
                  {readerLabel(r)}
                </Chip>
              ))}
            </View>
          )}
          {state.kind === 'linked' && (
            <Text variant="bodyMedium" style={styles.linked}>
              Card {state.tag} linked to {firstName} and saved.
            </Text>
          )}
          {state.kind === 'failed' && <HelperText type="error">{state.message}</HelperText>}
          <Button
            mode="contained-tonal"
            icon="nfc-tap"
            onPress={start}
            loading={starting}
            disabled={starting || !deviceId}
            style={styles.button}
          >
            {state.kind === 'linked' ? 'Link a different card' : 'Link card by tapping'}
          </Button>
          {readers.length === 1 && state.kind === 'idle' && (
            <Text variant="bodySmall" style={styles.hint}>
              Uses {readerLabel(readers[0])}.
            </Text>
          )}
        </>
      )}
    </View>
  );
}

function describeError(error: { code?: string; message: string }) {
  if (error.code === 'PGRST202') return 'Card linking is not set up yet: run supabase/fixes/024 in Supabase.';
  if (error.code === '42501') return 'You do not have permission to manage students.';
  return error.message;
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    panel: { marginTop: 8 },
    readers: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
    chip: { marginRight: 8, marginBottom: 8 },
    button: { marginTop: 4, alignSelf: 'flex-start' },
    hint: { color: c.textMuted, marginTop: 6 },
    waitingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
    waitingText: { marginLeft: 10, flexShrink: 1 },
    linked: { color: c.successText, marginBottom: 4 },
  });
