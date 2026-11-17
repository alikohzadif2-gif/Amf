import { StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { scaleNumericStyleValues } from '@/constants/theme';

const TEXT_SIZE_KEYS = ['fontSize', 'lineHeight', 'letterSpacing', 'textShadowRadius'] as const;
const CARD_SIZE_KEYS = [
  'padding',
  'paddingHorizontal',
  'paddingVertical',
  'paddingTop',
  'paddingBottom',
  'paddingStart',
  'paddingEnd',
  'gap',
  'rowGap',
  'columnGap',
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'minHeight',
] as const;
const CARD_CONTENT_KEYS = [
  'padding',
  'paddingHorizontal',
  'paddingVertical',
  'paddingTop',
  'paddingBottom',
  'paddingStart',
  'paddingEnd',
  'gap',
  'rowGap',
  'columnGap',
  'minHeight',
] as const;

export function scaleTextStyle(style: StyleProp<TextStyle>, scale: number): StyleProp<TextStyle> {
  if (scale === 1) return style;
  const flat = StyleSheet.flatten(style);
  if (!flat) return style;
  return scaleNumericStyleValues(flat as Record<string, unknown>, TEXT_SIZE_KEYS, scale) as TextStyle;
}

function hasCardSurface(style: ViewStyle): boolean {
  return typeof style.borderRadius === 'number'
    && style.borderRadius >= 12
    && CARD_CONTENT_KEYS.some((key) => {
      const value = style[key];
      return typeof value === 'number' && value !== 0;
    });
}

export function scaleCardStyle(style: StyleProp<ViewStyle>, scale: number): StyleProp<ViewStyle> {
  if (scale === 1) return style;
  const flat = StyleSheet.flatten(style);
  if (!flat || !hasCardSurface(flat)) return style;
  return scaleNumericStyleValues(flat as Record<string, unknown>, CARD_SIZE_KEYS, scale) as ViewStyle;
}
