import { Text } from '@/components/ui/ScaledText';
import { Notice } from '@/components/server/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf } from '@/src/lib/layout';
import { connectionMessageKey, featureLabelKey } from '@/src/server/connection-text';
import type { ConnectionTest } from '@/src/server/test-connection';
import { useSettingsStore } from '@/src/state/settings-store';

/** The lines shown for one connection test: result, server, role, features. */
export function useConnectionLines(test: ConnectionTest): string[] {
  const { t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const lines: string[] = [t(connectionMessageKey(test))];
  if (!test.ok && test.issue === 'busy' && test.retryAfter) {
    lines.push(t('connBusyRetry').replace('{seconds}', toDigits(test.retryAfter, digits)));
  }
  if (!test.ok) return lines;

  const server = [test.ping?.name, test.ping?.version].filter(Boolean).join(' · ');
  const speed = `${toDigits(test.latencyMs, digits)} ${t('unitMs')} · ${toDigits(test.rootCount ?? 0, digits)} ${t('foldersCount')}`;
  lines.push(server ? `${server} · ${speed}` : speed);

  if (test.me) lines.push(`${t('connRole')}: ${t(test.me.role === 'owner' ? 'connRoleOwner' : 'connRoleMember')}`);

  // Features come from the server (/ping and /me). Known ones are translated; none yet is a normal state.
  const features = test.me?.features ?? test.ping?.features ?? [];
  if (features.length === 0) {
    lines.push(t('connFeaturesNone'));
  } else {
    const labels = features.map((f) => {
      const key: TranslationKey | null = featureLabelKey(f);
      return key ? t(key) : f;
    });
    lines.push(`${t('connFeatures')}: ${labels.join(', ')}`);
  }
  return lines;
}

/** Boxed status for the add-server wizard. */
export function ConnectionNotice({ test }: { test: ConnectionTest }) {
  const lines = useConnectionLines(test);
  return <Notice tone={test.ok ? 'ok' : 'error'}>{lines.join('\n')}</Notice>;
}

/** Compact text status under one address on the servers screen. */
export function ConnectionLines({ test }: { test: ConnectionTest }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const lines = useConnectionLines(test);
  return (
    <>
      {lines.map((line, index) => (
        <Text
          key={index}
          style={{
            color: index === 0 ? (test.ok ? colors.success : colors.destructive) : colors.mutedForeground,
            fontFamily: fontFamilyFor(language),
            fontSize: 12,
            lineHeight: language === 'fa' ? 20 : 17,
            marginTop: index === 0 ? 6 : 2,
            textAlign: alignOf(isRTL),
          }}
        >
          {line}
        </Text>
      ))}
    </>
  );
}
