import { forwardRef } from 'react';
import {
  Pressable as NativePressable,
  View as NativeView,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { cardScaleForDisplay } from '@/constants/theme';
import { useSettingsStore } from '@/src/state/settings-store';
import { scaleCardStyle } from './scaling';

function scalePressableStyle(
  style: PressableProps['style'],
  scale: number,
): PressableProps['style'] {
  if (typeof style === 'function') {
    return (state: PressableStateCallbackType) => scaleCardStyle(style(state), scale);
  }
  return scaleCardStyle(style, scale);
}

export const ScaledView = forwardRef<NativeView, ViewProps>(function ScaledView(props, ref) {
  const displaySize = useSettingsStore((state) => state.displaySize);
  const style = scaleCardStyle(props.style, cardScaleForDisplay(displaySize));
  return <NativeView {...props} ref={ref} style={style} />;
});

export const ScaledPressable = forwardRef<NativeView, PressableProps>(function ScaledPressable(props, ref) {
  const displaySize = useSettingsStore((state) => state.displaySize);
  const style = scalePressableStyle(props.style, cardScaleForDisplay(displaySize));
  return <NativePressable {...props} ref={ref} style={style} />;
});

export type ScaledCardStyle = StyleProp<ViewStyle>;
