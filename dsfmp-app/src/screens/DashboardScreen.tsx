import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Avatar, Card, Surface, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, ThemePreference, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { ROLE_LABELS, useSchool } from '../school/SchoolContext';
import { FadeIn, PressableScale } from '../components/Motion';
import { Chip, IconButton, SegmentedButtons } from '../components/Paper';
import { initials } from '../components/ScreenParts';

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

export default function DashboardScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { preference, setPreference, paperTheme } = useTheme();
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

      <View style={styles.grid}>
        {menuItems.map((item, index) => (
          // Tiles fade in one after another.
          <FadeIn key={item.screen} delay={80 + index * 50} style={styles.gridCell}>
            <PressableScale
              onPress={() => item.available && navigation.navigate(item.screen)}
              disabled={!item.available}
              accessibilityRole="button"
              accessibilityLabel={item.available ? item.label : `${item.label}, coming soon`}
              accessibilityState={{ disabled: !item.available }}
            >
              <Surface style={[styles.tile, !item.available && styles.tileDisabled]} elevation={1}>
                <Avatar.Icon
                  size={52}
                  icon={item.icon}
                  color={paperTheme.colors.onPrimaryContainer}
                  style={{ backgroundColor: paperTheme.colors.primaryContainer }}
                />
                <Text variant="labelLarge" style={styles.tileLabel} numberOfLines={1}>
                  {item.label}
                </Text>
                {!item.available && (
                  <Text variant="labelSmall" style={styles.comingSoon}>Coming soon</Text>
                )}
              </Surface>
            </PressableScale>
          </FadeIn>
        ))}
      </View>

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
  // Three tiles per row; the negative margin cancels the cells' outer padding.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
  gridCell: { width: '33.333%', padding: 6 },
  tile: { borderRadius: 16, paddingVertical: 18, paddingHorizontal: 8, alignItems: 'center' },
  tileDisabled: { opacity: 0.55 },
  tileLabel: { color: c.text, marginTop: 10, textAlign: 'center' },
  comingSoon: { color: c.textFaint, marginTop: 2 },
  sectionTitle: { color: c.text, marginTop: 28, marginBottom: 10 },
});
