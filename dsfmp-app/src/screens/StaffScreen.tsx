import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Avatar, Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, Role, useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip, ListItem, SegmentedButtons } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill, initials } from '../components/ScreenParts';

type Staff = {
  user_id: string;
  email: string;
  full_name: string;
  role: Role;
  school_id: string | null;
  status: 'active' | 'suspended';
  last_sign_in_at: string | null;
};

type FormState = {
  full_name: string;
  email: string;
  password: string;
  role: Role;
  school_id: string | null;
  status: 'active' | 'suspended';
};

const ROLES: Role[] = ['admin', 'coordinator', 'inventory_officer', 'network_admin'];

// The network admin's list of staff logins. New logins are created by the
// manage-staff Edge Function; everything else goes through list_staff() and
// update_staff().
export default function StaffScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { profile, schools, school } = useSchool();
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

  const schoolName = (schoolId: string | null) =>
    schools.find((s) => s.school_id === schoolId)?.name ?? 'No school';

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
        ? {
            full_name: '',
            email: '',
            password: '',
            role: 'admin',
            school_id: school.school_id,
            status: 'active',
          }
        : {
            full_name: target.full_name,
            email: target.email,
            password: '',
            role: target.role,
            school_id: target.school_id,
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
    const schoolId = form.role === 'network_admin' ? null : form.school_id;

    if (!fullName) {
      setFormError('Full name is required.');
      return;
    }
    if (form.role !== 'network_admin' && !schoolId) {
      setFormError('Choose a school.');
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
        const { error } = await supabase.functions.invoke('manage-staff', {
          body: {
            action: 'create',
            email,
            password: form.password,
            full_name: fullName,
            role: form.role,
            school_id: schoolId,
          },
        });
        if (error) {
          setFormError(await describeFunctionError(error));
          return;
        }
      } else {
        const { error } = await supabase.rpc('update_staff', {
          p_user_id: (editing as Staff).user_id,
          p_full_name: fullName,
          p_role: form.role,
          p_school_id: schoolId,
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
    try {
      const { error } = await supabase.functions.invoke('manage-staff', {
        body: { action: 'set_password', user_id: (editing as Staff).user_id, password: newPassword },
      });
      if (error) {
        setPasswordMessage(await describeFunctionError(error));
        return;
      }
      setNewPassword('');
      setPasswordMessage('Password changed. Give it to them; they can sign in with it now.');
    } catch {
      setPasswordMessage('Unable to connect. Check your connection and try again.');
    } finally {
      setSettingPassword(false);
    }
  }

  if (editing && form) {
    const isNew = editing === 'new';
    const isSelf = !isNew && (editing as Staff).user_id === profile.user_id;
    return (
      <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <ScreenHeader
          title={isNew ? 'Add staff' : 'Edit staff'}
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
          <Field
            label="Password *"
            value={form.password}
            onChangeText={(password) => setForm({ ...form, password })}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="At least 8 characters"
            autoComplete="new-password"
          />
        )}

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
        {isSelf && (
          <Text variant="bodySmall" style={styles.hint}>
            You can't change your own role or suspend yourself.
          </Text>
        )}

        {form.role !== 'network_admin' && (
          <>
            <Text variant="labelLarge" style={styles.label}>School</Text>
            <View style={styles.chipWrap}>
              {schools.map((s) => (
                <Chip
                  key={s.school_id}
                  mode={form.school_id === s.school_id ? 'flat' : 'outlined'}
                  selected={form.school_id === s.school_id}
                  icon="school-outline"
                  showSelectedCheck={false}
                  onPress={() => setForm({ ...form, school_id: s.school_id })}
                >
                  {s.name}
                </Chip>
              ))}
            </View>
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

        {!isNew && (
          <>
            <Text variant="titleSmall" style={styles.sectionTitle}>Reset password</Text>
            <Field
              label="New password"
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
    (a, b) =>
      (a.role === 'network_admin' ? '' : schoolName(a.school_id)).localeCompare(
        b.role === 'network_admin' ? '' : schoolName(b.school_id)
      ) || a.full_name.localeCompare(b.full_name)
  );
  const filtered = term
    ? sorted.filter(
        (s) =>
          s.full_name.toLowerCase().includes(term) ||
          s.email.toLowerCase().includes(term) ||
          schoolName(s.school_id).toLowerCase().includes(term)
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

      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, email or school"
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
              (item.role === 'network_admin' ? '' : ` · ${schoolName(item.school_id)}`) +
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
  if (error.code === '42501') return 'Only network admins can manage staff.';
  if (error.code === 'PGRST202') {
    return 'The staff functions are missing. Run supabase/fixes/005_staff_management.sql.';
  }
  return error.message;
}

// Turns a manage-staff failure into a message, including the common
// set-up problems (function not deployed, gateway rejecting the login).
async function describeFunctionError(error: unknown) {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    if (response.status === 404) {
      return 'The manage-staff function is not deployed yet. See "Staff accounts" in the README.';
    }
    const body = await response.json().catch(() => null);
    if (body?.error) return String(body.error);
    if (response.status === 401) {
      return 'Supabase rejected your login for manage-staff. Turn off "Verify JWT" for the function (it checks the login itself), or sign out and in again.';
    }
    return body?.message ?? error.message;
  }
  if (error instanceof FunctionsFetchError) {
    return 'Could not reach the manage-staff function. Check your connection and that the function is deployed.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
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
