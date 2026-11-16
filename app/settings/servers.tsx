import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ConnectionLines } from '@/components/server/ConnectionStatus';
import { BackButton, Button, Card, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { SettingGroup, ActionRow } from '@/components/settings/SettingRows';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { removeServerSource } from '@/src/server/manage';
import { testConnection, type ConnectionTest } from '@/src/server/test-connection';
import { secureTokenStore } from '@/src/server/token-store';
import { useServersStore } from '@/src/state/servers-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { useSourcesStore } from '@/src/state/sources-store';
import type { ServerEntry } from '@/src/server/types';

function AddressRow({ entry, index, count }: { entry: ServerEntry; index: number; count: number }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const move = useServersStore((s) => s.moveServer);
  const removeServer = useServersStore((s) => s.removeServer);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [busy, setBusy] = useState(false);

  const test = async () => {
    setBusy(true);
    const token = await secureTokenStore.get(entry.id);
    setResult(token ? await testConnection({ url: entry.url, token }) : { ok: false, code: 'unauthorized', issue: 'unauthorized', latencyMs: 0 });
    setBusy(false);
  };

  const confirmRemove = () =>
    Alert.alert(t('serverRemoveTitle'), t('serverRemoveBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('removeSource'),
        style: 'destructive',
        onPress: async () => {
          const emptied = await removeServer(entry.id);
          if (emptied) useSourcesStore.getState().removeSource(emptied);
        },
      },
    ]);

  const icon = (name: keyof typeof Feather.glyphMap, label: TranslationKey, onPress: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(label)}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ padding: 8, opacity: disabled ? 0.3 : pressed ? 0.6 : 1 })}
    >
      <Feather name={name} size={18} color={colors.foreground} />
    </Pressable>
  );

  return (
    <View style={{ paddingVertical: 10 }}>
      <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 6 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14, textAlign: alignOf(isRTL) }}>
            {toDigits(index + 1, digits)} · {entry.name}
          </Text>
          <Text
            style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor('en'), fontSize: 12, marginTop: 2, textAlign: 'left', writingDirection: 'ltr' }}
            numberOfLines={1}
          >
            {entry.url}
          </Text>
        </View>
        <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 11 }}>
          {t(index === 0 ? 'serverPrimary' : 'serverBackup')}
        </Text>
      </View>
      {entry.fingerprintConfirmed ? (
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 11.5, marginTop: 4, textAlign: alignOf(isRTL) }}>
          {t('serverFingerprintOk')}
        </Text>
      ) : null}
      {result ? <ConnectionLines test={result} /> : null}
      <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 4, marginTop: 6 }}>
        <Button title={busy ? 'testing' : 'testSource'} busy={busy} onPress={() => void test()} />
        {icon('arrow-up', 'serverMoveUp', () => move(entry.id, -1), index === 0)}
        {icon('arrow-down', 'serverMoveDown', () => move(entry.id, 1), index === count - 1)}
        {icon('trash-2', 'removeSource', confirmRemove)}
      </View>
    </View>
  );
}

export default function ServersScreen() {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const failover = useSettingsStore((s) => s.serverFailover);
  const sources = useSourcesStore((s) => s.sources).filter((s) => s.kind === 'server' && s.backend === 'real');
  const servers = useServersStore((s) => s.servers);

  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="serversTitle" intro="serversIntro" />
      {!failover ? <Notice tone="warn">{t('serverFailoverOff')}</Notice> : null}
      {sources.length === 0 ? <Notice>{t('serversEmpty')}</Notice> : null}
      {sources.map((source) => {
        const entries = servers.filter((s) => s.sourceId === source.id);
        return (
          <Card key={source.id}>
            <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 10 }}>
              <Feather name="server" size={19} color={colors.primary} />
              <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15, textAlign: alignOf(isRTL) }}>
                {source.name ?? entries[0]?.name ?? t('sourceKindServer')}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('removeSource')}
                onPress={() =>
                  Alert.alert(t('removeSourceTitle'), t('serverRemoveSourceBody'), [
                    { text: t('cancel'), style: 'cancel' },
                    { text: t('removeSource'), style: 'destructive', onPress: () => void removeServerSource(source.id) },
                  ])
                }
                hitSlop={8}
              >
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
            {entries.map((entry, index) => (
              <AddressRow key={entry.id} entry={entry} index={index} count={entries.length} />
            ))}
            <Button title="serverAddAddress" icon="plus" onPress={() => router.push({ pathname: '/settings/add-server', params: { sourceId: source.id } })} />
          </Card>
        );
      })}
      <SettingGroup>
        <ActionRow title="addServerManual" icon="plus" onPress={() => router.push('/settings/add-server')} />
        <ActionRow title="addServerQr" icon="camera" onPress={() => router.push({ pathname: '/settings/add-server', params: { method: 'qr' } })} />
      </SettingGroup>
    </ScreenFrame>
  );
}
