import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { Text } from '@/components/ui/ScaledText';
import { Avatar } from '@/components/partner/Avatar';
import { Button, Card, Notice } from '@/components/server/ui';
import { PeriodEntry } from '@/components/period/PeriodEntry';
import { ActivityTile, ACTIVITY_TILE_HEIGHT } from '@/components/status/ActivityTile';
import { StatusItemSheet, type ItemSheetResult, type ItemSheetTarget } from '@/components/status/StatusItemSheet';
import { CategoryChips } from '@/components/status/CategoryChips';
import { CategorySheet, type CategorySheetTarget } from '@/components/status/CategorySheet';
import { HistorySheet } from '@/components/status/HistorySheet';
import { HScroll } from '@/components/status/HScroll';
import { MoodCard, StickyHeader } from '@/components/status/StickyMoodCard';
import { MOOD_TILE, MOOD_TILE_GAP, MoodTile } from '@/components/status/MoodTile';
import { SearchRow } from '@/components/status/SearchRow';
import { Fab, SectionLabel, Toast } from '@/components/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { TokenNotAcceptedNotice } from '@/components/server/TokenNotAcceptedNotice';
import { FEATURES } from '@/src/constants/features';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { ACTIVITIES, type ActivityCategoryId } from '@/src/partner/activities';
import { clearMood, sendMood } from '@/src/partner/manage';
import { latestMood, recentUsed, saveMoodLocal } from '@/src/partner/mood-db';
import { MOODS, type MoodCategoryId } from '@/src/partner/moods';
import { moodColorsFor } from '@/src/partner/mood-colors';
import { categoryChips, categoryKey, categoryName, namesHidden, setCategoryName, setNamesHidden, type CategoryKind } from '@/src/partner/status-categories';
import { filterActivities, filterMoods, recentFirst, toColumns } from '@/src/partner/status-search';
import {
  activityKey,
  addCustomActivity,
  addCustomMood,
  editCustom,
  findActivity,
  findMood,
  moodKey,
  removeCustom,
  resolveActivities,
  resolveMoods,
  setLabelOverride,
  statusText,
  type AddFailure,
} from '@/src/partner/status-custom';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';
import { refreshApp } from '@/src/partner/refresh';

const MOODS_NAME = (id: string) => MOODS.find((m) => m.id === id)!.name;
const ACT_NAME = (id: string) => ACTIVITIES.find((a) => a.id === id)!.name;
const LINK_LABEL = { connected: 'linkConnected', connecting: 'linkConnecting', offline: 'linkOffline', stopped: 'linkStopped', unauthorized: 'linkUnauthorized' } as const;
const GRID_ROWS = 4;
const ACTIVITY_ROWS = 3;

export default function StatusScreen() {
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const paired = usePartnerStore((s) => s.paired);
  const partner = usePartnerStore((s) => s.partner);
  const link = usePartnerStore((s) => s.link);
  const tick = usePartnerStore((s) => s.moodTick);
  const [emoji, setEmoji] = useState('');
  const [activityId, setActivityId] = useState('');
  const [saved, setSaved] = useState<{ emoji: string; activity: string } | null>(null);
  const [moodQuery, setMoodQuery] = useState('');
  const [moodCat, setMoodCat] = useState<MoodCategoryId | 'all' | 'custom'>('all');
  const [actQuery, setActQuery] = useState('');
  const [actCat, setActCat] = useState<ActivityCategoryId | 'all' | 'custom'>('all');
  const [busy, setBusy] = useState(false);
  const [justSent, setJustSent] = useState(false); // the Send button shows a green check for ~2 s after a successful send
  const [error, setError] = useState(false);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recent, setRecent] = useState<{ emojis: string[]; activities: string[] }>({ emojis: [], activities: [] });
  const hiddenMoods = useSettingsStore((s) => s.hiddenMoods);
  const hiddenActivities = useSettingsStore((s) => s.hiddenActivities);
  const customMoods = useSettingsStore((s) => s.statusCustomMoods);
  const customActs = useSettingsStore((s) => s.statusCustomActivities);
  const labels = useSettingsStore((s) => s.statusLabels);
  const hiddenNames = useSettingsStore((s) => s.statusHiddenNames);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const [sheet, setSheet] = useState<ItemSheetTarget | null>(null);
  const [catSheet, setCatSheet] = useState<{ kind: CategoryKind; id: string; target: CategorySheetTarget } | null>(null);
  const [sheetError, setSheetError] = useState<TranslationKey | null>(null);
  const [headerH, setHeaderH] = useState(110);
  const touched = useRef(false);

  useEffect(() => {
    if (!justSent) return;
    const id = setTimeout(() => setJustSent(false), 2000);
    return () => clearTimeout(id);
  }, [justSent]);

  // The Status card starts from my latest saved status (so what Home shows is what you see here) unless you already picked something.
  useEffect(() => {
    void latestMood(db, true).then((m) => {
      setSaved(m ? { emoji: m.emoji, activity: m.activity ?? '' } : null);
      if (!touched.current) {
        setEmoji(m ? m.emoji : '');
        setActivityId(m?.activity ?? '');
      }
    });
    void recentUsed(db).then(setRecent);
  }, [db, tick]);

  const moodItems = useMemo(() => resolveMoods(customMoods, labels, t), [customMoods, labels, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const actItems = useMemo(() => resolveActivities(customActs, labels, t), [customActs, labels, language]); // eslint-disable-line react-hooks/exhaustive-deps
  const mood = findMood(moodItems, emoji);
  const activity = findActivity(actItems, activityId);
  const moodAccent = emoji ? moodColorsFor(emoji, customMoods)?.[0] : undefined;
  const unchanged = !!saved && saved.emoji === emoji && saved.activity === activityId;

  const visibleMoods = useMemo(() => recentFirst(filterMoods(moodItems.filter((m) => !hiddenMoods.includes(m.id)), { category: moodCat, query: moodQuery }, (m) => m.label), recent.emojis, (m) => m.emoji), [moodCat, moodQuery, moodItems, hiddenMoods, recent]); // eslint-disable-line react-hooks/exhaustive-deps
  const moodColumns = useMemo(() => toColumns(visibleMoods, GRID_ROWS, isRTL), [visibleMoods, isRTL]);
  const visibleActs = useMemo(() => recentFirst(filterActivities(actItems.filter((a) => !hiddenActivities.includes(a.id)), { category: actCat, query: actQuery }, (a) => a.label), recent.activities, (a) => a.id), [actCat, actQuery, actItems, hiddenActivities, recent]); // eslint-disable-line react-hooks/exhaustive-deps
  const actColumns = useMemo(() => toColumns(visibleActs, ACTIVITY_ROWS, isRTL), [visibleActs, isRTL]);

  const moodChips = useMemo(() => categoryChips<MoodCategoryId>('mood', labels, hiddenNames, t, customMoods.length > 0), [language, customMoods.length, labels, hiddenNames]); // eslint-disable-line react-hooks/exhaustive-deps
  const actChips = useMemo(() => categoryChips<ActivityCategoryId>('activity', labels, hiddenNames, t, customActs.length > 0), [language, customActs.length, labels, hiddenNames]); // eslint-disable-line react-hooks/exhaustive-deps

  // Q5: press and hold a category chip to rename it / hide its text ("All" and "Mine" are not categories).
  const openCategory = (kind: CategoryKind, id: string) => {
    if (id === 'all' || id === 'custom') return;
    setCatSheet({ kind, id, target: { name: categoryName(kind, id, labels, t), edited: !!labels[categoryKey(kind, id)], showNames: !namesHidden(hiddenNames, kind, id) } });
  };
  const saveCategory = (r: { name: string; showNames: boolean }) => {
    if (!catSheet) return;
    const { kind, id } = catSheet;
    setSetting('statusLabels', setCategoryName(labels, kind, id, r.name, t));
    setSetting('statusHiddenNames', setNamesHidden(hiddenNames, categoryKey(kind, id), !r.showNames));
    setCatSheet(null);
  };
  const resetCategory = () => {
    if (!catSheet) return;
    const { kind, id } = catSheet;
    setSetting('statusLabels', setCategoryName(labels, kind, id, '', t));
    setSetting('statusHiddenNames', setNamesHidden(hiddenNames, categoryKey(kind, id), false));
    setCatSheet(null);
  };

  const chooseMood = (e: string) => {
    touched.current = true;
    setJustSent(false);
    setEmoji((cur) => (cur === e ? '' : e)); // Q4: tap the picked mood again to un-pick it before sending
    setError(false);
  };
  const chooseActivity = (id: string) => {
    touched.current = true;
    setJustSent(false);
    setActivityId((cur) => (cur === id ? '' : id)); // tap again to un-pick it
  };

  const send = async () => {
    if (!emoji) return;
    setBusy(true);
    setError(false);
    const text = statusText(mood, activity);
    const localSave = async () => saveMoodLocal(db, { emoji, activity: activityId || null, text }).then(() => {
      usePartnerStore.getState().bumpMoods();
      return 'local' as const;
    }, () => 'failed' as const);
    let res: 'sent' | 'local' | 'local-not-sent' | 'failed';
    if (FEATURES.partner && paired) {
      const delivery = await sendMood(db, { emoji, text, intensity: 3, activity: activityId || null, preset: customMoods.find((c) => c.emoji === emoji)?.preset ?? null });
      res = delivery === 'sent' ? 'sent' : (await localSave()) === 'local' ? 'local-not-sent' : 'failed';
    } else {
      res = await localSave();
    }
    setBusy(false);
    if (res !== 'failed') {
      touched.current = false;
      const toastKey = res === 'sent' ? 'moodSent' : res === 'local-not-sent' ? 'moodSavedLocalNotSent' : 'homeStatusSaved';
      setToast({ text: t(toastKey), id: Date.now() });
      setJustSent(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } else {
      setError(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    }
  };

  const clear = async () => {
    setBusy(true);
    const res = await clearMood(db);
    setBusy(false);
    if (res === 'failed') return setError(true);
    touched.current = false;
    setEmoji('');
    setActivityId('');
    setToast({ text: t(res === 'sent' ? 'moodClearedSent' : 'moodCleared'), id: Date.now() });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  };

  const openAdd = (kind: 'mood' | 'activity') => {
    setSheetError(null);
    setSheet({ kind });
  };
  const openEdit = (target: ItemSheetTarget) => {
    setSheetError(null);
    setSheet(target);
  };
  const failure = (reason: AddFailure): TranslationKey => (reason === 'emoji' ? 'statusEmojiInvalid' : reason === 'label' ? 'statusLabelRequired' : reason === 'limit' ? 'statusLimitReached' : 'statusEmojiDuplicate');
  const saveSheet = (r: ItemSheetResult) => {
    if (!sheet) return;
    const item = sheet.item;
    if (sheet.kind === 'mood') {
      if (!item) {
        const res = addCustomMood(customMoods, r);
        if (!res.ok) return setSheetError(failure(res.reason));
        setSetting('statusCustomMoods', res.list);
      } else if (item.custom) {
        const list = editCustom(customMoods, item.id, { label: r.label, preset: r.preset });
        if (!list) return setSheetError('statusLabelRequired');
        setSetting('statusCustomMoods', list);
      } else {
        setSetting('statusLabels', setLabelOverride(labels, moodKey(item.id), r.label, t(MOODS_NAME(item.id))));
      }
    } else if (!item) {
      const res = addCustomActivity(customActs, r);
      if (!res.ok) return setSheetError(failure(res.reason));
      setSetting('statusCustomActivities', res.list);
    } else if (item.custom) {
      const list = editCustom(customActs, item.id, { label: r.label });
      if (!list) return setSheetError('statusLabelRequired');
      setSetting('statusCustomActivities', list);
    } else {
      setSetting('statusLabels', setLabelOverride(labels, activityKey(item.id), r.label, t(ACT_NAME(item.id))));
    }
    setSheet(null);
  };
  const resetSheet = () => {
    if (!sheet?.item) return;
    const { [sheet.kind === 'mood' ? moodKey(sheet.item.id) : activityKey(sheet.item.id)]: _gone, ...rest } = labels; // eslint-disable-line @typescript-eslint/no-unused-vars
    setSetting('statusLabels', rest);
    setSheet(null);
  };
  const deleteSheet = () => {
    if (!sheet?.item) return;
    if (sheet.kind === 'mood') {
      if (emoji === sheet.item.emoji) setEmoji('');
      setSetting('statusCustomMoods', removeCustom(customMoods, sheet.item.id));
    } else {
      if (activityId === sheet.item.id) setActivityId('');
      setSetting('statusCustomActivities', removeCustom(customActs, sheet.item.id));
    }
    setSheet(null);
  };

  const showMoods = !(FEATURES.partner && !paired);
  const subtitle = !mood ? t('statusPick') : unchanged ? t('statusCurrent') : t('statusReady');
  const empty = (key: TranslationKey) => (
    <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 15, textAlign: 'center', paddingVertical: 24 }}>{t(key)}</Text>
  );

  return (
    <View style={{ flex: 1 }}>
      <ScreenFrame scroll tabBar onRefresh={refreshApp}>
        {FEATURES.partner && paired ? (
          <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <Avatar b64={partner?.avatarB64} photo={partner?.avatarPhoto} name={partner?.name} size={44} />
            <Text style={{ flex: 1, color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12, textAlign: alignOf(isRTL) }}>
              {partner?.name ? `${partner.name} · ` : ''}
              {t(LINK_LABEL[link])}
            </Text>
          </View>
        ) : null}
        {FEATURES.partner && paired && link === 'unauthorized' ? <TokenNotAcceptedNotice /> : null}

        <View style={{ height: Math.max(0, headerH - 16 + 12) }} />
        {error ? <Notice tone="error">{t('moodSendFailed')}</Notice> : null}
        {showMoods ? <PeriodEntry onPress={() => router.push('/period')} /> : null}

        {!showMoods ? (
          <Card>
            <Notice>{t('moodNeedPartner')}</Notice>
            <Button title="pairPartner" primary icon="user-plus" onPress={() => router.push('/settings/pair')} />
          </Card>
        ) : (
          <>
            <SectionLabel label={t('statusMoodsTitle')} trailing={t('statusAdd')} onTrailingPress={() => openAdd('mood')} />
            <SearchRow value={moodQuery} onChangeText={setMoodQuery} placeholder={t('statusSearchMoods')} />
            <CategoryChips items={moodChips} value={moodCat} onChange={setMoodCat} onLongPress={(id) => openCategory('mood', id)} />
            {moodColumns.length === 0 ? (
              empty('statusNoMoods')
            ) : (
              <View style={{ marginHorizontal: -22, marginBottom: 18 }}>
                <HScroll rtl={isRTL}>
                  <View style={{ flexDirection: 'row', gap: MOOD_TILE_GAP, paddingVertical: 10, minHeight: GRID_ROWS * MOOD_TILE + (GRID_ROWS - 1) * MOOD_TILE_GAP + 20 }}>
                    {moodColumns.map((col, i) => (
                      <View key={i} style={{ gap: MOOD_TILE_GAP }}>
                        {col.map((m, r) => (
                          <Animated.View key={m.id} entering={ZoomIn.duration(260).delay(Math.min(i * 24 + r * 16, 360))}>
                            <MoodTile emoji={m.emoji} label={m.label} selected={emoji === m.emoji} accent={moodColorsFor(m.emoji, customMoods)?.[0]} onPress={() => chooseMood(m.emoji)} onLongPress={() => openEdit({ kind: 'mood', item: m })} />
                          </Animated.View>
                        ))}
                      </View>
                    ))}
                  </View>
                </HScroll>
              </View>
            )}

            <SectionLabel label={t('statusActivities')} trailing={t('statusAdd')} onTrailingPress={() => openAdd('activity')} />
            <SearchRow value={actQuery} onChangeText={setActQuery} placeholder={t('statusSearchActivities')} />
            <CategoryChips items={actChips} value={actCat} onChange={setActCat} onLongPress={(id) => openCategory('activity', id)} />
            {actColumns.length === 0 ? (
              empty('statusNoActivities')
            ) : (
              <View style={{ marginHorizontal: -22, marginBottom: 8 }}>
                <HScroll rtl={isRTL}>
                  <View style={{ flexDirection: 'row', gap: MOOD_TILE_GAP, paddingVertical: 10, minHeight: ACTIVITY_ROWS * ACTIVITY_TILE_HEIGHT + (ACTIVITY_ROWS - 1) * MOOD_TILE_GAP + 20 }}>
                    {actColumns.map((col, i) => (
                      <View key={i} style={{ gap: MOOD_TILE_GAP }}>
                        {col.map((a, r) => (
                          <Animated.View key={a.id} entering={ZoomIn.duration(260).delay(Math.min(i * 30 + r * 20, 360))}>
                            <ActivityTile accent={moodAccent} emoji={a.emoji} name={a.label} hideName={namesHidden(hiddenNames, 'activity', a.category)} selected={activityId === a.id} onPress={() => chooseActivity(a.id)} onLongPress={() => openEdit({ kind: 'activity', item: a })} />
                          </Animated.View>
                        ))}
                      </View>
                    ))}
                  </View>
                </HScroll>
              </View>
            )}
            <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 12, textAlign: 'center', marginTop: 4 }}>{t('statusEditHint')}</Text>
          </>
        )}
      </ScreenFrame>
      <StickyHeader onHeight={setHeaderH}>
        <MoodCard
          emoji={mood ? mood.emoji : ''}
          title={mood ? `${t('statusFeeling')} ${mood.label}` : t('moodHowFeeling')}
          subtitle={`${activity ? `${activity.emoji} ${activity.label} · ` : ''}${subtitle}`}
          historyLabel={t('moodHistory')}
          clearLabel={t('moodClear')}
          onHistory={() => setHistoryOpen(true)}
          onClear={saved ? () => void clear() : undefined}
          clearDisabled={busy}
          customMoods={customMoods}
        />
      </StickyHeader>
      <Toast message={toast} position="top" emoji={emoji || undefined} />
      {showMoods ? <Fab floating aboveTabBar label={t(FEATURES.partner ? 'moodSend' : 'moodSave')} icon="check" loading={busy} success={justSent && unchanged} successLabel={t(FEATURES.partner ? 'moodSendDone' : 'moodSaveDone')} disabled={!emoji || busy} onPress={() => void send()} /> : null}
      <StatusItemSheet target={sheet} error={sheetError} onClose={() => setSheet(null)} onSave={saveSheet} onReset={resetSheet} onDelete={deleteSheet} />
      <CategorySheet target={catSheet?.target ?? null} onClose={() => setCatSheet(null)} onSave={saveCategory} onReset={resetCategory} />
      <HistorySheet visible={historyOpen} onClose={() => setHistoryOpen(false)} refreshKey={tick} />
    </View>
  );
}
