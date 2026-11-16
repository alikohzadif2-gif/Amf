import { StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { ScreenFrame } from '@/components/ScreenFrame';
import { ScreenHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';

type DocumentBlock = {
  heading: TranslationKey;
  body: TranslationKey;
};

export function SettingsDocumentScreen({
  title,
  blocks,
}: {
  title: TranslationKey;
  blocks: DocumentBlock[];
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();

  return (
    <ScreenFrame scroll>
      <ScreenHeader title={t(title)} />
      {blocks.map((block) => (
        <View
          key={block.heading}
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Text
            style={[
              styles.heading,
              {
                color: colors.foreground,
                fontFamily: fontFamilyFor(language, 'semibold'),
                textAlign: alignOf(isRTL),
              },
            ]}
          >
            {t(block.heading)}
          </Text>
          <Text
            style={[
              styles.body,
              {
                color: colors.mutedForeground,
                fontFamily: fontFamilyFor(language),
                textAlign: alignOf(isRTL),
                lineHeight: language === 'fa' ? 26 : 23,
              },
            ]}
          >
            {t(block.body)}
          </Text>
        </View>
      ))}
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
    marginBottom: 12,
    gap: 8,
  },
  heading: { fontSize: 16, lineHeight: 24 },
  body: { fontSize: 14 },
});
