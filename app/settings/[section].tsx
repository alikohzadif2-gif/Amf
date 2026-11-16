import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { settingsSections } from '@/src/constants/settings-sections';
import { sectionComponents } from '@/src/settings/sections';

export default function SettingsSectionScreen() {
  const { section: sectionId } = useLocalSearchParams<{ section: string }>();
  const section = settingsSections.find((item) => item.id === sectionId);
  const Content = sectionId ? sectionComponents[sectionId] : undefined;
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();

  return (
    <ScreenFrame scroll>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('back')}
        onPress={() => router.back()}
        style={({ pressed }) => [
          styles.backButton,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: rowOf(isRTL),
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <Feather
          name={isRTL ? 'arrow-right' : 'arrow-left'}
          size={18}
          color={colors.foreground}
        />
        <Text
          style={[
            styles.backText,
            { color: colors.foreground, fontFamily: fontFamilyFor(language) },
          ]}
        >
          {t('back')}
        </Text>
      </Pressable>
      <View style={[styles.header, { flexDirection: rowOf(isRTL) }]}>
        <View style={[styles.iconWrap, { backgroundColor: colors.accent + '20' }]}>
          <Feather name={section?.icon ?? 'settings'} size={22} color={colors.primary} />
        </View>
        <Text
          style={[
            styles.title,
            {
              color: colors.foreground,
              fontFamily: fontFamilyFor(language, 'semibold'),
              textAlign: alignOf(isRTL),
            },
          ]}
        >
          {section ? t(section.title) : t('settings')}
        </Text>
      </View>
      {Content ? (
        <Content />
      ) : (
        <Text
          style={[
            styles.fallback,
            {
              color: colors.mutedForeground,
              fontFamily: fontFamilyFor(language),
              textAlign: alignOf(isRTL),
            },
          ]}
        >
          {t('sectionPlaceholder')}
        </Text>
      )}
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  backButton: {
    alignSelf: 'flex-start',
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 8,
  },
  backText: { fontSize: 13 },
  header: { alignItems: 'center', gap: 14, marginTop: 22, marginBottom: 20 },
  iconWrap: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, fontSize: 24 },
  fallback: { fontSize: 14, lineHeight: 24 },
});
