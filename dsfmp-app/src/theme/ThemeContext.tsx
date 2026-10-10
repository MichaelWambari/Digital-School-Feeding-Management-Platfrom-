import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

const STORAGE_KEY = 'dsfmp.themePreference';

type ThemeValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  scheme: 'light' | 'dark';
  colors: Colors;
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
