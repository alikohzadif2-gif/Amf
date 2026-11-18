import { Feather, Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { useColors } from '@/hooks/useColors';
import { SharedThumb } from '@/components/diary/SharedThumb';
import { Thumb } from '@/src/library/ui/Thumb';
import { HERO_THUMB } from '@/src/media/thumb-cache';
import type { LibraryEntry } from '@/src/library/merge';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

/** Mood emoji next to the title on the card. */
export const DIARY_CARD_EMOJI_SIZE = 26;
export const DIARY_CARD_COVER_HEIGHT = 150;

/**
 * Memory card (reference clip): a wide cover on top with the category badge in its corner and a "+N" badge when the memory has more
 * media; below it the mood emoji + title, a one-line preview of the text and, at the bottom, "Replied ♥" (when the partner answered)
 * at the start and the date at the end. A book icon stands in when there is no cover.
 */
export function DiaryCard({
  title,
  body,
  categoryLabel,
  mood,
  dateLabel,
  saved,
  cover,
  sharedCover,
  extraMedia,
  attachmentsLabel,
  replied,
  repliedLabel,
  onPress,
}: {
  title: string;
  /** First line(s) of the memory's text, shown under the title. */
  body?: string;
  categoryLabel: string;
  mood: string | null;
  dateLabel: string;
  saved: boolean;
  cover?: LibraryEntry;
  /** A file shared by the partner (`Shared/<id>/...`), shown when there is no Library cover. */
  sharedCover?: string;
  /** Media beyond the cover (the "+N" badge); 0 or missing = no badge. */
  extraMedia?: number;
  /** R8a: "N attachments" of a memory received from the partner (its files arrive in R8b). */
  attachmentsLabel?: string;
  /** The other partner has replied to this memory. */
  replied?: boolean;
  repliedLabel?: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const align = isRTL ? 'right' : 'left';
  const hasCover = !!cover || !!sharedCover;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.9 : 1 }]}
    >
      <View style={[styles.coverWrap, { height: hasCover ? DIARY_CARD_COVER_HEIGHT : 96, backgroundColor: colors.raised }]}>
        {cover ? <Thumb entry={cover} size={HERO_THUMB} style={styles.cover} /> : sharedCover ? <SharedThumb path={sharedCover} size="preview" style={styles.cover} /> : (
          <Feather name="book-open" size={30} color={colors.mutedForeground} />
        )}
        <View pointerEvents="none" style={[styles.badge, styles.categoryBadge, { backgroundColor: 'rgba(255,255,255,0.92)' }]}>
          <Text numberOfLines={1} style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 12.5, textAlign: 'center' }}>{categoryLabel}</Text>
        </View>
        {extraMedia && extraMedia > 0 ? (
          <View pointerEvents="none" style={[styles.badge, styles.extraBadge, { flexDirection: rowOf(isRTL), backgroundColor: 'rgba(20,20,24,0.62)' }]}>
            <Ionicons name="images" size={14} color="#FFFFFF" />
            <Text style={{ color: '#FFFFFF', fontFamily: fontFamilyFor(language, 'bold'), fontSize: 12.5 }}>{`+${extraMedia}`}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.text}>
        <View style={[styles.row, { flexDirection: rowOf(isRTL) }]}>
          {mood ? <Text style={{ fontSize: DIARY_CARD_EMOJI_SIZE, lineHeight: DIARY_CARD_EMOJI_SIZE + 8 }}>{mood}</Text> : null}
          <Text numberOfLines={2} style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 18, textAlign: align }}>{title}</Text>
          {saved ? <Feather name="bookmark" size={17} color={colors.primary} /> : null}
        </View>
        {body ? <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 14, textAlign: align }}>{body}</Text> : null}
        {attachmentsLabel ? <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12, textAlign: align }}>{attachmentsLabel}</Text> : null}
        <View style={[styles.row, styles.footer, { flexDirection: rowOf(isRTL) }]}>
          {replied ? (
            <View style={[styles.row, { flexDirection: rowOf(isRTL), gap: 6 }]}>
              <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 14 }}>{repliedLabel}</Text>
              <Ionicons name="heart" size={16} color={colors.primary} />
            </View>
          ) : <View />}
          <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 13 }}>{dateLabel}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 28,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOpacity: 0.07,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  coverWrap: { width: '100%', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  cover: { width: '100%', height: '100%' },
  badge: { position: 'absolute', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, alignItems: 'center', gap: 5 },
  categoryBadge: { top: 12, end: 12, maxWidth: '60%' },
  extraBadge: { bottom: 10, start: 10 },
  text: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 6 },
  row: { alignItems: 'center', gap: 8 },
  footer: { justifyContent: 'space-between', marginTop: 4 },
});
