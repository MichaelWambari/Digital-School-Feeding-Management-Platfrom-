import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Avatar, Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { invokeManageStaff } from '../lib/manageStaff';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, SchoolRole, useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip, ListItem, SegmentedButtons } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill, initials } from '../components/ScreenParts';

type Staff = {
  user_id: string;
  email: string;
  full_name: string;
  role: SchoolRole;
  status: 'active' | 'suspended';
  last_sign_in_at: string | null;
};

type FormState = {
  full_name: string;
  email: string;
  password: string;
  role: SchoolRole;
  status: 'active' | 'suspended';
};

// New staff are coordinators; making one headteacher hands the school over.
const ROLES: SchoolRole[] = ['coordinator', 'headteacher'];

// The headteacher's list of their school's staff logins. New logins are
// created by the manage-staff Edge Function; everything else goes through
// list_staff() and update_staff().
export default function StaffScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { profile, school } = useSchool();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // null = showing the list; 'new' = adding; otherwise the person being edited
  const [editing, setEditing] = useState<Staff | 'new' | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [settingPassword, setSettingPassword] = useState(false);

  const loadStaff = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('list_staff');
    if (error) {
      setLoadError(describeError(error));
    } else {
      setLoadError(null);
      setStaff((data ?? []) as Staff[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  function openForm(target: Staff | 'new') {
    setForm(
      target === 'new'
        ? { full_name: '', email: '', password: '', role: 'coordinator', status: 'active' }
        : {
            full_name: target.full_name,
            email: target.email,
            password: '',
            role: target.role,
            status: target.status,
          }
    );
    setFormError(null);
    setNewPassword('');
    setPasswordMessage(null);
    setEditing(target);
  }

  async function handleSave() {
    if (!form) return;
    const fullName = form.full_name.trim();
    const email = form.email.trim();

    if (!fullName) {
      setFormError('Full name is required.');
      return;
    }
    if (editing === 'new') {
      if (!email) {
        setFormError('Email is required.');
        return;
      }
      if (form.password.length < 8) {
        setFormError('The password must be at least 8 characters.');
        return;
      }
    }

    setSaving(true);
    setFormError(null);
    try {
      if (editing === 'new') {
        const { error } = await invokeManageStaff({
          action: 'create',
          email,
          password: form.password,
          full_name: fullName,
        });
        if (error) {
          setFormError(error);
          return;
        }
      } else {
        const { error } = await supabase.rpc('update_staff', {
          p_user_id: (editing as Staff).user_id,
          p_full_name: fullName,
          p_role: form.role,
          p_status: form.status,
        });
        if (error) {
          setFormError(describeError(error));
          return;
        }
      }
      setEditing(null);
      await loadStaff();
    } catch {
      setFormError('Unable to connect. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSetPassword() {
    if (newPassword.length < 8) {
      setPasswordMessage('The password must be at least 8 characters.');
      return;
    }
    setSettingPassword(true);
    setPasswordMessage(null);
    const { error } = await invokeManageStaff({
      action: 'set_password',
      user_id: (editing as Staff).user_id,
      password: newPassword,
    });
    setSettingPassword(false);
    if (error) {
      setPasswordMessage(error);
      return;
    }
    setNewPassword('');
    setPasswordMessage('Password changed. Give it to them; they choose their own when they next sign in.');
  }

  if (editing && form) {
    const isNew = editing === 'new';
    const isSelf = !isNew && (editing as Staff).user_id === profile.user_id;
    return (
      <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <ScreenHeader
          title={isNew ? 'Add a coordinator' : 'Edit staff'}
          onBack={() => setEditing(null)}
          backLabel="Cancel"
          backDisabled={saving}
        />

        <Field
          label="Full name *"
          value={form.full_name}
          onChangeText={(full_name) => setForm({ ...form, full_name })}
          placeholder="e.g. Grace Achieng"
        />

        {isNew ? (
          <Field
            label="Email *"
            value={form.email}
            onChangeText={(email) => setForm({ ...form, email })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="off"
            placeholder="They sign in with this"
          />
        ) : (
          // The sign-in email can't be changed here, so it's shown but not editable.
          <Field label="Email" value={form.email} disabled />
        )}

        {isNew && (
          <>
            <Field
              label="Temporary password *"
              value={form.password}
              onChangeText={(password) => setForm({ ...form, password })}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
            <Text variant="bodySmall" style={styles.hint}>
              They choose their own password the first time they sign in.
            </Text>
          </>
        )}

        {isNew ? (
          <Text variant="bodySmall" style={styles.hint}>
            They'll be the school's coordinator: students, attendance, the timetable and
            inventory. What they may do is set under Permissions.
          </Text>
        ) : (
          <>
            <Text variant="labelLarge" style={styles.label}>Role</Text>
            <View style={styles.chipWrap}>
              {ROLES.map((role) => (
                <Chip
                  key={role}
                  mode={form.role === role ? 'flat' : 'outlined'}
                  selected={form.role === role}
                  onPress={() => setForm({ ...form, role })}
                  disabled={isSelf}
                >
                  {ROLE_LABELS[role]}
                </Chip>
              ))}
            </View>
            <Text variant="bodySmall" style={styles.hint}>
              {isSelf
                ? "You can't change your own role or suspend yourself. To hand the school over, make someone else headteacher; they can then change your role."
                : form.role === 'headteacher'
                ? 'A headteacher has full control of the school, including staff. Use this to hand the school over.'
                : 'What a coordinator may do is set under Permissions.'}
            </Text>
          </>
        )}

        {!isNew && (
          <>
            <Text variant="labelLarge" style={styles.label}>Status</Text>
            <SegmentedButtons
              value={form.status}
              onValueChange={(status) => setForm({ ...form, status: status as FormState['status'] })}
              buttons={[
                { value: 'active', label: 'Active', icon: 'account-check-outline', disabled: isSelf },
                { value: 'suspended', label: 'Suspended', icon: 'account-cancel-outline', disabled: isSelf },
              ]}
            />
          </>
        )}

        <HelperText type="error" visible={!!formError}>
          {formError}
        </HelperText>

        <Button
          mode="contained"
          icon={isNew ? 'account-plus-outline' : undefined}
          onPress={handleSave}
          loading={saving}
          disabled={saving}
          contentStyle={styles.buttonContent}
        >
          {isNew ? 'Create login' : 'Save'}
        </Button>

        {!isNew && !isSelf && (
          <>
            <Text variant="titleSmall" style={styles.sectionTitle}>Reset password</Text>
            <Field
              label="Temporary password"
              style={styles.firstField}
              value={newPassword}
              onChangeText={setNewPassword}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
            <HelperText type="info" visible={!!passwordMessage}>
              {passwordMessage}
            </HelperText>
            <Button
              mode="outlined"
              icon="lock-reset"
              onPress={handleSetPassword}
              loading={settingPassword}
              disabled={settingPassword}
              contentStyle={styles.buttonContent}
              style={styles.secondaryButton}
            >
              Set password
            </Button>
          </>
        )}
      </FadeInScrollView>
    );
  }

  const term = search.trim().toLowerCase();
  const sorted = [...staff].sort(
    (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.full_name.localeCompare(b.full_name)
  );
  const filtered = term
    ? sorted.filter(
        (s) =>
          s.full_name.toLowerCase().includes(term) ||
          s.email.toLowerCase().includes(term) ||
          ROLE_LABELS[s.role].toLowerCase().includes(term)
      )
    : sorted;

  return (
    <View style={styles.container}>
      <ScreenHeader
        title="Staff"
        onBack={() => navigation.goBack()}
        right={
          <Button mode="text" icon="plus" onPress={() => openForm('new')}>
            Add
          </Button>
        }
      />
      <Text variant="bodySmall" style={styles.schoolName}>{school.name}</Text>

      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, email or role"
        autoCapitalize="none"
        elevation={0}
        style={styles.search}
      />

      {loadError && <HelperText type="error">Could not load staff: {loadError}</HelperText>}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(s) => s.user_id}
        ItemSeparatorComponent={Divider}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadStaff} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>{term ? 'No staff match your search.' : 'No staff yet.'}</EmptyText>
          )
        }
        renderItem={({ item }) => (
          <ListItem
            title={item.full_name + (item.user_id === profile.user_id ? ' (you)' : '')}
            description={
              ROLE_LABELS[item.role] +
              `\n${item.email} · ` +
              (item.last_sign_in_at
                ? `Last signed in ${new Date(item.last_sign_in_at).toLocaleDateString()}`
                : 'Never signed in')
            }
            descriptionNumberOfLines={3}
            onPress={() => openForm(item)}
            style={styles.row}
            left={() => (
              <Avatar.Text
                size={40}
                label={initials(item.full_name)}
                style={[styles.avatar, item.status === 'suspended' && styles.avatarSuspended]}
              />
            )}
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

function describeError(error: { code?: string; message: string }) {
  if (error.code === '42501') return 'Only the headteacher can manage staff.';
  if (error.code === 'PGRST202') {
    return 'The staff functions are out of date. Run supabase/fixes/009_independent_schools.sql.';
  }
  return error.message;
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  schoolName: { color: c.textMuted, marginTop: -8, marginBottom: 12 },
  label: { color: c.textSecondary, marginBottom: 8, marginTop: 16 },
  hint: { color: c.textMuted, marginTop: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  buttonContent: { paddingVertical: 6 },
  sectionTitle: { color: c.text, marginTop: 32, marginBottom: 4 },
  firstField: { marginTop: 4 },
  secondaryButton: { marginBottom: 40 },
  search: { backgroundColor: c.surface },
  list: { marginTop: 12 },
  row: { paddingLeft: 0, paddingRight: 0 },
  avatar: { alignSelf: 'center' },
  avatarSuspended: { opacity: 0.5 },
  pill: { alignSelf: 'center' },
});
