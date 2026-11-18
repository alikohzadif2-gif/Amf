import { Feather } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View, type KeyboardTypeOptions, type ReturnKeyTypeOptions } from 'react-native';
import { TextInput } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { radii } from '@/constants/theme';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';

/**
 * Filled input (UI_PHASES 5.2): `input` fill, optional leading icon, coral focus border,
 * password eye when `secure`. `multiline` grows to `minHeight` (default 110). RTL: icon and eye swap sides, text aligns to the start.
 */
export function Input({
  value,
  onChangeText,
  placeholder,
  icon,
  secure,
  multiline,
  keyboardType,
  autoCapitalize = 'none',
  autoFocus,
  maxLength,
  editable = true,
  error,
  returnKeyType,
  onSubmitEditing,
  minHeight,
  fontSize,
  accessibilityLabel,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  icon?: keyof typeof Feather.glyphMap;
  secure?: boolean;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoFocus?: boolean;
  maxLength?: number;
  editable?: boolean;
  error?: boolean;
  returnKeyType?: ReturnKeyTypeOptions;
  onSubmitEditing?: () => void;
  minHeight?: number;
  fontSize?: number;
  accessibilityLabel?: string;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const idleBorder = colors.isDark ? 'transparent' : colors.border;
  const borderColor = error ? colors.destructive : focused ? colors.inputFocusBorder : idleBorder;
  return (
    <View
      collapsable={false}
      style={[
        styles.box,
        {
          flexDirection: rowOf(isRTL),
          backgroundColor: colors.input,
          borderColor,
          minHeight: multiline ? (minHeight ?? 110) : 54,
          alignItems: multiline ? 'flex-start' : 'center',
          opacity: editable ? 1 : 0.6,
        },
      ]}
    >
      {icon ? (
        <Feather name={icon} size={20} color={focused ? colors.primary : colors.mutedForeground} style={multiline ? styles.iconTop : undefined} />
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry={secure && !revealed}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        autoFocus={autoFocus}
        maxLength={maxLength}
        editable={editable}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={accessibilityLabel ?? placeholder}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[
          styles.text,
          {
            color: colors.foreground,
            fontFamily: fontFamilyFor(language),
            textAlign: alignOf(isRTL),
            paddingVertical: multiline ? 14 : 0,
            fontSize: fontSize ?? 16,
            lineHeight: fontSize ? Math.ceil(fontSize * 1.5) : undefined,
          },
        ]}
      />
      {secure ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? t('hidePassword') : t('showPassword')}
          hitSlop={10}
          onPress={() => setRevealed((v) => !v)}
        >
          <Feather name={revealed ? 'eye-off' : 'eye'} size={20} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radii.card - 4, borderWidth: 1.5, paddingHorizontal: 16, gap: 12 },
  text: { flex: 1, fontSize: 16, minHeight: 44 },
  iconTop: { marginTop: 17 },
});
