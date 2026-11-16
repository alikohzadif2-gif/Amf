import { forwardRef } from 'react';
import {
  Text as NativeText,
  TextInput as NativeTextInput,
  type TextInputProps,
  type TextProps,
} from 'react-native';
import { textScaleForDisplay } from '@/constants/theme';
import { useSettingsStore } from '@/src/state/settings-store';
import { scaleTextStyle } from './scaling';

export const ScaledText = forwardRef<NativeText, TextProps>(function ScaledText(props, ref) {
  const displaySize = useSettingsStore((state) => state.displaySize);
  const style = scaleTextStyle(props.style, textScaleForDisplay(displaySize));
  return <NativeText {...props} ref={ref} style={style} />;
});

export const ScaledTextInput = forwardRef<NativeTextInput, TextInputProps>(function ScaledTextInput(props, ref) {
  const displaySize = useSettingsStore((state) => state.displaySize);
  const style = scaleTextStyle(props.style, textScaleForDisplay(displaySize));
  return <NativeTextInput {...props} ref={ref} style={style} />;
});

export { ScaledText as Text, ScaledTextInput as TextInput };
