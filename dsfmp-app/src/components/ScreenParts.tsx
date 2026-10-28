import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Card, Divider, List, Text, TextInput, TextInputProps } from 'react-native-paper';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { IconButton } from './Paper';

// Building blocks shared by the inner screens, so they all look alike.

type ScreenHeaderProps = {
  title?: string;
  onBack: () => void;
  // Read out by screen readers for the back arrow, e.g. "Back to Inventory".
  backLabel?: string;
  backDisabled?: boolean;
  // Shown on the right, usually a text Button such as "Add".
  right?: React.ReactNode;
};

export function ScreenHeader({ title, onBack, backLabel = 'Back', backDisabled, right }: ScreenHeaderProps) {
  const { styles } = useThemedStyles(makeStyles);
  return (
    <View style={styles.header}>
      <IconButton
        icon="arrow-left"
        onPress={onBack}
        disabled={backDisabled}
        accessibilityLabel={backLabel}
        style={styles.backButton}
      />
      <Text variant="titleLarge" style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      {right}
    </View>
  );
}

type StatCardProps = {
  value: React.ReactNode;
  label: React.ReactNode;
  // Warning turns the card amber, e.g. for low stock.
  tone?: 'default' | 'warning';
  style?: StyleProp<ViewStyle>;
};

export function StatCard({ value, label, tone = 'default', style }: StatCardProps) {
  const { styles } = useThemedStyles(makeStyles);
  return (
    <Card mode="contained" style={[styles.statCard, tone === 'warning' && styles.statCardWarning, style]}>
      <Card.Content>
        <Text variant="headlineMedium" style={styles.statValue}>{value}</Text>
        <Text variant="bodySmall" style={styles.statLabel}>{label}</Text>
      </Card.Content>
    </Card>
  );
}

export type PillTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

// A small coloured label for a row's status.
export function StatusPill({ label, tone, style }: { label: string; tone: PillTone; style?: StyleProp<ViewStyle> }) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const palette: Record<PillTone, { bg: string; fg: string }> = {
    success: { bg: colors.successBg, fg: colors.successText },
    warning: { bg: colors.warningBg, fg: colors.warningText },
    danger: { bg: colors.surface, fg: colors.danger },
    info: { bg: colors.surface, fg: colors.primary },
    muted: { bg: colors.surface, fg: colors.textMuted },
  };
  return (
    <View style={[styles.pill, { backgroundColor: palette[tone].bg }, style]}>
      <Text variant="labelSmall" style={{ color: palette[tone].fg }}>{label}</Text>
    </View>
  );
}

// An outlined Paper text field with the standard gap above it.
export function Field({ style, ...rest }: Omit<TextInputProps, 'mode'>) {
  const { styles } = useThemedStyles(makeStyles);
  return <TextInput mode="outlined" {...rest} style={[styles.field, style]} />;
}

type MovementRowProps = {
  title: string;
  date: string;
  // Formatted quantity with its unit, without a sign.
  amount: string;
  direction: 'in' | 'out';
  // The first row has no divider above it.
  first?: boolean;
};

// One line of a stock history: green and "+" for stock in, red and "−" for stock out.
export function MovementRow({ title, date, amount, direction, first }: MovementRowProps) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const isIn = direction === 'in';
  const color = isIn ? colors.successText : colors.danger;
  return (
    <View>
      {!first && <Divider />}
      <List.Item
        title={title}
        description={date}
        style={styles.movementRow}
        left={(props) => (
          <List.Icon
            {...props}
            icon={isIn ? 'arrow-down-bold-circle-outline' : 'arrow-up-bold-circle-outline'}
            color={color}
          />
        )}
        right={() => (
          <Text variant="titleSmall" style={[styles.movementAmount, { color }]}>
            {isIn ? '+' : '−'}
            {amount}
          </Text>
        )}
      />
    </View>
  );
}

// "Grace Achieng" -> "GA", for avatar badges.
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

// Centred grey text for an empty list.
export function EmptyText({ children }: { children: React.ReactNode }) {
  const { styles } = useThemedStyles(makeStyles);
  return <Text variant="bodyMedium" style={styles.empty}>{children}</Text>;
}

const makeStyles = (c: Colors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, minHeight: 48 },
  // Lines the arrow up with the screen's left padding.
  backButton: { marginLeft: -8, marginRight: 4 },
  headerTitle: { flex: 1, fontWeight: '700', color: c.text },
  statCard: { borderRadius: 16, marginBottom: 12 },
  statCardWarning: { backgroundColor: c.warningBg },
  statValue: { fontWeight: '700', color: c.text },
  statLabel: { color: c.textMuted, marginTop: 2 },
  pill: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  field: { marginTop: 12 },
  movementRow: { paddingRight: 0 },
  movementAmount: { alignSelf: 'center', fontWeight: '600' },
  empty: { textAlign: 'center', color: c.textMuted, marginTop: 32 },
});
