import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Notice } from '@/components/server/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf } from '@/src/lib/layout';

/**
 * Shown when the partner mailbox gets 401 (or a socket close 4401): the server did not accept this phone's
 * token. The pairing and the saved token are kept; the link leads to Settings > Server connection.
 */
export function TokenNotAcceptedNotice() {
  const router = useRouter();
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <View style={{ marginBottom: 12 }}>
      <Notice tone="warn">{t('mailboxTokenNotAccepted')}</Notice>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t('tokenNoticeOpen')}
        onPress={() => router.push('/settings/server-connection')}
        hitSlop={8}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, marginTop: 8 })}
      >
        <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14, textAlign: alignOf(isRTL) }}>
          {t('tokenNoticeOpen')}
        </Text>
      </Pressable>
    </View>
  );
}
