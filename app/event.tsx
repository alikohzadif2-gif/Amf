import { getRandomBytes } from 'expo-crypto';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledView as View } from '@/components/ui/ScaledSurface';
import { EventPhoto } from '@/components/events/EventPhoto';
import { MediaSourceSheet } from '@/components/media/MediaSourceSheet';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Input } from '@/components/ui/Input';
import { SegmentedControl, WheelPicker } from '@/components/ui';
import { ToggleRow } from '@/components/ui/ToggleRow';
import { useColors } from '@/hooks/useColors';
import { discardEventPhoto, pickEventPhoto } from '@/src/events/photo';
import { deleteEvent, eventSyncAction, getEvent, newEventId, parseTags, saveEvent, type EventRow } from '@/src/events/events-db';
import { EVENT_ICONS, DEFAULT_EVENT_ICON, normalizeEventIcon } from '@/src/events/icons';
import { partsIn, todayIso, type EventCal } from '@/src/events/recurrence';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { calendarMonthName, formatDate, toDigits } from '@/src/lib/calendar';
import { clampDay, daysInMonth } from '@/src/lib/onboarding';
import { rowOf } from '@/src/lib/layout';
import { isoToParts, partsToIso, type DateParts } from '@/src/partner/birthday';
import { FEATURES } from '@/src/constants/features';
import { sendEvent, shareFileResult } from '@/src/partner/manage';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

const datePartsIn = (cal: EventCal, iso: string): DateParts => {
  const parts = partsIn(cal, iso);
  return { year: parts.y, month: parts.m, day: parts.d };
};

export default function EventScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const { id, date } = useLocalSearchParams<{ id?: string; date?: string }>();
  const mode = useSettingsStore((s) => s.calendarMode);
  const digits = useSettingsStore((s) => s.digits);
  const bump = usePartnerStore((s) => s.bumpEvents);
  const initialCal: EventCal = mode === 'gregorian' ? 'gregorian' : 'jalali';
  const initialDate = typeof date === 'string' && isoToParts(initialCal, date)
    ? partsToIso(initialCal, isoToParts(initialCal, date)!) ?? todayIso()
    : todayIso();
  const initialParts = isoToParts(initialCal, initialDate) ?? datePartsIn(initialCal, todayIso());

  const [existing, setExisting] = useState<EventRow | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>(id ? 'loading' : 'ready');
  const [cal, setCal] = useState<EventCal>(initialCal);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [surprise, setSurprise] = useState(false);
  const [icon, setIcon] = useState<string>(DEFAULT_EVENT_ICON);
  const [iconsOpen, setIconsOpen] = useState(true);
  const [dateOpen, setDateOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [parts, setParts] = useState<DateParts>(() => initialParts);
  // R2: the photo is a private copy (not in the Library); `photoName` is set only for a photo picked in this session (needs upload)
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newId] = useState(() => newEventId(getRandomBytes));
  const [error, setError] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (!id) {
      setExisting(null);
      setLoadState('ready');
      return;
    }
    let active = true;
    setLoadState('loading');
    setError(null);
    void getEvent(db, id).then((event) => {
      if (!active) return;
      if (!event) {
        setLoadState('failed');
        setError('eventNotFound');
        return;
      }
      const eventParts = partsIn(event.cal, event.date);
      setExisting(event);
      setCal(event.cal);
      setTitle(event.title);
      setDescription(event.description ?? '');
      setTags(event.tags.join(', '));
      setRepeat(event.repeat === 'yearly');
      setSurprise(event.surprise);
      setIcon(normalizeEventIcon(event.icon) ?? DEFAULT_EVENT_ICON);
      setPhotoUri(event.photoUri);
      setParts({ year: eventParts.y, month: eventParts.m, day: eventParts.d });
      setLoadState('ready');
    }).catch(() => {
      if (!active) return;
      setLoadState('failed');
      setError('eventLoadFailed');
    });
    return () => {
      active = false;
    };
  }, [db, id]);

  const iso = partsToIso(cal, parts);
  const yearValues = useMemo(() => {
    const currentYear = partsIn(cal, todayIso()).y;
    const firstYear = Math.min(currentYear - 100, parts.year);
    const lastYear = Math.max(currentYear + 100, parts.year);
    return Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);
  }, [cal, parts.year]);
  const monthValues = useMemo(
    () => Array.from({ length: 12 }, (_, i) => calendarMonthName(cal, i + 1, language)),
    [cal, language],
  );
  const dayCount = daysInMonth(cal, parts.year, parts.month);
  const dateLabel = iso ? formatDate(iso, cal, language, digits) : t('profileBadDate');
  const loadFailed = loadState === 'failed';
  const formDisabled = loadState !== 'ready';

  const updateParts = (next: DateParts) => {
    setParts(clampDay(cal, next));
    if (!formDisabled) setError(null);
  };
  const switchCalendar = (nextCal: EventCal) => {
    if (formDisabled || nextCal === cal) return;
    const selectedDate = partsToIso(cal, parts) ?? todayIso();
    const nextParts = isoToParts(nextCal, selectedDate) ?? datePartsIn(nextCal, todayIso());
    setCal(nextCal);
    setParts(nextParts);
    setError(null);
  };

  const save = async () => {
    if (loadState !== 'ready' || loadFailed) return;
    if (!title.trim()) return setError('eventTitleRequired');
    if (!iso) return setError('profileBadDate');
    const id = existing?.id ?? newId;
    setSaving(true);
    // Photo: a new pick (or an earlier one that never reached the server) is uploaded to Shared/<id>/ first, so the message can carry its path.
    const paired = FEATURES.partner && usePartnerStore.getState().paired;
    let photo = photoUri && photoUri === existing?.photoUri ? existing?.photo ?? null : null;
    let photoFailed = false;
    let photoReason = '';
    if (photoUri && !surprise && paired && (photoName || !photo)) {
      const shared = await shareFileResult(id, photoName ?? photoUri.split('/').pop() ?? 'photo.jpg', photoUri);
      photo = shared.ok ? shared.path : null;
      photoFailed = !shared.ok;
      photoReason = shared.ok ? '' : shared.reason;
    }
    if (existing?.photoUri && existing.photoUri !== photoUri) discardEventPhoto(existing.photoUri);
    const row: EventRow = {
      id,
      title: title.trim(),
      date: iso,
      repeat: repeat ? 'yearly' : null,
      cal,
      tags: parseTags(tags),
      mediaKey: existing?.mediaKey ?? null, // legacy Library attachment of older builds: kept, no longer offered
      fromMe: existing?.fromMe ?? true,
      updatedAt: new Date().toISOString(),
      description: description.trim() || null,
      icon,
      surprise,
      photoUri,
      photo,
    };
    try {
      await saveEvent(db, row);
      bump();
      if (FEATURES.partner) {
        const action = eventSyncAction(existing, row);
        if (action === 'send' && (await sendEvent(row)) === 'failed') Alert.alert(t('eventSavedNotSent'));
        else if (action === 'send' && photoFailed) Alert.alert(`${t('eventPhotoNotShared')}\n\n(${photoReason})`); // Q1: the reason code tells what failed (connection, file, upload:<status>)
        else if (action === 'delete') void sendEvent({ id: row.id, deleted: true });
      }
      router.back();
    } catch {
      setError('eventSaveFailed');
    } finally {
      setSaving(false);
    }
  };

  const remove = () => Alert.alert(t('eventDeleteTitle'), t('eventDeleteBody'), [
    { text: t('cancel'), style: 'cancel' },
    {
      text: t('eventDeleteConfirm'),
      style: 'destructive',
      onPress: async () => {
        if (!existing) return;
        try {
          await deleteEvent(db, existing.id);
          discardEventPhoto(existing.photoUri);
          bump();
          if (FEATURES.partner && eventSyncAction(existing, null) === 'delete') void sendEvent({ id: existing.id, deleted: true });
          router.back();
        } catch {
          Alert.alert(t('eventDeleteFailed'));
        }
      },
    },
  ]);

  const pickMedia = async (source: 'camera' | 'gallery') => {
    const result = await pickEventPhoto(source, existing?.id ?? newId);
    if ('cancelled' in result) return;
    if ('error' in result) return Alert.alert(t(result.error === 'permission-camera' ? 'mediaCameraDenied' : 'mediaPickFailed'));
    // a photo picked earlier in this session and not saved is replaced: drop its copy
    if (photoName && photoUri && photoUri !== existing?.photoUri) discardEventPhoto(photoUri);
    setPhotoUri(result.uri);
    setPhotoName(result.name);
  };
  const removePhoto = () => {
    if (photoName && photoUri && photoUri !== existing?.photoUri) discardEventPhoto(photoUri);
    setPhotoUri(null);
    setPhotoName(null);
  };

  return (
    <View style={{ flex: 1 }}>
      <BottomSheet
        visible
        onClose={() => router.back()}
        title={t(existing ? 'eventEdit' : 'eventNew')}
        cancelLabel={t('cancel')}
        actionLabel={t(existing ? 'eventSave' : 'eventAdd')}
        onAction={() => void save()}
        actionDisabled={loadState !== 'ready' || loadFailed || !title.trim() || !iso || saving}
      >
        <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 24, padding: 14, gap: 10 }}>
          <Input
            value={title}
            onChangeText={(value) => { setTitle(value); if (!formDisabled) setError(null); }}
            placeholder={t('eventTitleField')}
            autoCapitalize="sentences"
            maxLength={120}
            editable={!formDisabled}
          />
          <Input
            value={description}
            onChangeText={setDescription}
            placeholder={t('eventDescription')}
            multiline
            minHeight={72}
            autoCapitalize="sentences"
            maxLength={1000}
            editable={!formDisabled}
          />
        </View>

        <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 24, padding: 14, gap: 14 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: dateOpen }}
            onPress={() => setDateOpen((open) => !open)}
            disabled={formDisabled}
            style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, paddingVertical: 4, opacity: formDisabled ? 0.6 : 1 }}
          >
            <MaterialCommunityIcons name="calendar-month" size={24} color={colors.primary} />
            <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 16, textAlign: isRTL ? 'right' : 'left' }}>
              {t('eventDate')}
            </Text>
            <Text style={{ color: colors.mutedForeground, textAlign: isRTL ? 'left' : 'right' }}>{dateLabel}</Text>
            <MaterialCommunityIcons name={dateOpen ? 'chevron-up' : 'chevron-down'} size={20} color={colors.mutedForeground} />
          </Pressable>

          {dateOpen ? (
            <View style={{ gap: 12 }}>
              <SegmentedControl<EventCal>
                fullWidth
                options={[
                  { value: 'gregorian', label: t('gregorian') },
                  { value: 'jalali', label: t('jalali') },
                ]}
                value={cal}
                onChange={switchCalendar}
              />
              <WheelPicker
                columns={[
                  {
                    key: `year-${cal}-${yearValues[0]}`,
                    label: t('profileYear'),
                    flex: 1.15,
                    items: yearValues.map((year) => toDigits(year, digits)),
                    index: Math.max(0, yearValues.indexOf(parts.year)),
                    onIndexChange: (index) => updateParts({ ...parts, year: yearValues[index] }),
                  },
                  {
                    key: `month-${cal}`,
                    label: t('profileMonth'),
                    flex: 1.4,
                    items: monthValues,
                    index: parts.month - 1,
                    onIndexChange: (index) => updateParts({ ...parts, month: index + 1 }),
                  },
                  {
                    key: `day-${cal}-${dayCount}`,
                    label: t('profileDay'),
                    flex: 0.8,
                    items: Array.from({ length: dayCount }, (_, index) => toDigits(index + 1, digits)),
                    index: parts.day - 1,
                    onIndexChange: (index) => updateParts({ ...parts, day: index + 1 }),
                  },
                ]}
              />
            </View>
          ) : null}

          <View style={{ height: 1, backgroundColor: colors.border }} />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: iconsOpen }}
            onPress={() => setIconsOpen((open) => !open)}
            disabled={formDisabled}
            style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, paddingVertical: 2, opacity: formDisabled ? 0.6 : 1 }}
          >
            <MaterialCommunityIcons name={EVENT_ICONS.find((item) => item.id === icon)?.mci as never} size={24} color={colors.primary} />
            <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 16, textAlign: isRTL ? 'right' : 'left' }}>
              {t('eventIconLabel')}
            </Text>
            <MaterialCommunityIcons name={iconsOpen ? 'chevron-up' : 'chevron-down'} size={20} color={colors.mutedForeground} />
          </Pressable>
          {iconsOpen ? (
            <View style={{ flexDirection: rowOf(isRTL), flexWrap: 'wrap', gap: 8 }}>
              {EVENT_ICONS.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={t(item.label)}
                  accessibilityState={{ selected: icon === item.id }}
                  onPress={() => setIcon(item.id)}
                  disabled={formDisabled}
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: colors.raised,
                    borderWidth: 2,
                    borderColor: icon === item.id ? colors.primary : 'transparent',
                  }}
                >
                  <MaterialCommunityIcons name={item.mci as never} size={26} color={icon === item.id ? colors.primary : colors.mutedForeground} />
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        <ToggleRow title={t('eventRepeatYearly')} value={repeat} onValueChange={setRepeat} icon="repeat" disabled={formDisabled} />
        <ToggleRow title={t('eventSurprise')} subtitle={t('eventSurpriseHidden')} value={surprise} onValueChange={setSurprise} emoji="🤫" disabled={formDisabled} />

        <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 12, gap: 8 }}>
          <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), textAlign: isRTL ? 'right' : 'left' }}>{t('eventPhoto')}</Text>
          {photoUri ? <EventPhoto event={{ photoUri, photo: existing?.photo ?? null }} style={{ width: '100%', height: 160, borderRadius: 14 }} /> : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setMediaOpen(true)}
            disabled={formDisabled}
            style={{ padding: 12, borderRadius: 14, backgroundColor: colors.raised }}
          >
            <Text style={{ color: colors.primary, textAlign: isRTL ? 'right' : 'left' }}>{photoUri ? t('eventPhotoChange') : t('eventPhotoAdd')}</Text>
          </Pressable>
          {photoUri ? (
            <Pressable accessibilityRole="button" onPress={removePhoto} hitSlop={8} disabled={formDisabled}>
              <Text style={{ color: colors.destructive, textAlign: isRTL ? 'right' : 'left' }}>{t('eventPhotoRemove')}</Text>
            </Pressable>
          ) : null}
        </View>

        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.destructive, textAlign: isRTL ? 'right' : 'left' }}>{t(error)}</Text>
        ) : null}
        {existing ? (
          <Pressable accessibilityRole="button" onPress={remove} style={{ padding: 12 }}>
            <Text style={{ color: colors.destructive, textAlign: 'center' }}>{t('eventDelete')}</Text>
          </Pressable>
        ) : null}
      </BottomSheet>
      <MediaSourceSheet
        visible={mediaOpen}
        onClose={() => setMediaOpen(false)}
        onSelect={(source) => { if (source !== 'files') void pickMedia(source); }}
        title={t('eventPhoto')}
      />
    </View>
  );
}
