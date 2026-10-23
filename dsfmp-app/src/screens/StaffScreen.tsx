import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, Role, useSchool } from '../school/SchoolContext';
import { FadeInScrollView, PressableScale } from '../components/Motion';

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
        <View style={styles.header}>
          <PressableScale onPress={() => setEditing(null)} disabled={saving}>
            <Text style={styles.back}>‹ Cancel</Text>
          </PressableScale>
          <Text style={styles.headerTitle}>{isNew ? 'Add staff' : 'Edit staff'}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <Text style={styles.label}>Full name *</Text>
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.placeholder}
          value={form.full_name}
          onChangeText={(full_name) => setForm({ ...form, full_name })}
          placeholder="e.g. Grace Achieng"
        />

        <Text style={styles.label}>Email {isNew ? '*' : ''}</Text>
        {isNew ? (
          <TextInput
            style={styles.input}
            placeholderTextColor={colors.placeholder}
            value={form.email}
            onChangeText={(email) => setForm({ ...form, email })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="off"
            placeholder="They sign in with this"
          />
        ) : (
          <Text style={styles.readOnly}>{form.email}</Text>
        )}

        {isNew && (
          <>
            <Text style={styles.label}>Password *</Text>
            <TextInput
              style={styles.input}
              placeholderTextColor={colors.placeholder}
              value={form.password}
              onChangeText={(password) => setForm({ ...form, password })}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </>
        )}

        <Text style={styles.label}>Role</Text>
        <View style={styles.chipWrap}>
          {ROLES.map((role) => (
            <PressableScale
              key={role}
              style={[styles.chip, form.role === role && styles.chipActive, isSelf && styles.chipDisabled]}
              onPress={() => setForm({ ...form, role })}
              disabled={isSelf}
              accessibilityState={{ selected: form.role === role, disabled: isSelf }}
            >
              <Text style={[styles.chipText, form.role === role && styles.chipTextActive]}>
                {ROLE_LABELS[role]}
              </Text>
            </PressableScale>
          ))}
        </View>
        {isSelf && (
          <Text style={styles.hint}>You can't change your own role or suspend yourself.</Text>
        )}

        {form.role !== 'network_admin' && (
          <>
            <Text style={styles.label}>School</Text>
            <View style={styles.chipWrap}>
              {schools.map((s) => (
                <PressableScale
                  key={s.school_id}
                  style={[styles.chip, form.school_id === s.school_id && styles.chipActive]}
                  onPress={() => setForm({ ...form, school_id: s.school_id })}
                  accessibilityState={{ selected: form.school_id === s.school_id }}
                >
                  <Text
                    style={[styles.chipText, form.school_id === s.school_id && styles.chipTextActive]}
                  >
                    {s.name}
                  </Text>
                </PressableScale>
              ))}
            </View>
          </>
        )}

        {!isNew && (
          <>
            <Text style={styles.label}>Status</Text>
            <View style={[styles.segment, isSelf && styles.chipDisabled]}>
              {(['active', 'suspended'] as const).map((status) => (
                <PressableScale
                  key={status}
                  style={[styles.segmentItem, form.status === status && styles.segmentItemActive]}
                  onPress={() => setForm({ ...form, status })}
                  disabled={isSelf}
                  accessibilityState={{ selected: form.status === status, disabled: isSelf }}
                >
                  <Text
                    style={[styles.segmentText, form.status === status && styles.segmentTextActive]}
                  >
                    {status === 'active' ? 'Active' : 'Suspended'}
                  </Text>
                </PressableScale>
              ))}
            </View>
          </>
        )}

        {formError && <Text style={styles.error}>{formError}</Text>}

        <PressableScale style={styles.button} onPress={handleSave} disabled={saving}>
          {saving ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.buttonText}>{isNew ? 'Create login' : 'Save'}</Text>
          )}
        </PressableScale>

        {!isNew && (
          <>
            <Text style={styles.sectionTitle}>Reset password</Text>
            <TextInput
              style={styles.input}
              placeholderTextColor={colors.placeholder}
              value={newPassword}
              onChangeText={setNewPassword}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="New password, at least 8 characters"
              autoComplete="new-password"
            />
            {passwordMessage && <Text style={styles.hint}>{passwordMessage}</Text>}
            <PressableScale
              style={styles.secondaryButton}
              onPress={handleSetPassword}
              disabled={settingPassword}
            >
              {settingPassword ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <Text style={styles.secondaryButtonText}>Set password</Text>
              )}
            </PressableScale>
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
      <View style={styles.header}>
        <PressableScale onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹ Back</Text>
        </PressableScale>
        <Text style={styles.headerTitle}>Staff</Text>
        <PressableScale onPress={() => openForm('new')}>
          <Text style={styles.add}>+ Add</Text>
        </PressableScale>
      </View>

      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, email or school"
        autoCapitalize="none"
      />

      {loadError && <Text style={styles.error}>Could not load staff: {loadError}</Text>}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(s) => s.user_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadStaff} />}
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.empty}>
              {term ? 'No staff match your search.' : 'No staff yet.'}
            </Text>
          )
        }
        renderItem={({ item }) => (
          <PressableScale style={styles.row} onPress={() => openForm(item)}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>
                {item.full_name}
                {item.user_id === profile.user_id ? ' (you)' : ''}
              </Text>
              <Text style={styles.rowMeta}>
                {ROLE_LABELS[item.role]}
                {item.role === 'network_admin' ? '' : ` · ${schoolName(item.school_id)}`}
              </Text>
              <Text style={styles.rowMeta}>
                {item.email} ·{' '}
                {item.last_sign_in_at
                  ? `Last signed in ${new Date(item.last_sign_in_at).toLocaleDateString()}`
                  : 'Never signed in'}
              </Text>
            </View>
            {item.status === 'suspended' && <Text style={styles.badge}>suspended</Text>}
          </PressableScale>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: c.text },
  headerSpacer: { width: 60 },
  back: { color: c.primary, fontSize: 15 },
  add: { color: c.primary, fontSize: 15, fontWeight: '600' },
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
  readOnly: { fontSize: 15, color: c.text, paddingVertical: 4 },
  hint: { fontSize: 13, color: c.textMuted, marginTop: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: c.primary, borderColor: c.primary },
  chipDisabled: { opacity: 0.55 },
  chipText: { fontSize: 14, color: c.text },
  chipTextActive: { color: c.onPrimary, fontWeight: '600' },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: c.border, borderRadius: 8 },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: c.primary, borderRadius: 7 },
  segmentText: { fontSize: 14, color: c.textSecondary },
  segmentTextActive: { color: c.onPrimary, fontWeight: '600' },
  error: { color: c.danger, fontSize: 13, marginTop: 12 },
  button: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 14,
    marginTop: 28,
    alignItems: 'center',
  },
  buttonText: { color: c.onPrimary, fontSize: 16, fontWeight: '600' },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: c.text, marginTop: 32, marginBottom: 10 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: c.primary,
    borderRadius: 8,
    paddingVertical: 12,
    marginTop: 12,
    marginBottom: 40,
    alignItems: 'center',
  },
  secondaryButtonText: { color: c.primary, fontSize: 15, fontWeight: '600' },
  list: { marginTop: 12 },
  empty: { textAlign: 'center', color: c.textMuted, marginTop: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 16, color: c.text },
  rowMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  badge: {
    fontSize: 12,
    color: c.warningText,
    backgroundColor: c.warningBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },
});
