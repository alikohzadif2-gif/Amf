import { Feather } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { TextInput } from '@/components/ui/ScaledText';
import { typography } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { sectionLabelSpacing, sectionLabelText } from '@/src/lib/ui-text';

/** Borderless search row styled like a section label (reference 13: magnifier + "SEARCH MOODS…"); the placeholder is uppercase for English only. */
export function SearchRow({ value, onChangeText, placeholder }: { value: string; onChangeText: (v: string) => void; placeholder: string }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const label = typography.sectionLabel;
  return (
    <View style={[styles.row, { flexDirection: rowOf(isRTL) }]}>
      <Feather name="search" size={18} color={colors.mutedForeground} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={sectionLabelText(placeholder, language)}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={placeholder}
        returnKeyType="search"
        autoCorrect={false}
        selectionColor={colors.primary}
        style={{
          flex: 1,
          paddingVertical: 6,
          color: colors.foreground,
          fontFamily: fontFamilyFor(language, label.weight),
          fontSize: 14,
          letterSpacing: sectionLabelSpacing(language, label.letterSpacing),
          textAlign: alignOf(isRTL),
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 6 },
});
