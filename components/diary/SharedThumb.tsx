import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Alert, Modal, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { DownloadBar } from '@/components/diary/DownloadBar';
import { cancelPartnerOriginal, deleteSharedForBoth, deleteSharedForMe, partnerOriginalStatus, requestPartnerOriginal, sharedImage, syncStatusForRef } from '@/src/partner/manage';
import { isVideoName, type OriginalOutcome } from '@/src/partner/orig-logic';
import { usePartnerMediaVersion } from '@/src/partner/media-version';
import type { ImageRef } from '@/src/storage/types';

const toSource = (ref: ImageRef | null) => (ref ? (ref.headers ? { uri: ref.uri, headers: ref.headers } : { uri: ref.uri }) : null);

/** A file the partner shared with a memory (`Shared/<id>/...`), read from the server. Nothing is added to the Library. */
export function SharedThumb({ path, style, size = 'thumb', onPress }: { path: string; style?: ViewStyle; size?: 'thumb' | 'preview'; onPress?: () => void }) {
  const colors = useColors();
  const [remote, setRemote] = useState<ImageRef | null>(null);
  const mediaVersion = usePartnerMediaVersion((s) => s.version); // a picture of the partner arrived: look again

  useEffect(() => setRemote(null), [path, size]); // another file: never show the old picture
  useEffect(() => {
    let alive = true;
    void sharedImage(path, size).then((ref) => alive && setRemote(ref));
    return () => {
      alive = false;
    };
  }, [path, size, mediaVersion]);

  const source = toSource(remote);
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={[styles.box, { backgroundColor: colors.muted }, style]}>
      {source ? <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} /> : null}
    </Pressable>
  );
}

const ORIG_MESSAGE: Partial<Record<OriginalOutcome, TranslationKey>> = {
  offline: 'origOffline',
  missing: 'origMissing',
  'too-big': 'origTooBig',
  space: 'origSpace',
  cache: 'origCache',
  hash: 'origHash',
  'no-keys': 'origNoKeys',
  order: 'origFail',
  size: 'origFail',
  io: 'origFail',
  send: 'origFail',
};

/** A downloaded shared video, played from the private cache file with the system controls. */
function SharedVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls contentFit="contain" />;
}

/**
 * Full-screen view of one shared photo or video; tap anywhere or press back to close. For a photo of the partner that arrived as a small
 * encrypted picture, "Full quality" asks the partner's phone for the original (stage 6). It needs that phone to be online.
 */
export function SharedViewer({ path, onClose }: { path: string | null; onClose: () => void }) {
  const colors = useColors();
  const { language, t } = useI18n();
  const [remote, setRemote] = useState<ImageRef | null>(null);
  const [status, setStatus] = useState<'cached' | 'available' | 'none'>('none');
  const [busy, setBusy] = useState<number | null>(null); // null = idle, else percent
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [sync, setSync] = useState<{ known: boolean; onBoth: boolean }>({ known: false, onBoth: false });
  const mediaVersion = usePartnerMediaVersion((s) => s.version);

  useEffect(() => {
    setRemote(null);
    setBusy(null);
    setNotice(null);
  }, [path]);
  useEffect(() => {
    let alive = true;
    if (path) {
      void partnerOriginalStatus(path).then((value) => alive && setStatus(value));
      void syncStatusForRef(path).then((value) => alive && setSync(value));
    }
    return () => {
      alive = false;
    };
  }, [path, mediaVersion]);
  useEffect(() => {
    let alive = true;
    if (path) void sharedImage(path, status === 'cached' ? 'original' : 'preview').then((ref) => alive && setRemote(ref));
    return () => {
      alive = false;
    };
  }, [path, status, mediaVersion]);

  const fetchOriginal = async () => {
    if (!path || busy !== null) return;
    setNotice(null);
    setBusy(0);
    const outcome = await requestPartnerOriginal(path, (done, total) => setBusy(Math.round((done / total) * 100)));
    setBusy(null);
    if (outcome !== 'ok' && outcome !== 'cancelled') setNotice(ORIG_MESSAGE[outcome] ?? 'origFail');
  };

  // Two kinds of delete (stage 7). "For both" asks again and says plainly that the sender's own file is not deleted.
  const askDelete = () => {
    if (!path) return;
    const confirmMe = () =>
      Alert.alert(t('syncDeleteMe'), t('syncDeleteMeBody'), [
        { text: t('origCancel'), style: 'cancel' },
        { text: t('syncDeleteMe'), style: 'destructive', onPress: () => void deleteSharedForMe(path).then(onClose) },
      ]);
    const confirmBoth = () =>
      Alert.alert(t('syncDeleteBothTitle'), t('syncDeleteBothBody'), [
        { text: t('origCancel'), style: 'cancel' },
        {
          text: t('syncDeleteBoth'),
          style: 'destructive',
          onPress: () =>
            void deleteSharedForBoth(path).then((result) => {
              if (result === 'unknown') setNotice('syncDeleteUnknown');
              else {
                if (result === 'unsent') setNotice('syncDeleteUnsent');
                onClose();
              }
            }),
        },
      ]);
    Alert.alert(t('syncDeleteMenu'), undefined, [
      { text: t('syncDeleteMe'), onPress: confirmMe },
      { text: t('syncDeleteBoth'), style: 'destructive', onPress: confirmBoth },
      { text: t('origCancel'), style: 'cancel' },
    ]);
  };

  const video = !!path && isVideoName(path);
  const source = toSource(remote);
  const font = fontFamilyFor(language, 'semibold');
  return (
    <Modal visible={!!path} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.viewer} onPress={onClose}>
        {video && status === 'cached' && remote ? <SharedVideo uri={remote.uri} /> : source ? <Image source={source} style={StyleSheet.absoluteFill} contentFit="contain" /> : <View />}
        {path && (sync.known || status !== 'none') ? (
          <View style={styles.top} pointerEvents="box-none">
            {sync.onBoth ? <Text style={[styles.badge, { fontFamily: font }]}>{t('syncOnBoth')}</Text> : <View />}
            <Pressable accessibilityRole="button" accessibilityLabel={t('syncDeleteMenu')} onPress={askDelete} style={styles.trash}>
              <Feather name="trash-2" size={20} color="#FFFFFF" />
            </Pressable>
          </View>
        ) : null}
        {path && status === 'available' ? (
          <View style={styles.bar} pointerEvents="box-none">
            {notice ? <Text style={[styles.notice, { fontFamily: font }]}>{t(notice)}</Text> : null}
            {busy === null ? (
              <Pressable accessibilityRole="button" onPress={() => void fetchOriginal()} style={[styles.button, { backgroundColor: colors.primary }]}>
                <Text style={[styles.buttonText, { fontFamily: font }]}>{t(video ? 'origDownload' : 'origFull')}</Text>
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" onPress={() => cancelPartnerOriginal(path)} style={[styles.button, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                <Text style={[styles.buttonText, { fontFamily: font }]}>{`${t('origLoading')} ${busy}%  ·  ${t(video ? 'origPause' : 'origCancel')}`}</Text>
              </Pressable>
            )}
          </View>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden' },
  viewer: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', top: 48, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: { color: '#FFFFFF', fontSize: 12.5, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, overflow: 'hidden' },
  trash: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  bar: { position: 'absolute', left: 16, right: 16, bottom: 32, alignItems: 'stretch', gap: 10 },
  button: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, alignSelf: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 14 },
  notice: { color: '#FFFFFF', fontSize: 13, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
});
