import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Image as RNImage, Pressable as RNPressable, StyleSheet, View as RNView } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useCustomCategories } from '@/src/diary/use-categories';
import { diaryCategoryLabel } from '@/src/diary/categories';
import type { DiaryRow } from '@/src/diary/diary-db';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { formatDate } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { useSettingsStore } from '@/src/state/settings-store';
import { useLibraryIndex } from '@/src/library/index-store';
import { providerFor } from '@/src/library/providers';
import { useUserData } from '@/src/library/user-data';

/**
 * "Latest diary" (reference): a dark gradient card with the category chip, the memory's title and first line, its date, and a
 * back arrow that steps to the previous (older) memory. Tapping the card opens the memory. No entries = nothing is drawn.
 */
export function LatestDiaryCard({ entries, onOpen }: { entries: DiaryRow[]; onOpen: (id: string) => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const { calendarMode, digits } = useSettingsStore();
  const { customs } = useCustomCategories();
  const [index, setIndex] = useState(0);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const libraryByKey = useLibraryIndex((state) => state.byKey);
  const offline = useUserData((state) => state.offline);
  const entry = entries.length > 0 ? entries[Math.min(index, entries.length - 1)] : null;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPreviewUri(null);
      if (!entry) return;
      const firstKey = entry.mediaKeys[0];
      if (!firstKey) return;
      const offlineUri = offline[firstKey]?.uri;
      if (offlineUri && !offline[firstKey]?.simulated) {
        setPreviewUri(offlineUri);
        return;
      }
      let libraryEntry = libraryByKey.get(firstKey);
      if (!libraryEntry && useLibraryIndex.getState().status === 'idle') {
        try {
          await useLibraryIndex.getState().build();
          libraryEntry = useLibraryIndex.getState().byKey.get(firstKey);
        } catch {
          // Keep the card usable even if the Library cannot be indexed.
        }
      }
      if (!libraryEntry || (libraryEntry.item.type !== 'image' && libraryEntry.item.type !== 'video')) return;
      for (const ref of libraryEntry.refs) {
        try {
          const provider = providerFor(ref.sourceId);
          if (!provider) continue;
          const thumb = await provider.getThumb(ref.itemId, 640);
          if (thumb?.uri) {
            if (!cancelled) setPreviewUri(thumb.uri);
            return;
          }
          if (libraryEntry.item.type === 'image') {
            const preview = await provider.getPreview(ref.itemId);
            if (preview?.uri) {
              if (!cancelled) setPreviewUri(preview.uri);
              return;
            }
          }
        } catch {
          // Try the next available source for this memory's first media item.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [entry?.id, entry?.mediaKeys, libraryByKey, offline]);
  if (!entry) return null;
  const align = alignOf(isRTL);
  const snippet = (entry.body.split('\n').find((l) => l.trim()) ?? '').trim();
  const title = entry.title.trim() || snippet;
  const showSnippet = entry.title.trim() !== '' && snippet !== '';
  const category = entry.category === 'none' ? null : diaryCategoryLabel(entry.category, customs, t as never);
  const date = formatDate(entry.createdAt, calendarMode === 'both' ? 'jalali' : calendarMode, language, digits);
  const white = '#FFFFFF';
  return (
    <RNPressable accessibilityRole="button" accessibilityLabel={title} onPress={() => onOpen(entry.id)} style={({ pressed }) => [styles.card, { opacity: pressed ? 0.9 : 1 }]}>
      {previewUri ? (
        <RNImage source={{ uri: previewUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <LinearGradient colors={['#8E8E8E', '#BDBDBD', '#454545', '#1B1B1B']} locations={[0, 0.25, 0.65, 1]} style={StyleSheet.absoluteFill} />
      )}
      {previewUri ? <LinearGradient colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.62)']} locations={[0.1, 1]} style={StyleSheet.absoluteFill} /> : null}
      {category ? (
        <RNView style={[styles.chip, isRTL ? { left: 20 } : { right: 20 }]}>
          <Text numberOfLines={1} style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 17 }}>{category}</Text>
        </RNView>
      ) : null}
      <RNView style={styles.bottom}>
        <Text numberOfLines={2} style={{ color: white, fontFamily: fontFamilyFor(language, 'bold'), fontSize: 22, lineHeight: language === 'fa' ? 34 : 28, textAlign: align }}>{title}</Text>
        {showSnippet ? <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.8)', fontFamily: fontFamilyFor(language), fontSize: 16, marginTop: 4, textAlign: align }}>{snippet}</Text> : null}
        <RNView style={[styles.footer, { flexDirection: rowOf(isRTL) }]}>
          {entries.length > 1 ? (
            <RNPressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setIndex((i) => (i + 1) % entries.length)}
              style={styles.back}
            >
              <Feather name={isRTL ? 'chevron-right' : 'chevron-left'} size={20} color={white} />
            </RNPressable>
          ) : <RNView />}
          <RNView style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 8 }}>
            <Feather name="calendar" size={18} color="rgba(255,255,255,0.85)" />
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontFamily: fontFamilyFor(language, 'medium'), fontSize: 16 }}>{date}</Text>
          </RNView>
        </RNView>
      </RNView>
    </RNPressable>
  );
}

const styles = StyleSheet.create({
  card: { height: 196, borderRadius: 30, overflow: 'hidden', marginBottom: 18, justifyContent: 'flex-end' },
  chip: { position: 'absolute', top: 18, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 999, paddingHorizontal: 22, paddingVertical: 10, maxWidth: '75%' },
  bottom: { paddingHorizontal: 22, paddingBottom: 18 },
  footer: { alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  back: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
});
