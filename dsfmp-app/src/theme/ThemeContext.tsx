import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MD3DarkTheme, MD3LightTheme, MD3Theme } from 'react-native-paper';

export type ThemePreference = 'system' | 'light' | 'dark';

const lightColors = {
  background: '#fff',
  surface: '#f3f4f6',
  text: '#111827',
  textSecondary: '#444',
  textMuted: '#666',
  textFaint: '#999',
  placeholder: '#c0c5cc',
  border: '#ccc',
  divider: '#eee',
  primary: '#2563eb',
  onPrimary: '#fff',
  danger: '#dc2626',
  successBg: '#dcfce7',
  successText: '#166534',
  warning: '#d97706',
  warningBg: '#fef3c7',
  warningText: '#92400e',
};

export type Colors = typeof lightColors;

const darkColors: Colors = {
  background: '#0f1115',
  surface: '#1c1f26',
  text: '#f3f4f6',
  textSecondary: '#d1d5db',
  textMuted: '#9ca3af',
  textFaint: '#6b7280',
  placeholder: '#4f5561',
  border: '#3a3f4a',
  divider: '#262a33',
  primary: '#3b82f6',
  onPrimary: '#fff',
  danger: '#f87171',
  successBg: '#14532d',
  successText: '#86efac',
  warning: '#d97706',
  warningBg: '#422006',
  warningText: '#fcd34d',
};

// Paper's Material 3 theme with the app palette swapped in, so Paper
// components match the hand-styled screens in both light and dark.
function makePaperTheme(scheme: 'light' | 'dark', c: Colors): MD3Theme {
  const dark = scheme === 'dark';
  const base = dark ? MD3DarkTheme : MD3LightTheme;
  return {
    ...base,
    roundness: 3,
    colors: {
      ...base.colors,
      primary: c.primary,
      onPrimary: c.onPrimary,
      primaryContainer: dark ? '#1e3a8a' : '#dbeafe',
      onPrimaryContainer: dark ? '#dbeafe' : '#1e3a8a',
      secondaryContainer: dark ? '#1e3a8a' : '#dbeafe',
      onSecondaryContainer: dark ? '#dbeafe' : '#1e3a8a',
      background: c.background,
      surface: c.background,
      onSurface: c.text,
      surfaceVariant: c.surface,
      onSurfaceVariant: c.textMuted,
      outline: c.border,
      outlineVariant: c.divider,
      error: c.danger,
      // Neutral greys instead of Material's default purple tint.
      elevation: {
        level0: 'transparent',
        level1: dark ? '#16191f' : '#f9fafb',
        level2: dark ? '#1c1f26' : '#f3f4f6',
        level3: dark ? '#22262e' : '#eef0f3',
        level4: dark ? '#252932' : '#ebedf0',
        level5: dark ? '#292e38' : '#e7e9ed',
      },
    },
  };
}

const lightPaperTheme = makePaperTheme('light', lightColors);
const darkPaperTheme = makePaperTheme('dark', darkColors);

const STORAGE_KEY = 'dsfmp.themePreference';

type ThemeValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  scheme: 'light' | 'dark';
  colors: Colors;
  paperTheme: MD3Theme;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setPreferenceState(saved);
        }
      })
      .catch(() => {}); // storage unavailable: stay on the system theme
  }, []);

  const value = useMemo<ThemeValue>(() => {
    const scheme =
      preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;
    return {
      preference,
      setPreference: (next) => {
        setPreferenceState(next);
        AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      },
      scheme,
      colors: scheme === 'dark' ? darkColors : lightColors,
      paperTheme: scheme === 'dark' ? darkPaperTheme : lightPaperTheme,
    };
  }, [preference, systemScheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside ThemeProvider');
  return theme;
}

// Builds a screen's StyleSheet from the current palette, rebuilding only when the theme changes.
export function useThemedStyles<T>(makeStyles: (colors: Colors) => T) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [makeStyles, colors]);
  return { colors, styles };
}
