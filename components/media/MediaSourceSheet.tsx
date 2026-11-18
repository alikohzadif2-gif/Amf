import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { IconTile } from '@/components/ui/IconTile';
import { useColors } from '@/hooks/useColors';
import { radii } from '@/constants/theme';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import type { MediaSource } from '@/src/media/pick';

/**
 * "Where from?" sheet: Camera / Gallery (and Files, only where the caller turns it on).
 * It only reports the choice (`onSelect`) and closes itself; the caller runs `pickFromSource(source, …)` from `src/media/pick`.
 * Render it as the last child of a screen (BottomSheet rule).
 */
export function MediaSourceSheet({
  visible,
  onClose,
  onSelect,
  allowFiles = false,
  title,
  extraRows = [],
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (source: MediaSource) => void;
  allowFiles?: boolean;
  title?: string;
  /** Extra actions under the three sources (e.g. "New folder" in the Google Drive view). */
  extraRows?: { id: string; icon: 'folder-plus'; label: string; onPress: () => void }[];
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();

  const rows: { source: MediaSource; icon: 'camera' | 'image' | 'folder'; label: string }[] = [
    { source: 'camera', icon: 'camera', label: t('mediaSourceCamera') },
    { source: 'gallery', icon: 'image', label: t('mediaSourceGallery') },
    ...(allowFiles ? [{ source: 'files' as const, icon: 'folder' as const, label: t('mediaSourceFiles') }] : []),
  ];
  const all: { key: string; icon: 'camera' | 'image' | 'folder' | 'folder-plus'; label: string; run: () => void }[] = [
    ...rows.map((row) => ({ key: row.source, icon: row.icon, label: row.label, run: () => onSelect(row.source) })),
    ...extraRows.map((row) => ({ key: row.id, icon: row.icon, label: row.label, run: row.onPress })),
  ];

  return (
    <BottomSheet visible={visible} onClose={onClose} title={title ?? t('mediaSourceTitle')} cancelLabel={t('cancel')}>
      <View style={[styles.group, { backgroundColor: colors.card }]}>
        {all.map((row, i) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={row.label}
            onPress={() => {
              onClose();
              row.run();
            }}
            style={({ pressed }) => [
              styles.row,
              { flexDirection: rowOf(isRTL), opacity: pressed ? 0.7 : 1 },
              i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border } : null,
            ]}
          >
            <IconTile icon={row.icon} size={44} color={colors.primary} />
            <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 16, textAlign: isRTL ? 'right' : 'left' }}>
              {row.label}
            </Text>
            <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={20} color={colors.mutedForeground} />
          </Pressable>
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: radii.card, overflow: 'hidden' },
  row: { alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 12 },
});
