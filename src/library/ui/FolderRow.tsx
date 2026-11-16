import { Feather } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { IconTile } from '@/components/ui';
import { radii } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';
import { archiveCategoryOptions } from '../archive-model';
import { hasRealDate, sortRefs, type LibraryEntry } from '../merge';
import { sourceKinds } from '../providers';
import { useUserData } from '../user-data';
import { SOURCE_ICON } from './EntryCell';

function FolderRowBase({ entry, onPress, onLongPress }: {
  entry: LibraryEntry; onPress: (entry: LibraryEntry) => void; onLongPress: (entry: LibraryEntry) => void;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const calendar = useSettingsStore((s) => s.calendarMode);
  const metadata = useUserData((s) => s.archiveMeta[entry.key]);
  const customCategories = useUserData((s) => s.customCategories);
  const category = archiveCategoryOptions(customCategories, t).find((item) => item.id === (metadata?.category ?? 'none'));
  const folderDate = metadata?.date ?? entry.item.mtime;
  const categoryLabel = category?.label ?? t('diaryCategoryNone');
  const metaText = hasRealDate(folderDate) ? `${formatDate(folderDate, calendar, language, digits)} · ${categoryLabel}` : categoryLabel; // Q2: no date = show none
  const kinds = sourceKinds();
  const present = [...new Set(sortRefs(entry.refs, kinds).map((r) => kinds[r.sourceId]))].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.item.name}
      onPress={() => onPress(entry)}
      onLongPress={() => onLongPress(entry)}
      delayLongPress={280}
      style={({ pressed }) => [
        styles.row,
        {
          flexDirection: rowOf(isRTL),
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.72 : 1,
        },
      ]}
    >
      <IconTile icon="folder" size={44} color={colors.primary} />
      <View style={styles.nameGroup}>
        <Text numberOfLines={1} style={[styles.name, { color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), textAlign: isRTL ? 'right' : 'left' }]}>
          {entry.item.name}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: isRTL ? 'right' : 'left' }]}>
          {metaText}
        </Text>
      </View>
      <View style={[styles.icons, { flexDirection: rowOf(isRTL) }]}>
        {present.map((kind) => (
          <Feather key={kind} name={SOURCE_ICON[kind]} size={13} color={colors.mutedForeground} />
        ))}
      </View>
      <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

export const FolderRow = memo(FolderRowBase);

const styles = StyleSheet.create({
  row: {
    minHeight: 66,
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    marginStart: 14,
    marginEnd: 14,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.tile,
  },
  nameGroup: { flex: 1, gap: 2 },
  name: { fontSize: 15 },
  meta: { fontSize: 11 },
  icons: { gap: 6 },
});
