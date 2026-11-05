import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar, Surface, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, ThemePreference, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { FadeIn, PressableScale } from './Motion';
import { IconButton, SegmentedButtons } from './Paper';
import { initials } from './ScreenParts';

// Building blocks shared by the school and platform dashboards.

export type MenuItem = { label: string; screen: string; icon: string; available: boolean };

export function DashboardHeader({ title, name, subtitle }: { title: string; name: string; subtitle: string }) {
  const { colors, styles } = useThemedStyles(makeStyles);
  return (
    <View style={styles.header}>
      <Avatar.Text size={44} label={initials(name)} />
      <View style={styles.headerMain}>
        <Text variant="titleLarge" style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text variant="bodySmall" style={styles.headerMeta}>{subtitle}</Text>
      </View>
      <IconButton
        icon="logout"
        iconColor={colors.danger}
        onPress={() => supabase.auth.signOut()}
        accessibilityLabel="Logout"
      />
    </View>
  );
}

// Icons are Material Community Icons names (https://pictogrammers.com/library/mdi/).
export function MenuGrid({ items, onOpen }: { items: MenuItem[]; onOpen: (screen: string) => void }) {
  const { styles } = useThemedStyles(makeStyles);
  const { paperTheme } = useTheme();
  return (
    <View style={styles.grid}>
      {items.map((item, index) => (
        // Tiles fade in one after another.
        <FadeIn key={item.screen} delay={80 + index * 50} style={styles.gridCell}>
          <PressableScale
            onPress={() => item.available && onOpen(item.screen)}
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
  );
}

const THEME_OPTIONS = [
  { value: 'system', label: 'System', icon: 'theme-light-dark' },
  { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
  { value: 'dark', label: 'Dark', icon: 'weather-night' },
];

export function ThemeSection() {
  const { styles } = useThemedStyles(makeStyles);
  const { preference, setPreference } = useTheme();
  return (
    <>
      <Text variant="titleSmall" style={styles.sectionTitle}>Theme</Text>
      <SegmentedButtons
        value={preference}
        onValueChange={(value) => setPreference(value as ThemePreference)}
        buttons={THEME_OPTIONS}
      />
    </>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  headerMain: { flex: 1, marginHorizontal: 12 },
  headerTitle: { fontWeight: '700', color: c.text },
  headerMeta: { color: c.textMuted, marginTop: 2 },
  // Three tiles per row; the negative margin cancels the cells' outer padding.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
  gridCell: { width: '33.333%', padding: 6 },
  tile: { borderRadius: 16, paddingVertical: 18, paddingHorizontal: 8, alignItems: 'center' },
  tileDisabled: { opacity: 0.55 },
  tileLabel: { color: c.text, marginTop: 10, textAlign: 'center' },
  comingSoon: { color: c.textFaint, marginTop: 2 },
  sectionTitle: { color: c.text, marginTop: 28, marginBottom: 10 },
});
