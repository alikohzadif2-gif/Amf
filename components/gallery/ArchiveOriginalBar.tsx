import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ORIG_MESSAGE } from '@/components/diary/SharedThumb';
import { useColors } from '@/hooks/useColors';
import { partnerOnlyItemId } from '@/src/gallery/archive-source-logic';
import { galleryRef } from '@/src/gallery/gallery-ref';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import type { LibraryEntry } from '@/src/library/merge';
import { sourceKinds } from '@/src/library/providers';
import { cancelPartnerOriginal, partnerOriginalStatus, requestPartnerOriginal } from '@/src/partner/manage';
import { usePartnerMediaVersion } from '@/src/partner/media-version';

/** The `Shared/<id>/<name>` ref of an Archive/Explore entry that lives only in the partner's gallery; null for any other entry. */
export function partnerRefOfEntry(entry: LibraryEntry): string | null {
  const id = partnerOnlyItemId(entry.refs, sourceKinds());
  return id ? galleryRef(id, entry.item.name) : null;
}

/**
 * Shared gallery, stage 5: in the swipe viewer, a file that came from the partner's gallery and has only its small picture on this phone gets
 * the same "Full quality" / "Download video" button as the partner's gallery screen (the existing original request: size-checked, resumable,
 * needs the partner's phone online). Nothing is shown for a file whose original is already here or that also exists in the vault.
 */
export function ArchiveOriginalBar({ entry }: { entry: LibraryEntry }) {
  const colors = useColors();
  const { language, t } = useI18n();
  const version = usePartnerMediaVersion((s) => s.version);
  const ref = partnerRefOfEntry(entry);
  const [status, setStatus] = useState<'cached' | 'available' | 'none'>('none');
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<TranslationKey | null>(null);

  useEffect(() => {
    let alive = true;
    setNotice(null);
    if (ref) void partnerOriginalStatus(ref).then((value) => alive && setStatus(value));
    else setStatus('none');
    return () => {
      alive = false;
    };
  }, [ref, version]);

  if (!ref || status !== 'available') return null;
  const video = entry.item.type === 'video';
  const font = fontFamilyFor(language, 'semibold');
  const fetchOriginal = async () => {
    if (busy !== null) return;
    setNotice(null);
    setBusy(0);
    const outcome = await requestPartnerOriginal(ref, (done, total) => setBusy(Math.round((done / total) * 100)));
    setBusy(null);
    if (outcome !== 'ok' && outcome !== 'cancelled') setNotice(ORIG_MESSAGE[outcome] ?? 'origFail');
  };
  return (
    <View style={styles.bar} pointerEvents="box-none">
      {notice ? <Text style={[styles.notice, { fontFamily: font }]}>{t(notice)}</Text> : null}
      {busy === null ? (
        <Pressable accessibilityRole="button" onPress={() => void fetchOriginal()} style={[styles.button, { backgroundColor: colors.primary }]}>
          <Text style={[styles.buttonText, { fontFamily: font }]}>{t(video ? 'origDownload' : 'origFull')}</Text>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => cancelPartnerOriginal(ref)} style={[styles.button, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
          <Text style={[styles.buttonText, { fontFamily: font }]}>{`${t('origLoading')} ${busy}%  ·  ${t(video ? 'origPause' : 'origCancel')}`}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 16, right: 16, bottom: 32, alignItems: 'stretch', gap: 10 },
  button: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, alignSelf: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 14 },
  notice: { color: '#FFFFFF', fontSize: 13, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
});
