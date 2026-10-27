import React from 'react';
import { GestureResponderEvent } from 'react-native';
import {
  Button as PaperButton,
  Chip as PaperChip,
  FAB as PaperFAB,
  IconButton as PaperIconButton,
  List,
  SegmentedButtons as PaperSegmentedButtons,
} from 'react-native-paper';
import { tapFeedback } from './Motion';

// Paper's pressable components with the same light phone tap as
// PressableScale. Import these instead of the react-native-paper originals.

type Pressable = { onPress?: (e: GestureResponderEvent) => void };

function withTapFeedback<P extends Pressable>(Component: React.ComponentType<P>) {
  return function TapFeedback(props: P) {
    const { onPress } = props;
    return (
      <Component
        {...props}
        onPress={
          onPress &&
          ((e: GestureResponderEvent) => {
            tapFeedback();
            onPress(e);
          })
        }
      />
    );
  };
}

export const Button = withTapFeedback<React.ComponentProps<typeof PaperButton>>(PaperButton);
export const Chip = withTapFeedback<React.ComponentProps<typeof PaperChip>>(PaperChip);
export const FAB = withTapFeedback<React.ComponentProps<typeof PaperFAB>>(PaperFAB);
export const IconButton =
  withTapFeedback<React.ComponentProps<typeof PaperIconButton>>(PaperIconButton);
export const ListItem = withTapFeedback<React.ComponentProps<typeof List.Item>>(List.Item);

export function SegmentedButtons(props: React.ComponentProps<typeof PaperSegmentedButtons>) {
  return (
    <PaperSegmentedButtons
      {...props}
      onValueChange={(value: any) => {
        tapFeedback();
        (props.onValueChange as (v: any) => void)(value);
      }}
    />
  );
}
