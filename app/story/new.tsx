import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType, type FlashMode } from 'expo-camera';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withAlpha } from '@/constants/colors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { useSettingsStore } from '@/src/state/settings-store';
import { sendStory } from '@/src/partner/manage';
import { usePartnerStore } from '@/src/state/partner-store';
import { insertStory, purgeExpiredStories } from '@/src/stories/stories-db';
import { discardStoryFiles, saveStoryMedia } from '@/src/stories/story-files';
import {
  STORY_MAX_CAPTION,
  STORY_MAX_OVERLAY,
  STORY_MAX_VIDEO_SECONDS,
  clampOverlayY,
  clockText,
  cleanText,
  expiresAtOf,
  newStoryId,
  type StoryRow,
  type StoryType,
} from '@/src/stories/story-logic';

type Media = { uri: string; type: StoryType; width?: number; capturedAt: string };

/** New story: a camera (photo / video / gallery) and then a small editor (text over the picture, caption). Opened from the Home camera button. */
export default function NewStoryScreen() {
  const [media, setMedia] = useState<Media | null>(null);
  const db = useSQLiteContext();
  const router = useRouter();

  useEffect(() => {
    // Housekeeping: expired stories (and their files) go away whenever the story camera opens.
    void purgeExpiredStories(db).then(discardStoryFiles).catch(() => undefined);
  }, [db]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {media ? <StoryEditor media={media} onBack={() => setMedia(null)} onPosted={() => router.back()} /> : <StoryCamera onClose={() => router.back()} onMedia={setMedia} />}
    </View>
  );
}

function RoundButton({ icon, label, onPress, active }: { icon: keyof typeof Feather.glyphMap; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.round, active ? styles.roundActive : null, { opacity: pressed ? 0.7 : 1 }]}>
      <Feather name={icon} size={22} color="#FFFFFF" />
    </Pressable>
  );
}

function StoryCamera({ onClose, onMedia }: { onClose: () => void; onMedia: (media: Media) => void }) {
  const insets = useSafeAreaInsets();
  // Samsung devices can report a zero bottom inset with some Android navigation modes.
  const safeBottom = Math.max(insets.bottom, Platform.OS === 'android' ? 28 : 0);
  const { language, isRTL, t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const font = (weight: 'medium' | 'semibold' = 'medium') => fontFamilyFor(language, weight);

  if (!permission) return <View style={styles.root} />;
  if (!permission.granted) {
    return (
      <View style={[styles.center, { paddingTop: insets.top, direction: isRTL ? 'rtl' : 'ltr' }]}>
        <Text style={[styles.permText, { fontFamily: font() }]}>{t('storyPermission')}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings())}
          style={styles.permButton}
        >
          <Text style={[styles.permButtonText, { fontFamily: font('semibold') }]}>{t(permission.canAskAgain ? 'cameraAllow' : 'openAppSettings')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10}>
          <Text style={[styles.permText, { fontFamily: font(), marginTop: 18 }]}>{t('cancel')}</Text>
        </Pressable>
      </View>
    );
  }

  const takePhoto = async () => {
    if (busy || !cameraRef.current) return;
    setBusy(true);
    try {
      const pic = await cameraRef.current.takePictureAsync({ quality: 0.9, shutterSound: false });
      if (!pic) throw new Error('no picture');
      onMedia({ uri: pic.uri, type: 'photo', width: pic.width, capturedAt: new Date().toISOString() });
    } catch {
      Alert.alert(t('storyNew'), t('storyPostFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggleRecording = async () => {
    const camera = cameraRef.current;
    if (!camera) return;
    if (recording) {
      camera.stopRecording();
      return;
    }
    const mic = micPermission?.granted ? micPermission : await requestMic();
    setRecording(true);
    try {
      const video = await camera.recordAsync({ maxDuration: STORY_MAX_VIDEO_SECONDS });
      if (video?.uri) onMedia({ uri: video.uri, type: 'video', capturedAt: new Date().toISOString() });
    } catch {
      Alert.alert(t('storyNew'), t('storyPostFailed'));
    } finally {
      setRecording(false);
    }
  };

  const pickFromGallery = async () => {
    try {
      const picker = await import('expo-image-picker');
      const res = await picker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: false, quality: 1, videoMaxDuration: STORY_MAX_VIDEO_SECONDS });
      const asset = res.canceled ? undefined : res.assets[0];
      if (!asset) return;
      const isVideo = asset.type === 'video';
      if (isVideo && (asset.duration ?? 0) > (STORY_MAX_VIDEO_SECONDS + 1) * 1000) {
        Alert.alert(t('storyNew'), t('storyTooLong'));
        return;
      }
      onMedia({ uri: asset.uri, type: isVideo ? 'video' : 'photo', width: asset.width, capturedAt: new Date().toISOString() });
    } catch {
      Alert.alert(t('storyNew'), t('storyPostFailed'));
    }
  };

  const shutter = mode === 'picture' ? () => void takePhoto() : () => void toggleRecording();
  return (
    <View style={styles.root}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} flash={flash} mode={mode} mute />
      <View style={[styles.topBar, { top: insets.top + 8, direction: isRTL ? 'rtl' : 'ltr' }]}>
        <RoundButton icon="x" label={t('storyClose')} onPress={onClose} />
        <View style={styles.topRight}>
          <RoundButton icon={flash === 'on' ? 'zap' : 'zap-off'} label={t('storyFlash')} active={flash === 'on'} onPress={() => setFlash((f) => (f === 'on' ? 'off' : 'on'))} />
          <RoundButton icon="refresh-cw" label={t('storyFlip')} onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} />
        </View>
      </View>
      <View style={[styles.bottom, { paddingBottom: safeBottom + 18, direction: isRTL ? 'rtl' : 'ltr' }]}>
        {recording ? null : (
          <View style={styles.modes}>
            {(['picture', 'video'] as const).map((m) => (
              <Pressable key={m} accessibilityRole="button" accessibilityState={{ selected: mode === m }} onPress={() => setMode(m)} hitSlop={6} style={[styles.modeChip, mode === m ? styles.modeChipOn : null]}>
                <Text style={[styles.modeText, { fontFamily: font('semibold'), opacity: mode === m ? 1 : 0.65 }]}>{t(m === 'picture' ? 'storyPhoto' : 'storyVideo')}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.shutterRow}>
          <View style={styles.side}>
            {recording ? null : <RoundButton icon="image" label={t('storyGallery')} onPress={() => void pickFromGallery()} />}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(mode === 'picture' ? 'storyTakePhoto' : recording ? 'storyRecordStop' : 'storyRecordStart')}
            onPress={shutter}
            disabled={busy}
            style={({ pressed }) => [styles.shutterOuter, { transform: [{ scale: pressed ? 0.94 : 1 }] }]}
          >
            <View style={[styles.shutterInner, mode === 'video' ? styles.shutterVideo : null, recording ? styles.shutterRecording : null]} />
          </Pressable>
          <View style={styles.side} />
        </View>
      </View>
    </View>
  );
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.play();
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />;
}

function StoryEditor({ media, onBack, onPosted }: { media: Media; onBack: () => void; onPosted: () => void }) {
  const insets = useSafeAreaInsets();
  // Keep caption/send above Samsung's 3-button or gesture navigation area (Android 9–16).
  const safeBottom = Math.max(insets.bottom, Platform.OS === 'android' ? 28 : 0);
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const [overlayText, setOverlayText] = useState('');
  const [overlayY, setOverlayY] = useState(0.45);
  const [editingText, setEditingText] = useState(false);
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);
  const heightRef = useRef(1);
  const yRef = useRef(overlayY);
  const startY = useRef(0);
  yRef.current = overlayY;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startY.current = yRef.current;
      },
      onPanResponderMove: (_, g) => setOverlayY(clampOverlayY(startY.current + g.dy / heightRef.current)),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6) setEditingText(true); // a tap, not a drag
      },
    }),
  ).current;
  const font = (weight: 'medium' | 'semibold' | 'bold' = 'medium') => fontFamilyFor(language, weight);

  const post = async () => {
    if (posting) return;
    setPosting(true);
    const id = newStoryId();
    let stored: string | null = null;
    try {
      stored = await saveStoryMedia(media.uri, media.type, id, media.width);
      const story: StoryRow = {
        id,
        fromMe: true,
        type: media.type,
        mediaUri: stored,
        overlayText: cleanText(overlayText, STORY_MAX_OVERLAY),
        overlayY,
        caption: cleanText(caption, STORY_MAX_CAPTION),
        createdAt: media.capturedAt,
        expiresAt: expiresAtOf(media.capturedAt),
        viewedAt: null,
      };
      await insertStory(db, story);
      usePartnerStore.getState().bumpStories();
      void sendStory(story); // best effort: the partner gets it when the upload finishes; the story stays here either way
      onPosted();
    } catch {
      if (stored) discardStoryFiles([stored]);
      setPosting(false);
      Alert.alert(t('storyNew'), t('storyPostFailed'));
    }
  };

  const shownText = cleanText(overlayText, STORY_MAX_OVERLAY);
  return (
    <View style={styles.root} onLayout={(e) => (heightRef.current = Math.max(1, e.nativeEvent.layout.height))}>
      {media.type === 'video' ? <VideoPreview uri={media.uri} /> : <Image source={{ uri: media.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha('#000000', editingText ? 0.55 : 0.08) }]} />

      {shownText && !editingText ? (
        <View {...pan.panHandlers} style={[styles.overlayWrap, { top: `${overlayY * 100}%` }]}>
          <Text style={[styles.overlayText, { fontFamily: font('bold') }]}>{shownText}</Text>
        </View>
      ) : null}

      {editingText ? (
        <View style={[StyleSheet.absoluteFill, styles.textEditor, { direction: isRTL ? 'rtl' : 'ltr' }]}>
          <TextInput
            autoFocus
            multiline
            value={overlayText}
            onChangeText={setOverlayText}
            maxLength={STORY_MAX_OVERLAY}
            placeholder={t('storyTextPlaceholder')}
            placeholderTextColor={withAlpha('#FFFFFF', 0.55)}
            style={[styles.overlayInput, { fontFamily: font('bold') }]}
            textAlign="center"
          />
        </View>
      ) : null}

      <View style={[styles.topBar, { top: insets.top + 8, direction: isRTL ? 'rtl' : 'ltr' }]}>
        <RoundButton icon={editingText ? 'check' : 'x'} label={t(editingText ? 'storyDone' : 'storyBack')} onPress={editingText ? () => setEditingText(false) : onBack} />
        <View style={styles.topRight}>
          <View style={styles.timeChip}>
            <Feather name="clock" size={14} color="#FFFFFF" />
            <Text style={[styles.timeText, { fontFamily: font('semibold') }]}>{toDigits(clockText(media.capturedAt), digits)}</Text>
          </View>
          {editingText ? null : <RoundButton icon="type" label={t('storyAddText')} onPress={() => setEditingText(true)} />}
        </View>
      </View>

      {editingText ? null : (
        <KeyboardAvoidingView behavior="padding" style={[styles.captionArea, { bottom: safeBottom + 14, direction: isRTL ? 'rtl' : 'ltr' }]}>
          <Text style={[styles.hint, { fontFamily: font() }]}>{t('storyValidFor')}</Text>
          <View style={styles.captionRow}>
            <TextInput
              value={caption}
              onChangeText={setCaption}
              maxLength={STORY_MAX_CAPTION}
              placeholder={t('storyCaptionPlaceholder')}
              placeholderTextColor={withAlpha('#FFFFFF', 0.6)}
              style={[styles.captionInput, { fontFamily: font(), textAlign: isRTL ? 'right' : 'left' }]}
              multiline
            />
            <Pressable accessibilityRole="button" accessibilityLabel={t('storyPost')} disabled={posting} onPress={() => void post()} style={({ pressed }) => [styles.send, { opacity: pressed || posting ? 0.7 : 1 }]}>
              {posting ? <ActivityIndicator color="#FFFFFF" /> : <Feather name="send" size={22} color="#FFFFFF" style={{ transform: [{ scaleX: isRTL ? -1 : 1 }] }} />}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  center: { flex: 1, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center', padding: 28 },
  permText: { color: '#FFFFFF', fontSize: 16, textAlign: 'center' },
  permButton: { marginTop: 20, backgroundColor: '#FF6B6B', borderRadius: 24, paddingHorizontal: 26, paddingVertical: 12 },
  permButtonText: { color: '#FFFFFF', fontSize: 16 },
  topBar: { position: 'absolute', left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  round: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(0,0,0,0.38)', alignItems: 'center', justifyContent: 'center' },
  roundActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 16 },
  modes: { flexDirection: 'row', gap: 8 },
  modeChip: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 16 },
  modeChipOn: { backgroundColor: 'rgba(0,0,0,0.4)' },
  modeText: { color: '#FFFFFF', fontSize: 14 },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingHorizontal: 30 },
  side: { width: 52, alignItems: 'center' },
  shutterOuter: { width: 82, height: 82, borderRadius: 41, borderWidth: 4, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#FFFFFF' },
  shutterVideo: { backgroundColor: '#FF4D4D' },
  shutterRecording: { width: 34, height: 34, borderRadius: 8 },
  overlayWrap: { position: 'absolute', left: 20, right: 20, alignItems: 'center', transform: [{ translateY: -24 }] },
  overlayText: { color: '#FFFFFF', fontSize: 28, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
  textEditor: { justifyContent: 'center', paddingHorizontal: 24 },
  overlayInput: { color: '#FFFFFF', fontSize: 28, textAlign: 'center', maxHeight: 260 },
  timeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.38)', borderRadius: 18, paddingHorizontal: 12, height: 36 },
  timeText: { color: '#FFFFFF', fontSize: 13 },
  captionArea: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, gap: 8 },
  hint: { color: 'rgba(255,255,255,0.8)', fontSize: 12, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  captionRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  captionInput: { flex: 1, minHeight: 46, maxHeight: 110, color: '#FFFFFF', fontSize: 15, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 24, paddingHorizontal: 18, paddingVertical: 12 },
  send: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#FF6B6B', alignItems: 'center', justifyContent: 'center' },
});
