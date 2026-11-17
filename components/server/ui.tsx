import { Feather } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, type KeyboardTypeOptions } from 'react-native';
import { Text, TextInput } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { useColors } from '@/hooks/useColors';
import { withAlpha } from '@/constants/colors';
import { radii, typography } from '@/constants/theme';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { sectionLabelSpacing, sectionLabelText } from '@/src/lib/ui-text';
import { CircleBackButton } from '@/components/ui/BackButton';
import { Input } from '@/components/ui/Input';

/** Small building blocks shared by the Phase 4 server/upload screens. */

/** Circular back button (U5). Same export as before, so every screen inherits it; for a titled header use `ScreenHeader` from components/ui. */
export function BackButton() {
  return (
    <View style={{ alignSelf: 'flex-start' }}>
      <CircleBackButton />
    </View>
  );
}

export function Title({ title, intro }: { title: TranslationKey; intro?: TranslationKey }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <View style={{ marginTop: 22, marginBottom: 18 }}>
      <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 26, textAlign: alignOf(isRTL) }}>
        {t(title)}
      </Text>
      {intro ? (
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, lineHeight: 22, marginTop: 8, textAlign: alignOf(isRTL) }}>
          {t(intro)}
        </Text>
      ) : null}
    </View>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  keyboardType,
  multiline,
}: {
  label: TranslationKey;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: KeyboardTypeOptions;
  multiline?: boolean;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text
        style={{
          color: colors.mutedForeground,
          fontFamily: fontFamilyFor(language, 'semibold'),
          fontSize: 12.5,
          letterSpacing: sectionLabelSpacing(language, typography.sectionLabel.letterSpacing),
          marginBottom: 8,
          textAlign: alignOf(isRTL),
        }}
      >
        {sectionLabelText(t(label), language)}
      </Text>
      <Input
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        secure={secure}
        keyboardType={keyboardType}
        multiline={multiline}
        accessibilityLabel={t(label)}
      />
    </View>
  );
}

export type ButtonVariant = 'primary' | 'outline' | 'dark';

/**
 * Pill button (U4). `primary` = coral fill; `outline` = navy fill + coral border and text; `dark` = navy fill + hairline border (default).
 * `primary` (boolean) still works and means variant="primary"; `destructive` colours the label of a `dark` button.
 * A disabled primary button uses the muted "track" look; every other variant dims.
 */
export function Button({
  title,
  onPress,
  primary,
  destructive,
  busy,
  disabled,
  icon,
  variant,
  compact,
}: {
  title: TranslationKey;
  onPress: () => void;
  primary?: boolean;
  destructive?: boolean;
  busy?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Feather.glyphMap;
  variant?: ButtonVariant;
  compact?: boolean;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const kind: ButtonVariant = variant ?? (primary ? 'primary' : 'dark');
  const off = !!disabled;
  const fg =
    kind === 'primary'
      ? off
        ? colors.mutedForeground
        : colors.primaryForeground
      : kind === 'outline'
        ? colors.primary
        : destructive
          ? colors.destructive
          : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off || !!busy }}
      disabled={off || busy}
      onPress={onPress}
      style={({ pressed }) => {
        const fill =
          kind === 'primary' ? (off ? colors.track : pressed ? colors.primaryPressed : colors.primary) : colors.card;
        const border = kind === 'primary' ? fill : kind === 'outline' ? colors.primary : colors.border;
        return [
          styles.button,
          {
            minHeight: compact ? 42 : 52,
            direction: isRTL ? 'rtl' : 'ltr',
            flexDirection: rowOf(isRTL),
            backgroundColor: fill,
            borderColor: border,
            opacity: off && kind !== 'primary' ? 0.5 : pressed && kind !== 'primary' ? 0.75 : 1,
          },
        ];
      }}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon ? <Feather name={icon} size={compact ? 15 : 18} color={fg} /> : null}
      <Text
        style={{
          color: fg,
          fontFamily: fontFamilyFor(language, 'semibold'),
          fontSize: compact ? 14 : typography.button.fontSize,
        }}
      >
        {t(title)}
      </Text>
    </Pressable>
  );
}

export function Notice({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'ok' | 'error' | 'warn' }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const color = tone === 'ok' ? colors.success : tone === 'error' ? colors.destructive : tone === 'warn' ? colors.foreground : colors.mutedForeground;
  const text = (
    <Text style={{ color, fontFamily: fontFamilyFor(language), fontSize: 13, lineHeight: language === 'fa' ? 24 : 20, textAlign: alignOf(isRTL) }}>
      {children}
    </Text>
  );
  // plain helper text stays plain; status messages get a soft tinted box
  if (tone === 'muted') return <View style={{ marginBottom: 12 }}>{text}</View>;
  const tint = tone === 'warn' ? colors.mutedForeground : color;
  return (
    <View style={[styles.notice, { backgroundColor: withAlpha(tint, 0.12), borderColor: withAlpha(tint, 0.3) }]}>{text}</View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>{children}</View>;
}

const styles = StyleSheet.create({
  button: { minHeight: 52, borderWidth: 1.5, borderRadius: radii.pill, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', gap: 8 },
  card: { borderWidth: 1, borderRadius: radii.card, padding: 18, marginBottom: 14 },
  notice: { borderWidth: 1, borderRadius: radii.control + 2, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12 },
});
