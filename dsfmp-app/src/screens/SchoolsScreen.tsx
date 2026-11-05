import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Card, Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { invokeManageStaff } from '../lib/manageStaff';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, ListItem } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';

type SchoolRow = {
  school_id: string;
  name: string;
  location: string | null;
  county: string | null;
  phone: string | null;
  email: string | null;
  registration_no: string | null;
  timezone: string;
  status: 'active' | 'suspended';
  created_at: string;
  headteacher_name: string | null;
  headteacher_email: string | null;
};

const EMPTY_FORM = {
  name: '',
  registration_no: '',
  location: '',
  county: '',
  phone: '',
  email: '',
  timezone: 'Africa/Nairobi',
  head_name: '',
  head_email: '',
  head_password: '',
};

// The platform admin's list of schools: onboard a school with its first
// headteacher, and suspend or restore a school's account. The school's
// own records stay with the school.
export default function SchoolsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<SchoolRow | 'new' | null>(null);

  const loadSchools = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('list_schools');
    if (error) {
      setLoadError(
        error.code === 'PGRST202' ? 'Run supabase/fixes/009_independent_schools.sql first.' : error.message
      );
    } else {
      setLoadError(null);
      setSchools((data ?? []) as SchoolRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSchools();
  }, [loadSchools]);

  if (view === 'new') {
    return (
      <OnboardForm
        onCancel={() => setView(null)}
        onDone={async () => {
          setView(null);
          await loadSchools();
        }}
      />
    );
  }
  if (view) {
    return (
      <SchoolDetail
        school={view}
        onBack={() => setView(null)}
        onChanged={async (status) => {
          setView({ ...view, status });
          await loadSchools();
        }}
      />
    );
  }

  const term = search.trim().toLowerCase();
  const filtered = term
    ? schools.filter((s) =>
        [s.name, s.county, s.location, s.headteacher_name].some((v) => v?.toLowerCase().includes(term))
      )
    : schools;

  return (
    <View style={styles.container}>
      <ScreenHeader
        title="Schools"
        onBack={() => navigation.goBack()}
        right={
          <Button mode="text" icon="plus" onPress={() => setView('new')}>
            Onboard
          </Button>
        }
      />

      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, county or headteacher"
        autoCapitalize="none"
        elevation={0}
        style={styles.search}
      />

      {loadError && <HelperText type="error">Could not load schools: {loadError}</HelperText>}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(s) => s.school_id}
        ItemSeparatorComponent={Divider}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadSchools} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>{term ? 'No schools match your search.' : 'No schools yet. Onboard the first one.'}</EmptyText>
          )
        }
        renderItem={({ item }) => (
          <ListItem
            title={item.name}
            description={
              [item.location, item.county].filter(Boolean).join(', ') +
              `\nHeadteacher: ${item.headteacher_name ?? 'none yet'}`
            }
            descriptionNumberOfLines={2}
            onPress={() => setView(item)}
            style={styles.row}
            right={() =>
              item.status === 'suspended' ? (
                <StatusPill label="suspended" tone="warning" style={styles.pill} />
              ) : null
            }
          />
        )}
      />
    </View>
  );
}

function SchoolDetail({
  school,
  onBack,
  onChanged,
}: {
  school: SchoolRow;
  onBack: () => void;
  onChanged: (status: SchoolRow['status']) => Promise<void>;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suspend = school.status === 'active';

  async function handleStatus() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('set_school_status', {
      p_school_id: school.school_id,
      p_status: suspend ? 'suspended' : 'active',
    });
    setBusy(false);
    setConfirming(false);
    if (error) {
      setError(error.message);
      return;
    }
    await onChanged(suspend ? 'suspended' : 'active');
  }

  const details: [string, string | null][] = [
    ['Registration number', school.registration_no],
    ['Location', school.location],
    ['County', school.county],
    ['Phone', school.phone],
    ['Email', school.email],
    ['Timezone', school.timezone],
    ['Headteacher', school.headteacher_name],
    ['Headteacher email', school.headteacher_email],
    ['Onboarded', new Date(school.created_at).toLocaleDateString()],
  ];

  return (
    <FadeInScrollView style={styles.container}>
      <ScreenHeader title={school.name} onBack={onBack} backLabel="Schools" backDisabled={busy} />
      <StatusPill
        label={school.status}
        tone={school.status === 'active' ? 'success' : 'warning'}
        style={styles.statusPill}
      />

      <Card mode="contained" style={styles.card}>
        <Card.Content>
          {details.map(([label, value]) => (
            <View key={label} style={styles.detailRow}>
              <Text variant="labelMedium" style={styles.detailLabel}>{label}</Text>
              <Text variant="bodyMedium" style={styles.detailValue}>{value || '—'}</Text>
            </View>
          ))}
        </Card.Content>
      </Card>

      <Text variant="bodySmall" style={styles.hint}>
        {suspend
          ? "Suspending blocks all of the school's staff until you restore it. Its records are kept."
          : "Restoring lets the school's staff sign in and work again."}
      </Text>
      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>
      <Button
        mode={confirming ? 'contained' : 'outlined'}
        icon={suspend ? 'pause-circle-outline' : 'play-circle-outline'}
        buttonColor={confirming && suspend ? colors.danger : undefined}
        textColor={!confirming && suspend ? colors.danger : undefined}
        onPress={handleStatus}
        loading={busy}
        disabled={busy}
        contentStyle={styles.buttonContent}
      >
        {confirming ? `Confirm: ${suspend ? 'suspend' : 'restore'} ${school.name}` : suspend ? 'Suspend school' : 'Restore school'}
      </Button>
      {confirming && (
        <Button mode="text" onPress={() => setConfirming(false)} disabled={busy} style={styles.cancel}>
          Cancel
        </Button>
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

function OnboardForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => Promise<void> }) {
  const { styles } = useThemedStyles(makeStyles);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof EMPTY_FORM) => (text: string) => setForm({ ...form, [key]: text });

  async function handleSave() {
    if (!form.name.trim()) return setError('The school name is required.');
    if (!form.head_name.trim()) return setError("The headteacher's name is required.");
    if (!form.head_email.trim()) return setError("The headteacher's email is required.");
    if (form.head_password.length < 8) return setError('The temporary password must be at least 8 characters.');
    setSaving(true);
    setError(null);
    const { error } = await invokeManageStaff({
      action: 'onboard_school',
      school: {
        name: form.name,
        registration_no: form.registration_no,
        location: form.location,
        county: form.county,
        phone: form.phone,
        email: form.email,
        timezone: form.timezone,
      },
      headteacher: { full_name: form.head_name, email: form.head_email, password: form.head_password },
    });
    setSaving(false);
    if (error) return setError(error);
    await onDone();
  }

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Onboard a school" onBack={onCancel} backLabel="Cancel" backDisabled={saving} />

      <Text variant="titleSmall" style={styles.sectionTitle}>School</Text>
      <Field label="School name *" value={form.name} onChangeText={set('name')} />
      <Field
        label="Registration number"
        value={form.registration_no}
        onChangeText={set('registration_no')}
        placeholder="Ministry of Education code"
      />
      <Field label="Location" value={form.location} onChangeText={set('location')} placeholder="e.g. Nakuru town" />
      <Field label="County" value={form.county} onChangeText={set('county')} placeholder="e.g. Nakuru" />
      <Field label="Phone" value={form.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
      <Field
        label="Email"
        value={form.email}
        onChangeText={set('email')}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <Field label="Timezone" value={form.timezone} onChangeText={set('timezone')} autoCapitalize="none" />

      <Text variant="titleSmall" style={styles.sectionTitle}>Headteacher</Text>
      <Text variant="bodySmall" style={styles.hint}>
        The headteacher runs the school's account from now on: staff, students, meals, stock and suppliers.
      </Text>
      <Field label="Full name *" value={form.head_name} onChangeText={set('head_name')} />
      <Field
        label="Email *"
        value={form.head_email}
        onChangeText={set('head_email')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="They sign in with this"
      />
      <Field
        label="Temporary password *"
        value={form.head_password}
        onChangeText={set('head_password')}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <Text variant="bodySmall" style={styles.hint}>
        Give them this password. They choose their own the first time they sign in.
      </Text>

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>
      <Button
        mode="contained"
        icon="school-outline"
        onPress={handleSave}
        loading={saving}
        disabled={saving}
        contentStyle={styles.buttonContent}
      >
        Onboard school
      </Button>
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  search: { backgroundColor: c.surface },
  list: { marginTop: 12 },
  row: { paddingLeft: 0, paddingRight: 0 },
  pill: { alignSelf: 'center' },
  statusPill: { alignSelf: 'flex-start', marginBottom: 12 },
  card: { borderRadius: 16, marginBottom: 16 },
  detailRow: { paddingVertical: 6 },
  detailLabel: { color: c.textMuted },
  detailValue: { color: c.text },
  sectionTitle: { color: c.text, marginTop: 16, marginBottom: 4 },
  hint: { color: c.textMuted, marginTop: 8 },
  buttonContent: { paddingVertical: 6 },
  cancel: { marginTop: 4 },
  bottomSpacer: { height: 40 },
});
