import React, { useState } from 'react';
import { View, StyleSheet, Pressable, LayoutChangeEvent } from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { NEED_GOOD_AT, NEED_LOW_AT, NEED_STATUS, needStatus } from './NutrientDonut';
import { tapFeedback } from './Motion';

export type EnergyDay = { date: string; kcal: number };

type Props = {
  days: EnergyDay[]; // oldest first
  need: number | null; // daily energy need in kcal; null: no bands
  selectedDate: string | null;
  onSelect: (date: string | null) => void;
};

const HEIGHT = 170;
const PAD = { top: 10, right: 8, bottom: 22, left: 40 };

// A tidy top for the y axis: 1, 2, 2.5 or 5 times a power of ten.
function niceMax(value: number) {
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= value) return step * pow;
  return 10 * pow;
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : String(Math.round(n)));

// Energy provided each day eaten as a line. Behind it, bands for the share of
// the daily need: low (red), moderate (yellow) and good (green), with a
// dashed line at the full need. Tap the chart to pick a day.
export function EnergyLineChart({ days, need, selectedDate, onSelect }: Props) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const yMax = niceMax(Math.max(1, ...days.map((d) => d.kcal), need ? need * 1.05 : 0));
  const y = (kcal: number) => PAD.top + plotH * (1 - Math.min(kcal, yMax) / yMax);
  const x = (i: number) => PAD.left + (days.length === 1 ? plotW / 2 : (plotW * i) / (days.length - 1));
  const selectedIndex = days.findIndex((d) => d.date === selectedDate);

  // Day-of-month labels: at most 7, always the first and last day.
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const labelled = days.map((_, i) => i === days.length - 1 || (i % labelEvery === 0 && days.length - 1 - i >= labelEvery / 2));

  const pick = (date: string) => {
    tapFeedback();
    onSelect(date === selectedDate ? null : date);
  };
  // Each day's tap zone runs halfway to its neighbours, across the full
  // height, so a point is easy to hit even when there are many of them.
  const zone = (i: number) => {
    const left = i === 0 ? 0 : (x(i - 1) + x(i)) / 2;
    const right = i === days.length - 1 ? width : (x(i) + x(i + 1)) / 2;
    return { left, width: right - left };
  };

  const pointColor = (kcal: number) =>
    need ? NEED_STATUS[needStatus((100 * kcal) / need)].color : colors.primary;

  const bands = need
    ? [
        { from: 0, to: (need * NEED_LOW_AT) / 100, color: NEED_STATUS.low.color },
        { from: (need * NEED_LOW_AT) / 100, to: (need * NEED_GOOD_AT) / 100, color: NEED_STATUS.moderate.color },
        { from: (need * NEED_GOOD_AT) / 100, to: yMax, color: NEED_STATUS.good.color },
      ]
    : [];

  return (
    <View>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        style={{ height: HEIGHT }}
      >
        {width > 0 && (
          <Svg width={width} height={HEIGHT} pointerEvents="none">
            {bands.map((b) => (
              <Rect
                key={b.color}
                x={PAD.left}
                y={y(b.to)}
                width={plotW}
                height={Math.max(0, y(b.from) - y(b.to))}
                fill={b.color}
                opacity={0.12}
              />
            ))}
            {/* recessive grid: 0, half and top */}
            {[0, yMax / 2, yMax].map((v) => (
              <React.Fragment key={v}>
                <Line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} stroke={colors.divider} strokeWidth={1} />
                <SvgText x={PAD.left - 6} y={y(v) + 3.5} fontSize={10} fill={colors.textMuted} textAnchor="end">
                  {fmtK(v)}
                </SvgText>
              </React.Fragment>
            ))}
            {need ? (
              <>
                <Line
                  x1={PAD.left}
                  x2={PAD.left + plotW}
                  y1={y(need)}
                  y2={y(need)}
                  stroke={colors.textSecondary}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                <SvgText x={PAD.left + plotW - 2} y={y(need) - 4} fontSize={10} fill={colors.textSecondary} textAnchor="end">
                  Daily need {fmtK(need)}
                </SvgText>
              </>
            ) : null}
            {selectedIndex >= 0 && (
              <Line
                x1={x(selectedIndex)}
                x2={x(selectedIndex)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke={colors.textMuted}
                strokeWidth={1}
              />
            )}
            {days.length > 1 && (
              <Polyline
                points={days.map((d, i) => `${x(i)},${y(d.kcal)}`).join(' ')}
                fill="none"
                stroke={colors.textSecondary}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {days.map((d, i) => (
              <Circle
                key={d.date}
                cx={x(i)}
                cy={y(d.kcal)}
                r={i === selectedIndex ? 6 : days.length > 40 ? 3 : 4.5}
                fill={pointColor(d.kcal)}
                stroke={colors.background}
                strokeWidth={2}
              />
            ))}
            {days.map((d, i) =>
              labelled[i] ? (
                <SvgText
                  key={d.date}
                  x={x(i)}
                  y={HEIGHT - 6}
                  fontSize={10}
                  fill={i === selectedIndex ? colors.text : colors.textFaint}
                  fontWeight={i === selectedIndex ? '700' : '400'}
                  textAnchor="middle"
                >
                  {Number(d.date.slice(8))}
                </SvgText>
              ) : null
            )}
          </Svg>
        )}
        {width > 0 &&
          days.map((d, i) => (
            <Pressable
              key={d.date}
              style={[styles.zone, zone(i)]}
              onPress={() => pick(d.date)}
              accessibilityRole="button"
              accessibilityState={{ selected: d.date === selectedDate }}
              accessibilityLabel={`${d.date}: ${Math.round(d.kcal)} kcal${
                need ? `, ${Math.round((100 * d.kcal) / need)} percent of daily need` : ''
              }`}
            />
          ))}
      </View>
      {need ? (
        <View style={styles.legend}>
          {(['low', 'moderate', 'good'] as const).map((s) => (
            <View key={s} style={styles.legendItem}>
              <MaterialCommunityIcons name={NEED_STATUS[s].icon} size={13} color={NEED_STATUS[s].color} />
              <Text variant="labelSmall" style={styles.legendText}>
                {NEED_STATUS[s].label}{' '}
                {s === 'low' ? `< ${NEED_LOW_AT}%` : s === 'moderate' ? `${NEED_LOW_AT}–${NEED_GOOD_AT - 1}%` : `${NEED_GOOD_AT}%+`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    zone: { position: 'absolute', top: 0, bottom: 0 },
    legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    legendText: { color: c.textSecondary },
  });
