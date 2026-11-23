import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle, Pressable } from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Circle } from 'react-native-svg';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { tapFeedback } from './Motion';

// Share of a daily need met, as a green / yellow / red status. The colours
// are a fixed status palette (the same in light and dark), and each status
// also has an icon and a word so it never relies on colour alone.
export const NEED_GOOD_AT = 70; // % of daily need and above: green
export const NEED_LOW_AT = 30; // below this: red; in between: yellow

export const NEED_STATUS = {
  good: { color: '#0ca30c', icon: 'check-circle', label: 'Good' },
  moderate: { color: '#fab219', icon: 'alert-circle', label: 'Moderate' },
  low: { color: '#d03b3b', icon: 'close-circle', label: 'Low' },
} as const;
export type NeedStatus = keyof typeof NEED_STATUS;

export function needStatus(percent: number, goodAt = NEED_GOOD_AT, lowAt = NEED_LOW_AT): NeedStatus {
  if (percent >= goodAt) return 'good';
  if (percent >= lowAt) return 'moderate';
  return 'low';
}

// "275%", or "12×" once the share no longer fits in the ring.
export function formatPercent(percent: number) {
  return percent >= 1000 ? `${Math.round(percent / 100)}×` : `${Math.round(percent)}%`;
}

type Props = {
  label: string;
  percent: number | null; // null: can't be worked out (shown grey)
  detail?: string; // e.g. "8.7 of 65 mg"
  size?: number;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  // Cut-offs for green and red when they aren't the daily-need ones,
  // and the word for 100% or more (default "Need met").
  goodAt?: number;
  lowAt?: number;
  fullLabel?: string;
  // What the percentage is of, read out by screen readers.
  percentOf?: string;
};

// A ring filled to the share of the daily need met. It is full at 100%:
// the number in the middle shows the real value, which can be over 100%
// when the meals provide more than the student needs in a day.
export function NutrientDonut({
  label,
  percent,
  detail,
  size = 84,
  selected,
  onPress,
  style,
  goodAt,
  lowAt,
  fullLabel = 'Need met',
  percentOf = 'of daily need',
}: Props) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const stroke = 9;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const status = percent === null ? null : NEED_STATUS[needStatus(percent, goodAt, lowAt)];
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;
  const statusLabel = percent !== null && percent >= 100 ? fullLabel : status?.label;

  return (
    <Pressable
      style={({ pressed }) => [styles.wrap, selected && styles.selected, pressed && styles.pressed, style]}
      onPress={
        onPress &&
        (() => {
          tapFeedback();
          onPress();
        })
      }
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={onPress ? { selected: !!selected } : undefined}
      accessibilityLabel={
        percent === null
          ? `${label}: not worked out`
          : `${label}: ${Math.round(percent)} percent ${percentOf}, ${statusLabel}`
      }
      accessibilityHint={onPress ? 'Shows the details' : undefined}
    >
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          {/* track */}
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.surface} strokeWidth={stroke} fill="none" />
          {filled > 0 && (
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke={status!.color}
              strokeWidth={stroke}
              fill="none"
              strokeLinecap={filled < 1 ? 'round' : 'butt'}
              strokeDasharray={`${circumference * filled} ${circumference}`}
              // start at 12 o'clock and go clockwise
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </Svg>
        <View style={styles.center} pointerEvents="none">
          <Text variant="titleMedium" style={styles.value}>
            {percent === null ? '—' : formatPercent(percent)}
          </Text>
        </View>
      </View>
      <Text variant="labelMedium" style={styles.label} numberOfLines={1}>{label}</Text>
      {status ? (
        <View style={styles.statusRow}>
          <MaterialCommunityIcons name={status.icon} size={13} color={status.color} />
          <Text variant="labelSmall" style={styles.statusText}>{statusLabel}</Text>
        </View>
      ) : (
        <Text variant="labelSmall" style={styles.statusText}>Not known</Text>
      )}
      {detail ? (
        <Text variant="labelSmall" style={styles.detail} numberOfLines={1}>{detail}</Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    wrap: {
      alignItems: 'center',
      paddingVertical: 8,
      borderRadius: 14,
      borderWidth: 1.5,
      borderColor: 'transparent',
    },
    // border only: a surface background would hide the ring's track
    selected: { borderColor: c.primary },
    pressed: { opacity: 0.7 },
    center: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
    value: { color: c.text, fontWeight: '700' },
    label: { color: c.text, marginTop: 6 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
    statusText: { color: c.textSecondary },
    detail: { color: c.textMuted, marginTop: 1 },
  });
