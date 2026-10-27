import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Avatar, Card, Divider, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, ThemePreference, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, useSchool } from '../school/SchoolContext';
import { FadeIn } from '../components/Motion';
import { Chip, IconButton, ListItem, SegmentedButtons } from '../components/Paper';

// Icons are Material Community Icons names (https://pictogrammers.com/library/mdi/).
const MENU_ITEMS = [
  { label: 'Students', screen: 'Students', icon: 'account-school-outline', available: true },
  { label: 'Attendance', screen: 'Attendance', icon: 'clipboard-check-outline', available: true },
  { label: 'Inventory', screen: 'Inventory', icon: 'package-variant-closed', available: true },
  { label: 'Distribution', screen: 'Distribution', icon: 'truck-delivery-outline', available: true },
  { label: 'Reports', screen: 'Reports', icon: 'chart-box-outline', available: true },
];

// Only network admins manage staff logins.
const NETWORK_MENU_ITEMS = [
  { label: 'Staff', screen: 'Staff', icon: 'account-key-outline', available: true },
];

const THEME_OPTIONS = [
  { value: 'system', label: 'System', icon: 'theme-light-dark' },
  { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
  { value: 'dark', label: 'Dark', icon: 'weather-night' },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export default function DashboardScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { preference, setPreference } = useTheme();
  const { profile, isNetworkAdmin, schools, school, setSchoolId } = useSchool();
  const [beneficiaryCount, setBeneficiaryCount] = useState<number | null>(null);

  const loadStats = useCallback(async () => {
    const { count } = await supabase
      .from('beneficiaries')
      .select('*', { count: 'exact', head: true })
      .eq('school_id', school.school_id)
      .eq('status', 'active');
    setBeneficiaryCount(count ?? 0);
  }, [school.school_id]);

  useEffect(() => {
    // Reload on every focus so the count reflects changes made on other screens.
    loadStats();
    return navigation.addListener('focus', loadStats);
  }, [navigation, loadStats]);

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  const menuItems = isNetworkAdmin ? [...MENU_ITEMS, ...NETWORK_MENU_ITEMS] : MENU_ITEMS;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Avatar.Text size={44} label={initials(profile.full_name)} />
        <View style={styles.headerMain}>
          <Text variant="titleLarge" style={styles.headerTitle} numberOfLines={1}>
            {school.name}
          </Text>
          <Text variant="bodySmall" style={styles.headerMeta}>
            {profile.full_name} · {ROLE_LABELS[profile.role]}
          </Text>
        </View>
        <IconButton
          icon="logout"
          iconColor={colors.danger}
          onPress={handleLogout}
          accessibilityLabel="Logout"
        />
      </View>

      {isNetworkAdmin && schools.length > 1 && (
        <>
          <Text variant="labelLarge" style={styles.sectionLabel}>School</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chips}
            contentContainerStyle={styles.chipsContent}
          >
            {schools.map((s) => (
              <Chip
                key={s.school_id}
                mode={s.school_id === school.school_id ? 'flat' : 'outlined'}
                selected={s.school_id === school.school_id}
                showSelectedCheck={false}
                icon="school-outline"
                onPress={() => setSchoolId(s.school_id)}
              >
                {s.name}
              </Chip>
            ))}
          </ScrollView>
        </>
      )}

      <FadeIn>
        <Card mode="contained" style={styles.statCard}>
          <Card.Content style={styles.statContent}>
            <Avatar.Icon size={48} icon="account-group-outline" />
            <View style={styles.statText}>
              <Text variant="displaySmall" style={styles.statNumber}>
                {beneficiaryCount ?? '—'}
              </Text>
              <Text variant="bodyMedium" style={styles.statLabel}>Active students</Text>
            </View>
          </Card.Content>
        </Card>
      </FadeIn>

      <Card mode="outlined" style={styles.menu}>
        {menuItems.map((item, index) => (
          // Menu items fade in one after another.
          <FadeIn key={item.screen} delay={80 + index * 50}>
            {index > 0 && <Divider />}
            <ListItem
              title={item.label}
              onPress={() => item.available && navigation.navigate(item.screen)}
              disabled={!item.available}
              style={!item.available && styles.menuItemDisabled}
              left={(props) => <List.Icon {...props} icon={item.icon} color={colors.primary} />}
              right={(props) =>
                item.available ? (
                  <List.Icon {...props} icon="chevron-right" />
                ) : (
                  <Text variant="bodySmall" style={styles.comingSoon}>Coming soon</Text>
                )
              }
            />
          </FadeIn>
        ))}
      </Card>

      <Text variant="titleSmall" style={styles.sectionTitle}>Theme</Text>
      <SegmentedButtons
        value={preference}
        onValueChange={(value) => setPreference(value as ThemePreference)}
        buttons={THEME_OPTIONS}
      />
    </ScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 20, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  headerMain: { flex: 1, marginHorizontal: 12 },
  headerTitle: { fontWeight: '700', color: c.text },
  headerMeta: { color: c.textMuted, marginTop: 2 },
  sectionLabel: { color: c.textSecondary, marginBottom: 8 },
  chips: { flexGrow: 0, marginBottom: 20 },
  chipsContent: { gap: 8 },
  statCard: { borderRadius: 16, marginBottom: 20 },
  statContent: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  statText: { marginLeft: 16 },
  statNumber: { fontWeight: '700', color: c.text },
  statLabel: { color: c.textMuted },
  menu: { borderRadius: 16, overflow: 'hidden' },
  menuItemDisabled: { opacity: 0.55 },
  comingSoon: { color: c.textFaint, alignSelf: 'center' },
  sectionTitle: { color: c.text, marginTop: 28, marginBottom: 10 },
});
