import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Avatar } from '@/components/partner/Avatar';
import { BackButton, Button, Card, Field, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { formatDate, type CalendarKind } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { pickAvatar } from '@/src/partner/avatar';
import { isoToParts, parseTypedInt, partsToIso } from '@/src/partner/birthday';
import { FEATURES } from '@/src/constants/features';
import { sendProfile } from '@/src/partner/manage';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { refreshWidget } from '@/src/widget/refresh';

const SENT: Record<'sent' | 'avatar-dropped' | 'photo-failed' | 'not-paired' | 'failed', TranslationKey> = {
  sent: 'profileSavedSent',
  'avatar-dropped': 'profileAvatarDropped',
  'photo-failed': 'profilePhotoNotShared',
  'not-paired': 'profileSaved',
  failed: 'profileSendFailed',
};

/** Partner's profile (received) and my own (edited here and sent to the partner). */
export default function PartnerProfileScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const { calendarMode, digits } = useSettingsStore();
  const kind: CalendarKind = calendarMode === 'gregorian' ? 'gregorian' : 'jalali';
  const { me, partner, paired, setMe, togetherSince, setTogetherSince } = usePartnerStore();
  const start = me.birthday ? isoToParts(kind, me.birthday) : null;
  const [name, setName] = useState(me.name ?? '');
  const [avatar, setAvatar] = useState(me.avatarB64);
  const [year, setYear] = useState(start ? String(start.year) : '');
  const [month, setMonth] = useState(start ? String(start.month) : '');
  const [day, setDay] = useState(start ? String(start.day) : '');
  const tStart = togetherSince ? isoToParts(kind, togetherSince) : null;
  const [ty, setTy] = useState(tStart ? String(tStart.year) : '');
  const [tm, setTm] = useState(tStart ? String(tStart.month) : '');
  const [td, setTd] = useState(tStart ? String(tStart.day) : '');
  const [togetherNotice, setTogetherNotice] = useState<{ key: TranslationKey; tone: 'ok' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: TranslationKey; tone: 'ok' | 'error' } | null>(null);

  const save = async () => {
    const typed = [year, month, day].some((x) => x.trim() !== '');
    // brief rule 4: the birthday is typed in the chosen calendar but stored as a UTC Gregorian ISO date
    const birthday = typed ? partsToIso(kind, { year: parseTypedInt(year), month: parseTypedInt(month), day: parseTypedInt(day) }) : undefined;
    if (typed && !birthday) return setNotice({ key: 'profileBadDate', tone: 'error' });
    setMe({ name: name.trim() || undefined, avatarB64: avatar, birthday: birthday ?? undefined });
    setBusy(true);
    const res = FEATURES.partner && paired ? await sendProfile(false) : 'not-paired';
    setBusy(false);
    setNotice({ key: SENT[res], tone: res === 'failed' ? 'error' : 'ok' });
  };

  const saveTogether = () => {
    const typed = [ty, tm, td].some((x) => x.trim() !== '');
    const iso = typed ? partsToIso(kind, { year: parseTypedInt(ty), month: parseTypedInt(tm), day: parseTypedInt(td) }) : undefined;
    if (typed && !iso) return setTogetherNotice({ key: 'profileBadDate', tone: 'error' });
    setTogetherSince(iso ?? undefined);
    void refreshWidget();
    setTogetherNotice({ key: 'profileSaved', tone: 'ok' });
  };

  const label = (key: TranslationKey) => (
    <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 12, marginBottom: 6, textAlign: alignOf(isRTL) }}>{t(key)}</Text>
  );

  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="partnerProfile" />
      {FEATURES.partner ? (
        <Card>
          {label('profilePartner')}
          {paired && partner ? (
            <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 14 }}>
              <Avatar b64={partner.avatarB64} photo={partner.avatarPhoto} name={partner.name} size={56} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 17, textAlign: alignOf(isRTL) }}>
                  {partner.name || t('profileNoName')}
                </Text>
                {partner.birthday ? (
                  <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 13, textAlign: alignOf(isRTL) }}>
                    {formatDate(partner.birthday, calendarMode, language, digits)}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : (
            <Notice>{t(paired ? 'profilePartnerWaiting' : 'partnerStatusNone')}</Notice>
          )}
        </Card>
      ) : null}
      <Card>
        {label('profileMine')}
        <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <Avatar b64={avatar} name={name} size={56} />
          <View style={{ flex: 1, gap: 8 }}>
            <Button title="profilePick" onPress={() => void pickAvatar().then((b) => b && setAvatar(b))} />
            {avatar ? <Button title="profileRemovePhoto" destructive onPress={() => setAvatar(undefined)} /> : null}
          </View>
        </View>
        <Field label="profileName" value={name} onChange={setName} />
        {label('profileBirthday')}
        <View style={{ flexDirection: rowOf(isRTL), gap: 8 }}>
          <View style={{ flex: 1.4 }}><Field label="profileYear" value={year} onChange={setYear} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Field label="profileMonth" value={month} onChange={setMonth} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Field label="profileDay" value={day} onChange={setDay} keyboardType="number-pad" /></View>
        </View>
        <Notice>{t('profileBirthdayHint')}</Notice>
        {notice ? <Notice tone={notice.tone}>{t(notice.key)}</Notice> : null}
        <Button title="profileSave" primary busy={busy} onPress={() => void save()} />
      </Card>
      <Card>
        {label('togetherTitle')}
        <View style={{ flexDirection: rowOf(isRTL), gap: 8 }}>
          <View style={{ flex: 1.4 }}><Field label="profileYear" value={ty} onChange={setTy} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Field label="profileMonth" value={tm} onChange={setTm} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Field label="profileDay" value={td} onChange={setTd} keyboardType="number-pad" /></View>
        </View>
        <Notice>{t('togetherHint')}</Notice>
        {togetherNotice ? <Notice tone={togetherNotice.tone}>{t(togetherNotice.key)}</Notice> : null}
        <Button title="togetherSave" onPress={saveTogether} />
      </Card>
    </ScreenFrame>
  );
}
