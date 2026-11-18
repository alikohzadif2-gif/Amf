import { View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { presenceView, type PresenceView } from '@/src/partner/presence-logic';
import { usePartnerStore } from '@/src/state/partner-store';

/** The partner's online state (Stage 2D). Re-renders only when the server announces a change: no timer, no polling. */
export function usePresence(): PresenceView {
  const paired = usePartnerStore((s) => s.paired);
  const link = usePartnerStore((s) => s.link);
  const partnerOnline = usePartnerStore((s) => s.partnerOnline);
  return presenceView({ paired, link, partnerOnline });
}

/** Small dot + text ("Online" / "Offline"); renders nothing while the state is unknown (never a guess). */
export function PresenceLine({ size = 12 }: { size?: number }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const view = usePresence();
  if (view === 'unknown') return null;
  const online = view === 'online';
  const label = online ? t('presenceOnline') : t('presenceOffline');
  return (
    <View accessible accessibilityLabel={label} style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 5 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? colors.success : colors.mutedForeground, opacity: online ? 1 : 0.5 }} />
      <Text numberOfLines={1} style={{ color: online ? colors.success : colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: size }}>{label}</Text>
    </View>
  );
}
