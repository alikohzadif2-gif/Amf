import { Link, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';

export default function NotFoundScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();

  return (
    <>
      <Stack.Screen options={{ title: t('notFoundTitle') }} />
      <View style={[styles.container, { direction: isRTL ? 'rtl' : 'ltr', backgroundColor: colors.background }]}>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), textAlign: alignOf(isRTL) }]}>
          {t('notFoundMessage')}
        </Text>

        <Link href="/" style={styles.link}>
          <Text style={[styles.linkText, { color: colors.primary, fontFamily: fontFamilyFor(language), textAlign: 'center' }]}>
            {t('notFoundHome')}
          </Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  link: {
    marginTop: 15,
    paddingVertical: 15,
  },
  linkText: {
    fontSize: 14,
  },
});
