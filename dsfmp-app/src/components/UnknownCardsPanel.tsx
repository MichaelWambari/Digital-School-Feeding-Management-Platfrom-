import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Card, Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { Button, ListItem } from './Paper';

// Cards tapped on the school's readers but refused as unknown, so staff
// can link one to a student on the spot (supabase/fixes/027). Shown only
// to staff who may manage students, and only when there are some.

type UnknownCard = { nfc_tag_id: string; device_id: string; device_name: string; last_tap: string; taps: number };
type Student = { beneficiary_id: string; full_name: string; admission_no: string; nfc_tag_id: string | null; status: string };

const POLL_MS = 8000;

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

type Props = {
  schoolId: string;
  // Called after a card is linked, e.g. to reload the student list.
  onLinked?: () => void;
};

export default function UnknownCardsPanel({ schoolId, onLinked }: Props) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const focused = useIsFocused();
  const [cards, setCards] = useState<UnknownCard[]>([]);
  const [linking, setLinking] = useState<string | null>(null); // card being linked
  const [students, setStudents] = useState<Student[] | null>(null);
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState<Student | null>(null); // student who already has a card
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('recent_unknown_cards', { p_school_id: schoolId });
    // Not set up yet (fix 027) or no permission: show nothing.
    if (rpcError) return;
    setCards((data as UnknownCard[]) ?? []);
  }, [schoolId]);

  useEffect(() => {
    if (!focused) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [focused, load]);

  async function startLinking(tag: string) {
    setLinking(tag);
    setSearch('');
    setConfirm(null);
    setError(null);
    setMessage(null);
    if (!students) {
      const { data } = await supabase
        .from('beneficiaries')
        .select('beneficiary_id, full_name, admission_no, nfc_tag_id, status')
        .eq('school_id', schoolId)
        .order('full_name');
      setStudents((data as Student[]) ?? []);
    }
  }

  async function link(tag: string, student: Student) {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('link_unknown_card', {
      p_school_id: schoolId,
      p_nfc_tag_id: tag,
      p_beneficiary_id: student.beneficiary_id,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    const first = (data as { first_name: string }).first_name;
    setMessage(`Card ${tag} linked to ${student.full_name}. Ask ${first} to tap again to be served.`);
    setLinking(null);
    setConfirm(null);
    setStudents((list) =>
      list ? list.map((s) => (s.beneficiary_id === student.beneficiary_id ? { ...s, nfc_tag_id: tag } : s)) : list
    );
    setCards((list) => list.filter((c) => c.nfc_tag_id !== tag));
    onLinked?.();
  }

  async function ignore(tag: string) {
    setCards((list) => list.filter((c) => c.nfc_tag_id !== tag));
    if (linking === tag) setLinking(null);
    await supabase.rpc('ignore_unknown_card', { p_school_id: schoolId, p_nfc_tag_id: tag });
  }

  const matches = useMemo(() => {
    if (!students) return [];
    const term = search.trim().toLowerCase();
    const active = students.filter((s) => s.status === 'active');
    if (!term) {
      // Students without a card first: the likeliest owners.
      return [...active].sort((a, b) => Number(!!a.nfc_tag_id) - Number(!!b.nfc_tag_id)).slice(0, 6);
    }
    return students
      .filter((s) => s.full_name.toLowerCase().includes(term) || s.admission_no.toLowerCase().includes(term))
      .slice(0, 8);
  }, [students, search]);

  if (cards.length === 0 && !message) return null;

  return (
    <Card mode="outlined" style={[styles.card, cards.length > 0 && { borderColor: colors.warning }]}>
      <Card.Content>
        {message && (
          <Text variant="bodyMedium" style={styles.success}>
            {message}
          </Text>
        )}
        {cards.length > 0 && (
          <Text variant="titleSmall" style={styles.title}>
            {cards.length === 1 ? 'An unknown card was tapped' : `${cards.length} unknown cards were tapped`}
          </Text>
        )}
        {cards.map((c, i) => (
          <View key={c.nfc_tag_id}>
            {i > 0 && <Divider style={styles.divider} />}
            <View style={styles.cardRow}>
              <View style={styles.cardText}>
                <Text variant="labelLarge">Card {c.nfc_tag_id}</Text>
                <Text variant="bodySmall" style={styles.hint}>
                  {c.device_name} · {ago(c.last_tap)}
                  {c.taps > 1 ? ` · tapped ${c.taps} times` : ''}
                </Text>
              </View>
              {linking !== c.nfc_tag_id && (
                <>
                  <Button mode="contained-tonal" compact onPress={() => startLinking(c.nfc_tag_id)}>
                    Link
                  </Button>
                  <Button mode="text" compact onPress={() => ignore(c.nfc_tag_id)}>
                    Ignore
                  </Button>
                </>
              )}
            </View>

            {linking === c.nfc_tag_id && (
              <View style={styles.picker}>
                {confirm ? (
                  <>
                    <Text variant="bodyMedium">
                      {confirm.full_name} already has card {confirm.nfc_tag_id}. Replace it with {c.nfc_tag_id}? The old
                      card will stop working.
                    </Text>
                    <View style={styles.actions}>
                      <Button mode="contained" onPress={() => link(c.nfc_tag_id, confirm)} loading={busy} disabled={busy}>
                        Replace
                      </Button>
                      <Button mode="text" onPress={() => setConfirm(null)} disabled={busy}>
                        Back
                      </Button>
                    </View>
                  </>
                ) : (
                  <>
                    <Searchbar
                      value={search}
                      onChangeText={setSearch}
                      placeholder="Whose card is it? Name or admission no."
                      autoCapitalize="none"
                      elevation={0}
                      style={styles.search}
                    />
                    {students === null ? (
                      <Text variant="bodySmall" style={styles.hint}>Loading students…</Text>
                    ) : matches.length === 0 ? (
                      <Text variant="bodySmall" style={styles.hint}>No student matches.</Text>
                    ) : (
                      matches.map((s) => (
                        <ListItem
                          key={s.beneficiary_id}
                          title={s.full_name}
                          description={`${s.admission_no}${s.nfc_tag_id ? ` · has card ${s.nfc_tag_id}` : ' · no card yet'}${
                            s.status !== 'active' ? ' · inactive' : ''
                          }`}
                          onPress={() => (s.nfc_tag_id ? setConfirm(s) : link(c.nfc_tag_id, s))}
                          disabled={busy}
                          style={styles.student}
                        />
                      ))
                    )}
                    <Button mode="text" onPress={() => setLinking(null)} style={styles.cancel} disabled={busy}>
                      Cancel
                    </Button>
                  </>
                )}
                <HelperText type="error" visible={!!error}>
                  {error}
                </HelperText>
              </View>
            )}
          </View>
        ))}
      </Card.Content>
    </Card>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    card: { marginBottom: 12 },
    title: { marginBottom: 4 },
    success: { color: c.successText, marginBottom: 8 },
    hint: { color: c.textMuted, marginTop: 2 },
    divider: { marginVertical: 8 },
    cardRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
    cardText: { flex: 1, marginRight: 8 },
    picker: { marginTop: 8 },
    search: { backgroundColor: c.surface, marginBottom: 4 },
    student: { paddingLeft: 0 },
    actions: { flexDirection: 'row', marginTop: 8 },
    cancel: { alignSelf: 'flex-start' },
  });
