import { Feather } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Avatar } from '@/components/partner/Avatar';
import { OnboardingFrame } from '@/components/onboarding/OnboardingFrame';
import { MediaSourceSheet } from '@/components/media/MediaSourceSheet';
import { Notice } from '@/components/server/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { discardAvatar, pickAvatarFrom, type AvatarSource } from '@/src/partner/avatar';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

const SIZE = 250;

/**
 * Step 4 of 4 — photo (reference 08): big circle avatar with a coral camera badge; the badge opens the Camera / Gallery sheet.
 * The photo is shrunk to the 64 px profile avatar (src/partner/avatar.ts) and kept in my local profile — nothing is published.
 * The photo is optional. Finishing sets `onboarded`, which swaps the first-run screens for the tabs (app/_layout.tsx).
 */
export default function OnboardingPhotoScreen() {
  const colors = useColors();
  const { language, t } = useI18n();
  const me = usePartnerStore((s) => s.me);
  const setMe = usePartnerStore((s) => s.setMe);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const [avatar, setAvatar] = useState<string | undefined>(me.avatarB64);
  const [avatarUri, setAvatarUri] = useState<string | undefined>(me.avatarUri);
  // Sharp picture shown right after picking (the picker's own file); the 64 px photo would look blurry at this size.
  const [previewUri, setPreviewUri] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);

  const choose = async (source: AvatarSource | 'files') => {
    if (source === 'files') return;
    setError(null);
    setBusy(true);
    const res = await pickAvatarFrom(source);
    setBusy(false);
    if (res.b64) {
      if (avatarUri && avatarUri !== me.avatarUri) discardAvatar(avatarUri);
      setAvatar(res.b64);
      setAvatarUri(res.fullUri);
      setPreviewUri(res.previewUri);
    }
    else if (res.error) setError(res.error === 'permission-camera' ? 'onboardingPhotoPermission' : 'onboardingPhotoFailed');
  };

  const finish = () => {
    const changed = avatar !== me.avatarB64 || avatarUri !== me.avatarUri;
    if (changed && me.avatarUri && me.avatarUri !== avatarUri) discardAvatar(me.avatarUri);
    setMe({ ...me, avatarB64: avatar, avatarUri: avatar ? avatarUri : undefined, avatarPhoto: changed ? undefined : me.avatarPhoto });
    setSetting('onboarded', true);
  };

  return (
    <OnboardingFrame step="photo" title={t('onboardingPhotoTitle')} subtitle={t('onboardingPhotoSubtitle')} nextTitle="onboardingFinish" nextDisabled={busy} onNext={finish} overlay={<MediaSourceSheet visible={sheet} onClose={() => setSheet(false)} onSelect={(s) => void choose(s)} />}>
      <View style={styles.center}>
        <View style={[styles.circle, { backgroundColor: colors.card, borderColor: colors.track }]}>
          {avatar ? (
            <Avatar b64={avatar} uri={previewUri ?? avatarUri} name={me.name} size={SIZE - 8} />
          ) : (
            <Feather name="user" size={92} color={colors.mutedForeground} />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mediaSourceTitle')}
            disabled={busy}
            onPress={() => setSheet(true)}
            style={({ pressed }) => [styles.badge, { backgroundColor: pressed ? colors.primaryPressed : colors.primary, borderColor: colors.background, end: 0 }]}
          >
            <Feather name="camera" size={26} color={colors.primaryForeground} />
          </Pressable>
        </View>
        <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 16, marginTop: 20, textAlign: 'center' }}>
          {t(avatar ? 'onboardingPhotoChange' : 'onboardingPhotoHint')}
        </Text>
        {avatar ? (
          <Pressable accessibilityRole="button" hitSlop={10} onPress={() => {
            if (avatarUri && avatarUri !== me.avatarUri) discardAvatar(avatarUri);
            setAvatar(undefined);
            setAvatarUri(undefined);
            setPreviewUri(undefined);
          }} style={{ marginTop: 12 }}>
            <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15 }}>{t('profileRemovePhoto')}</Text>
          </Pressable>
        ) : null}
        {error ? (
          <View style={{ marginTop: 16, alignSelf: 'stretch' }}>
            <Notice tone="error">{t(error)}</Notice>
          </View>
        ) : null}
      </View>
    </OnboardingFrame>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  circle: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', bottom: 4, width: 76, height: 76, borderRadius: 38, borderWidth: 0, alignItems: 'center', justifyContent: 'center' },
});
