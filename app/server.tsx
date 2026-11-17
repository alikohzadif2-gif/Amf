import { useRouter } from 'expo-router';
import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { setServerPrefill } from '@/src/server/prefill';
import { buildQrServer } from '@/src/server/qr';

/**
 * Deep link `meyou://server?url=…&token=…&name=…&fp=…` (the link `meyou-server init` prints).
 * It never saves anything by itself: it hands the values to the add-server screen (in memory only),
 * which tests the connection and waits for the person to press Save.
 */
export default function ServerLinkScreen() {
  const router = useRouter();
  const colors = useColors();
  const params = useLocalSearchParams<{ url?: string; token?: string; name?: string; fp?: string }>();

  useEffect(() => {
    const parsed = buildQrServer(params.url, params.token, params.name, params.fp);
    if (parsed) {
      setServerPrefill(parsed);
      router.replace({ pathname: '/settings/add-server', params: { prefill: '1' } });
    } else {
      router.replace({ pathname: '/settings/add-server', params: { invalid: '1' } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <View style={{ flex: 1, backgroundColor: colors.background }} />;
}
