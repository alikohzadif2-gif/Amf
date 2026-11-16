import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Switch } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { ScreenFrame } from '@/components/ScreenFrame';
import { SettingGroup, ActionRow } from '@/components/settings/SettingRows';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { toDigits } from '@/src/lib/calendar';
import { useSettingsStore } from '@/src/state/settings-store';
import { useSourcesStore } from '@/src/state/sources-store';
import { removeServerSource } from '@/src/server/manage';
import { useDriveStore } from '@/src/state/drive-store';
import { getProvider } from '@/src/storage/registry';
import type {
  ProviderTestResult,
  SourceConfig,
  TestCode,
} from '@/src/storage/types';

const KIND_LABEL: Record<SourceConfig['kind'], TranslationKey> = {
  local: 'sourceKindLocal',
  server: 'sourceKindServer',
  drive: 'sourceKindDrive',
  vault: 'libSrcVault',
};

const ICON: Record<SourceConfig['kind'], keyof typeof Feather.glyphMap> = {
  local: 'smartphone',
  server: 'server',
  drive: 'cloud',
  vault: 'lock',
};

const CODE_LABEL: Record<TestCode, TranslationKey> = {
  ok: 'testOk',
  'permission-needed': 'testPermission',
  unavailable: 'testUnavailable',
  unauthorized: 'testUnauthorized',
  error: 'testError',
};

function defaultName(source: SourceConfig): TranslationKey {
  if (source.kind === 'local') return 'sourceLocal';
  if (source.kind === 'drive') return 'sourceKindDrive';
  if (source.kind === 'vault') return 'libSrcVault';
  if (source.stress) return 'sourceMockStress';
  if (source.kind === 'server' && source.backend === 'real') return 'sourceKindServer';
  return 'sourceMockServer';
}

function SourceCard({ source }: { source: SourceConfig }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((state) => state.digits);
  const setEnabled = useSourcesStore((state) => state.setSourceEnabled);
  const removeSource = useSourcesStore((state) => state.removeSource);
  const router = useRouter();
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const align = alignOf(isRTL);
  const provider = getProvider(source);
  const needsAccess = provider.capabilities().needsPermission;
  const isDrive = source.kind === 'drive';
  const driveAccount = useDriveStore((state) => state.account);

  const run = async (action: 'test' | 'access') => {
    setBusy(true);
    try {
      const next =
        action === 'access' && provider.requestAccess
          ? await provider.requestAccess()
          : await provider.test();
      setResult(next);
    } catch {
      setResult({ ok: false, code: 'error', latencyMs: 0 });
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = () =>
    Alert.alert(t('removeSourceTitle'), source.kind === 'server' && source.backend === 'real' ? t('serverRemoveSourceBody') : t('removeSourceBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('removeSource'),
        style: 'destructive',
        onPress: () => {
          if (source.kind === 'server' && source.backend === 'real') void removeServerSource(source.id);
          else removeSource(source.id);
        },
      },
    ]);

  const detail =
    result?.ok && result.rootCount !== undefined
      ? ` · ${toDigits(result.latencyMs, digits)} ${t('unitMs')} · ${toDigits(result.rootCount, digits)} ${t('foldersCount')}`
      : '';

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={[styles.cardHead, { flexDirection: rowOf(isRTL) }]}>
        <View style={[styles.iconWrap, { backgroundColor: colors.accent + '20' }]}>
          <Feather name={ICON[source.kind]} size={19} color={colors.primary} />
        </View>
        <View style={styles.cardTitleBox}>
          <Text
            style={[
              styles.cardTitle,
              {
                color: colors.foreground,
                fontFamily: fontFamilyFor(language, 'medium'),
                textAlign: align,
              },
            ]}
          >
            {source.name ?? t(defaultName(source))}
          </Text>
          <Text
            style={[
              styles.cardSub,
              {
                color: colors.mutedForeground,
                fontFamily: fontFamilyFor(language),
                textAlign: align,
              },
            ]}
          >
            {isDrive && driveAccount ? driveAccount.email : t(KIND_LABEL[source.kind])}
          </Text>
        </View>
        <Switch
          value={source.enabled}
          onValueChange={(value) => setEnabled(source.id, value)}
          accessibilityLabel={t('sourceEnabled')}
          trackColor={{ false: colors.track, true: colors.switchOn }}
          thumbColor="#FFFFFF"
        />
      </View>

      {source.backend === 'mock' ? (
        <View style={[styles.badgeLine, { flexDirection: rowOf(isRTL) }]}>
          <View style={[styles.demoBadge, { backgroundColor: colors.accent + '24' }]}>
            <Text
              style={[
                styles.demoText,
                { color: colors.primary, fontFamily: fontFamilyFor(language, 'medium') },
              ]}
            >
              {t('badgeDemo')}
            </Text>
          </View>
        </View>
      ) : null}

      {result ? (
        <Text
          style={[
            styles.result,
            {
              color: result.ok ? colors.success : colors.destructive,
              fontFamily: fontFamilyFor(language),
              textAlign: align,
            },
          ]}
        >
          {t(
            isDrive && result.code === 'permission-needed'
              ? 'driveNotSignedIn'
              : isDrive && result.code === 'unauthorized'
                ? 'driveSessionExpired'
                : result.code === 'unavailable' && source.kind === 'server' && source.backend === 'real'
                  ? 'testUnreachable'
                  : CODE_LABEL[result.code],
          )}
          {detail}
        </Text>
      ) : null}

      <View style={[styles.actions, { flexDirection: rowOf(isRTL) }]}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => run('test')}
          style={({ pressed }) => [
            styles.button,
            { borderColor: colors.border, opacity: pressed || busy ? 0.6 : 1 },
          ]}
        >
          <Text
            style={[
              styles.buttonText,
              { color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium') },
            ]}
          >
            {t(busy ? 'testing' : 'testSource')}
          </Text>
        </Pressable>
        {needsAccess && (result?.code === 'permission-needed' || (isDrive && result?.code === 'unauthorized')) ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => run('access')}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.primary, borderColor: colors.primary, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text
              style={[
                styles.buttonText,
                { color: colors.primaryForeground, fontFamily: fontFamilyFor(language, 'medium') },
              ]}
            >
              {t(isDrive ? 'driveSignIn' : 'grantAccess')}
            </Text>
          </Pressable>
        ) : null}
        {!source.builtIn ? (
          <Pressable
            accessibilityRole="button"
            onPress={confirmRemove}
            style={({ pressed }) => [
              styles.button,
              { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Text
              style={[
                styles.buttonText,
                { color: colors.destructive, fontFamily: fontFamilyFor(language, 'medium') },
              ]}
            >
              {t('removeSource')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default function SourcesScreen() {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((state) => state.digits);
  const sources = useSourcesStore((state) => state.sources);
  const addMockSource = useSourcesStore((state) => state.addMockSource);
  const addStressSource = useSourcesStore((state) => state.addStressSource);
  const align = alignOf(isRTL);

  const add = () => {
    const base = t('sourceMockServer');
    const count = sources.filter((s) => s.kind === 'server' && s.backend === 'mock').length;
    addMockSource('server', count === 0 ? undefined : `${base} ${toDigits(count + 1, digits)}`);
  };

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
        <Feather name={isRTL ? 'arrow-right' : 'arrow-left'} size={18} color={colors.foreground} />
        <Text style={[styles.backText, { color: colors.foreground, fontFamily: fontFamilyFor(language) }]}>
          {t('back')}
        </Text>
      </Pressable>
      <Text
        style={[
          styles.title,
          { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: align },
        ]}
      >
        {t('sourcesTitle')}
      </Text>
      <Text
        style={[
          styles.intro,
          { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: align },
        ]}
      >
        {t('sourcesIntro')}
      </Text>

      {sources.map((source) => (
        <SourceCard key={source.id} source={source} />
      ))}

      <SettingGroup title="addSource">
        <ActionRow title="addDemoServer" icon="plus" onPress={add} />
        <ActionRow title="addStressSource" description="addStressSourceDesc" icon="plus" onPress={() => addStressSource()} />
        <ActionRow title="addRealServer" description="addRealServerDesc" onPress={() => router.push('/settings/add-server')} />
      </SettingGroup>
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
  title: { fontSize: 26, marginTop: 22 },
  intro: { fontSize: 13, lineHeight: 22, marginTop: 8, marginBottom: 20 },
  card: { borderWidth: 1, borderRadius: 21, padding: 16, marginBottom: 14 },
  cardHead: { alignItems: 'center', gap: 12 },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitleBox: { flex: 1 },
  cardTitle: { fontSize: 15 },
  cardSub: { fontSize: 12, marginTop: 2 },
  badgeLine: { marginTop: 10 },
  demoBadge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 },
  demoText: { fontSize: 11 },
  result: { fontSize: 12, marginTop: 10 },
  actions: { flexWrap: 'wrap', gap: 8, marginTop: 14 },
  button: {
    minHeight: 38,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 12 },
});
