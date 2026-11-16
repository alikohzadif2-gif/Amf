import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Avatar } from '@/components/partner/Avatar';
import { MediaSourceSheet } from '@/components/media/MediaSourceSheet';
import { SettingGroup } from '@/components/settings/SettingRows';
import { Button, Notice } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { DateWheel } from '@/components/ui/DateWheel';
import { Input, ScreenHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import type { CalendarKind } from '@/src/lib/calendar';
import { birthdayToIso, clampDay, cleanName, defaultBirthdayParts } from '@/src/lib/onboarding';
import { isoToParts, type DateParts } from '@/src/partner/birthday';
import { discardAvatar, pickAvatarFrom, type AvatarSource } from '@/src/partner/avatar';
import { FEATURES } from '@/src/constants/features';
import { getLastShareReason, sendProfile } from '@/src/partner/manage';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { refreshWidget } from '@/src/widget/refresh';
import { alignOf, rowOf } from '@/src/lib/layout';

function profileCalendar(mode: 'jalali' | 'gregorian' | 'both'): CalendarKind {
  return mode === 'gregorian' ? 'gregorian' : 'jalali';
}

export default function ProfileSettingsScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const calendarMode = useSettingsStore((state) => state.calendarMode);
  const me = usePartnerStore((state) => state.me);
  const togetherSince = usePartnerStore((state) => state.togetherSince);
  const kind = profileCalendar(calendarMode);
  const now = useMemo(() => new Date(), []);

  const [ready, setReady] = useState(() => usePartnerStore.persist.hasHydrated());
  const [name, setName] = useState(me.name ?? '');
  const [avatar, setAvatar] = useState(me.avatarB64);
  const [avatarUri, setAvatarUri] = useState(me.avatarUri);
  const [birthdayParts, setBirthdayParts] = useState<DateParts>(() =>
    (me.birthday && isoToParts(kind, me.birthday)) || defaultBirthdayParts(kind, now),
  );
  const [birthdayEnabled, setBirthdayEnabled] = useState(!!me.birthday);
  const [birthdayTouched, setBirthdayTouched] = useState(!!me.birthday);
  const [togetherParts, setTogetherParts] = useState<DateParts>(() =>
    (togetherSince && isoToParts(kind, togetherSince)) || defaultBirthdayParts(kind, now),
  );
  const [togetherEnabled, setTogetherEnabled] = useState(!!togetherSince);
  const [togetherTouched, setTogetherTouched] = useState(!!togetherSince);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: TranslationKey; tone: 'ok' | 'error' } | null>(null);

  useEffect(() => {
    if (ready) return;
    const restoreDraft = () => {
      const state = usePartnerStore.getState();
      const currentKind = profileCalendar(useSettingsStore.getState().calendarMode);
      const currentTime = new Date();
      setName(state.me.name ?? '');
      setAvatar(state.me.avatarB64);
      setAvatarUri(state.me.avatarUri);
      setBirthdayParts(
        (state.me.birthday && isoToParts(currentKind, state.me.birthday)) ||
          defaultBirthdayParts(currentKind, currentTime),
      );
      setBirthdayEnabled(!!state.me.birthday);
      setBirthdayTouched(!!state.me.birthday);
      setTogetherParts(
        (state.togetherSince && isoToParts(currentKind, state.togetherSince)) ||
          defaultBirthdayParts(currentKind, currentTime),
      );
      setTogetherEnabled(!!state.togetherSince);
      setTogetherTouched(!!state.togetherSince);
      setReady(true);
    };
    const off = usePartnerStore.persist.onFinishHydration(restoreDraft);
    if (usePartnerStore.persist.hasHydrated()) restoreDraft();
    return off;
  }, [ready]);

  const birthdayIso =
    birthdayEnabled && birthdayTouched ? birthdayToIso(kind, birthdayParts, now) : null;
  const togetherIso =
    togetherEnabled && togetherTouched ? birthdayToIso(kind, togetherParts, now) : null;
  const birthdayInvalid = birthdayEnabled && birthdayTouched && !birthdayIso;
  const togetherInvalid = togetherEnabled && togetherTouched && !togetherIso;

  const updateBirthday = (parts: DateParts) => {
    setBirthdayParts(clampDay(kind, parts));
    setBirthdayTouched(true);
    setNotice(null);
  };
  const updateTogether = (parts: DateParts) => {
    setTogetherParts(clampDay(kind, parts));
    setTogetherTouched(true);
    setNotice(null);
  };
  const startBirthday = () => {
    setBirthdayParts(defaultBirthdayParts(kind, now));
    setBirthdayEnabled(true);
    setBirthdayTouched(false);
  };
  const startTogetherDate = () => {
    setTogetherParts(defaultBirthdayParts(kind, now));
    setTogetherEnabled(true);
    setTogetherTouched(false);
  };

  const choosePhoto = async (source: AvatarSource | 'files') => {
    if (source === 'files') return;
    setNotice(null);
    setPhotoBusy(true);
    const result = await pickAvatarFrom(source);
    setPhotoBusy(false);
    if (result.b64) {
      if (avatarUri && avatarUri !== usePartnerStore.getState().me.avatarUri) discardAvatar(avatarUri); // an unsaved earlier pick
      setAvatar(result.b64);
      setAvatarUri(result.fullUri);
    }
    else if (result.error) {
      setNotice({
        key: result.error === 'permission-camera' ? 'onboardingPhotoPermission' : 'onboardingPhotoFailed',
        tone: 'error',
      });
    }
  };

  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (birthdayInvalid || togetherInvalid) {
      setNotice({ key: 'profileBadDate', tone: 'error' });
      return;
    }
    const state = usePartnerStore.getState();
    const nextBirthday = birthdayEnabled
      ? birthdayTouched
        ? birthdayIso ?? undefined
        : state.me.birthday
      : undefined;
    const nextTogetherSince = togetherEnabled
      ? togetherTouched
        ? togetherIso ?? undefined
        : state.togetherSince
      : undefined;

    // R10c: a new or removed photo clears the stored server path; sendProfile uploads the sharper copy and fills it again.
    const photoChanged = avatar !== state.me.avatarB64 || avatarUri !== state.me.avatarUri;
    if (photoChanged && state.me.avatarUri && state.me.avatarUri !== avatarUri) discardAvatar(state.me.avatarUri);
    state.setMe({
      ...state.me,
      name: cleanName(name) || undefined,
      avatarB64: avatar,
      avatarUri: avatar ? avatarUri : undefined,
      avatarPhoto: avatar && !photoChanged ? state.me.avatarPhoto : undefined,
      birthday: nextBirthday,
    });
    state.setTogetherSince(nextTogetherSince);
    void refreshWidget();
    if (FEATURES.partner && state.paired) {
      // R10c: a changed name/photo reaches the partner now (the sharper photo is uploaded first, which can take a moment).
      setSaving(true);
      const res = await sendProfile(false);
      setSaving(false);
      if (res === 'photo-failed') Alert.alert(`${t('profilePhotoNotShared')}\n\n(${getLastShareReason()})`); // Q1: says why (connection, file, upload:<status>)
      setNotice({ key: res === 'failed' ? 'profileSendFailed' : res === 'avatar-dropped' ? 'profileAvatarDropped' : 'profileSavedSent', tone: res === 'failed' ? 'error' : 'ok' });
      return;
    }
    setNotice({ key: 'profileSavedLocal', tone: 'ok' });
  };

  return (
    <View style={styles.screen}>
      <ScreenFrame scroll>
        <ScreenHeader title={t('profileEdit')} />
        <Notice>{t('profileLocalOnly')}</Notice>

        <SettingGroup title="profileMine">
          <Input
            value={name}
            onChangeText={(value) => {
              setName(value);
              setNotice(null);
            }}
            placeholder={t('profileName')}
            icon="user"
            autoCapitalize="words"
            maxLength={40}
            editable={ready}
            accessibilityLabel={t('profileName')}
          />
          <View style={[styles.photoRow, { flexDirection: rowOf(isRTL) }]}>
            <Avatar b64={avatar} uri={avatarUri} name={name} size={72} />
            <View style={styles.photoActions}>
              <Button
                title="profilePick"
                variant="outline"
                icon="camera"
                busy={photoBusy}
                disabled={!ready}
                onPress={() => setSheetVisible(true)}
              />
              {avatar ? (
                <Button
                  title="profileRemovePhoto"
                  destructive
                  compact
                  disabled={!ready}
                  onPress={() => {
                    if (avatarUri && avatarUri !== me.avatarUri) discardAvatar(avatarUri);
                    setAvatar(undefined);
                    setAvatarUri(undefined);
                  }}
                />
              ) : null}
            </View>
          </View>
        </SettingGroup>

        <SettingGroup title="profileBirthday">
          {birthdayEnabled ? (
            <>
              <DateWheel
                kind={kind}
                parts={birthdayParts}
                now={now}
                onChange={updateBirthday}
              />
              <Text style={[styles.hint, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>
                {t('profileBirthdayHint')}
              </Text>
              <Button
                title="profileDateRemove"
                variant="dark"
                destructive
                compact
                onPress={() => {
                  setBirthdayEnabled(false);
                  setBirthdayTouched(false);
                }}
              />
            </>
          ) : (
            <>
              <Text style={[styles.hint, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>
                {t('profileNoDate')}
              </Text>
              <Button title="profileDateAdd" variant="outline" compact onPress={startBirthday} />
            </>
          )}
        </SettingGroup>

        <SettingGroup title="togetherTitle">
          {togetherEnabled ? (
            <>
              <DateWheel
                kind={kind}
                parts={togetherParts}
                now={now}
                onChange={updateTogether}
              />
              <Text style={[styles.hint, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>
                {t('profileDateHint')}
              </Text>
              <Button
                title="profileDateRemove"
                variant="dark"
                destructive
                compact
                onPress={() => {
                  setTogetherEnabled(false);
                  setTogetherTouched(false);
                }}
              />
            </>
          ) : (
            <>
              <Text style={[styles.hint, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>
                {t('profileNoDate')}
              </Text>
              <Button title="profileDateAdd" variant="outline" compact onPress={startTogetherDate} />
            </>
          )}
        </SettingGroup>

        {notice ? <Notice tone={notice.tone}>{t(notice.key)}</Notice> : null}
        <Button
          title="profileSaveLocal"
          primary
          busy={saving}
          disabled={!ready || photoBusy || saving}
          onPress={() => void save()}
        />
      </ScreenFrame>

      <MediaSourceSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        onSelect={(source) => void choosePhoto(source)}
        title={t('profilePick')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  photoRow: { alignItems: 'center', gap: 14 },
  photoActions: { flex: 1, gap: 8 },
  hint: { fontSize: 13, lineHeight: 21, marginHorizontal: 4 },
});
