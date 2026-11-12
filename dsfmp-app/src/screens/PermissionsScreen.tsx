import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, RefreshControl } from 'react-native';
import { Divider, HelperText, List, Switch, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { PERMISSIONS, Permission, useSchool } from '../school/SchoolContext';
import { tapFeedback, FadeInScrollView } from '../components/Motion';
import { ScreenHeader } from '../components/ScreenParts';

// The headteacher can do everything; this is what the coordinator may do.
const role = 'coordinator';

// The headteacher decides what the coordinator may do at the school.
// The database checks these on every read and change.
export default function PermissionsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, isHeadteacher } = useSchool();
  // "role:permission" for every permission granted at this school
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('school_role_permissions')
      .select('role, permission')
      .eq('school_id', school.school_id);
    if (error) {
      setError(`Could not load permissions: ${error.message}`);
    } else {
      setError(null);
      setGranted(new Set((data ?? []).map((r) => `${r.role}:${r.permission}`)));
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(permission: Permission, on: boolean) {
    const key = `${role}:${permission}`;
    if (busy) return;
    tapFeedback();
    setBusy(key);
    setError(null);
    const { error } = on
      ? await supabase
          .from('school_role_permissions')
          .insert({ school_id: school.school_id, role, permission })
      : await supabase
          .from('school_role_permissions')
          .delete()
          .eq('school_id', school.school_id)
          .eq('role', role)
          .eq('permission', permission);
    setBusy(null);
    if (error) {
      setError(error.code === '42501' ? 'Only the headteacher can change permissions.' : error.message);
      return;
    }
    const next = new Set(granted);
    if (on) next.add(key);
    else next.delete(key);
    setGranted(next);
  }

  return (
    <FadeInScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
    >
      <ScreenHeader title="Permissions" onBack={() => navigation.goBack()} />
      <Text variant="bodySmall" style={styles.hint}>
        Choose what the coordinator may do at {school.name}. The headteacher can always do
        everything. Managing staff, choosing suppliers and confirming orders stay with the
        headteacher.
      </Text>

      {error && <HelperText type="error">{error}</HelperText>}

      <View style={styles.list}>
        {PERMISSIONS.map((p, index) => {
          const key = `${role}:${p.key}`;
          return (
            <View key={p.key}>
              {index > 0 && <Divider />}
              <List.Item
                title={p.label}
                description={p.description}
                style={styles.row}
                contentStyle={styles.rowContent}
                right={() => (
                  <Switch
                    value={granted.has(key)}
                    onValueChange={(on) => toggle(p.key, on)}
                    disabled={!isHeadteacher || loading || busy !== null}
                    style={styles.switch}
                  />
                )}
              />
            </View>
          );
        })}
      </View>
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  hint: { color: c.textMuted, marginBottom: 16 },
  list: { marginTop: 8 },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  switch: { alignSelf: 'center' },
  bottomSpacer: { height: 40 },
});
