import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  GestureResponderEvent,
  Platform,
  Pressable,
  PressableProps,
  ScrollViewProps,
  StyleProp,
  ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';

// The native driver isn't available on web; Animated falls back to JS there.
const useNativeDriver = Platform.OS !== 'web';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressableScaleProps = Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle> };

// Drop-in replacement for TouchableOpacity: it shrinks slightly while
// pressed, springs back on release, and gives a light tap on phones.
export function PressableScale({ style, onPressIn, onPressOut, onPress, ...rest }: PressableScaleProps) {
  const scale = useRef(new Animated.Value(1)).current;

  function springTo(toValue: number) {
    Animated.spring(scale, {
      toValue,
      useNativeDriver,
      speed: 40,
      bounciness: toValue === 1 ? 12 : 0,
    }).start();
  }

  return (
    <AnimatedPressable
      {...rest}
      style={[style, { transform: [{ scale }] }]}
      onPressIn={(e: GestureResponderEvent) => {
        springTo(0.95);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        springTo(1);
        onPressOut?.(e);
      }}
      onPress={(e: GestureResponderEvent) => {
        if (Platform.OS !== 'web') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
        onPress?.(e);
      }}
    />
  );
}

// Style that fades and slides a view up into place when it first appears.
function useAppear(delay: number) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 280,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver,
    }).start();
  }, [progress, delay]);

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  return { opacity: progress, transform: [{ translateY }] };
}

type FadeInProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  // Milliseconds to wait before starting, to stagger a list of items.
  delay?: number;
};

export function FadeIn({ children, style, delay = 0 }: FadeInProps) {
  const appear = useAppear(delay);
  return <Animated.View style={[style, appear]}>{children}</Animated.View>;
}

// A ScrollView that fades in when it appears: for forms, detail views and
// tabs that open inside a screen rather than as a new screen.
export function FadeInScrollView({ style, ...rest }: ScrollViewProps) {
  const appear = useAppear(0);
  return <Animated.ScrollView {...rest} style={[style, appear]} />;
}
