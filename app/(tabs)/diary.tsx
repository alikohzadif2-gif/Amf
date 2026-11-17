import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { ScreenFrame } from '@/components/ScreenFrame';
import { EmptyState, Fab, Input } from '@/components/ui';
import { Text } from '@/components/ui/ScaledText';
import { CategorySheet } from '@/components/diary/CategorySheet';
import { SortDrawer, SortToolbar } from '@/components/ui/SortDrawer';
import { MonthRangePicker } from '@/components/ui/MonthRangePicker';
import { useTabBarHeight } from '@/components/ui/useTabBarHeight';
import { splitSharedPath } from '@/src/partner/media-ref';
import { TIME_ORDERS, type TimeOrder } from '@/src/library/time-order';
import { currentYearMonth, normalizeRange, rangeToDays, type MonthRange, type YearMonth } from '@/src/library/date-range';
import { DiaryCard } from '@/components/diary/DiaryCard';
import type { LibraryEntry } from '@/src/library/merge';
import { useLibraryIndex } from '@/src/library/index-store';
import { DIARY_CATEGORIES, DIARY_NO_CATEGORY, diaryCategoryLabel } from '@/src/diary/categories';
import { intersectDayRanges, presetCalendar, resolveDateRange, type DiaryDatePreset } from '@/src/diary/date-range';
import { useCustomCategories } from '@/src/diary/use-categories';
import { listDiaryEntries, type DiaryRow } from '@/src/diary/diary-db';
import { replySummary } from '@/src/diary/reply-db';
import { logEvent } from '@/src/diagnostics/log';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { calendarMonthName, formatDate, toDigits } from '@/src/lib/calendar';
import { rowOf } from '@/src/lib/layout';
import { usePullRefresh } from '@/hooks/usePullRefresh';
import { refreshApp } from '@/src/partner/refresh';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

type Tool = 'time' | 'type' | 'range';
const TIME_LABEL: Record<TimeOrder, TranslationKey> = {
  all: 'timeAll', today: 'timeToday', week: 'timeWeek', month: 'timeMonth', year: 'timeYear', newest: 'archiveSortNewest', oldest: 'archiveSortOldest',
};
const TIME_PRESET: Partial<Record<TimeOrder, DiaryDatePreset>> = { today: 'today', week: 'week', month: 'month', year: 'year' };

export default function DiaryScreen() {
  const pull = usePullRefresh(refreshApp);
  const colors = useColors();
  const router = useRouter();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const { calendarMode, digits, weekStart } = useSettingsStore();
  const { customs, reload: reloadCustoms } = useCustomCategories();
  const libraryByKey = useLibraryIndex((s) => s.byKey);
  const [entries, setEntries] = useState<DiaryRow[]>([]);
  const [replies, setReplies] = useState<Map<string, { count: number; answered: boolean }>>(new Map());
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<TimeOrder>('all');
  const [category, setCategory] = useState<string>('all');
  const [monthRange, setMonthRange] = useState<MonthRange | null>(null);
  const [draftStart, setDraftStart] = useState<YearMonth | null>(null);
  const [draftEnd, setDraftEnd] = useState<YearMonth | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const cal = presetCalendar(calendarMode, language);
  const sort = order === 'oldest' ? 'oldest' : 'newest';
  const dayRange = useMemo(
    () => intersectDayRanges(
      resolveDateRange({ preset: TIME_PRESET[order] ?? 'all' }, cal, weekStart),
      monthRange ? rangeToDays(monthRange, cal) : null,
    ),
    [order, monthRange, cal, weekStart],
  );
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const diaryTick = usePartnerStore((s) => s.diaryTick);

  useFocusEffect(useCallback(() => {
    let active = true;
    logEvent('info', 'diary list: focus, loading');
    // Keep the list on screen while reloading: only the very first load shows the spinner.
    setLoadState((state) => (state === 'ready' ? state : 'loading'));
    void listDiaryEntries(db, {
      query,
      sort,
      category: category === 'saved' ? 'all' : category,
      saved: category === 'saved' ? true : undefined,
      range: dayRange,
      calendar: calendarMode,
      language,
      digits,
    }).then(async (rows) => {
      logEvent('info', `diary list: loaded ${rows.length} rows (active=${active})`);
      const summary = await replySummary(db).catch(() => new Map<string, { count: number; answered: boolean }>());
      if (!active) return;
      setReplies(summary);
      setEntries(rows);
      setLoadState('ready');
    }).catch((error: unknown) => {
      logEvent('info', `diary list: load failed ${error instanceof Error ? error.message : String(error)}`);
      if (!active) return;
      setEntries([]);
      setLoadState('failed');
    });
    return () => { active = false; };
  }, [db, query, sort, category, dayRange, customs, calendarMode, language, digits, diaryTick]));

  // Trace after the commit (not during render): shows how far the list got before a native crash.
  useEffect(() => {
    logEvent('info', `diary list: committed ${entries.length} rows (${loadState})`);
  }, [entries, loadState]);

  const filtered = !!query.trim() || category !== 'all' || dayRange !== null;
  const emptyMessage = useMemo(() => filtered ? t('diaryNoSearchResults') : t('diaryEmpty'), [filtered, t]);
  const monthText = (v: YearMonth) => `${calendarMonthName(cal, v.month, language)} ${toDigits(v.year, digits)}`;
  const typeOptions = useMemo(() => [
    { id: 'all', label: t('diaryFilterAll') },
    { id: 'saved', label: t('diaryFilterSaved') },
    { id: DIARY_NO_CATEGORY, label: t('diaryCategoryNone') },
    ...DIARY_CATEGORIES.map((c) => ({ id: c.id, label: t(c.name) })),
    ...customs.map((c) => ({ id: c.id, label: c.name })),
    { id: 'manage', label: t('diaryCategoryManage') },
  ], [customs, t]);
  const typeText = (id: string) => typeOptions.find((o) => o.id === id)?.label ?? id;
  const sheetOffset = useTabBarHeight() + 8; // the floating tab bar must stay reachable under every drawer
  const openNew = () => router.push('/diary/new' as never);
  const openEntry = useCallback((id: string) => {
    router.push(`/diary/${encodeURIComponent(id)}` as never);
  }, [router]);

  const renderEntry = useCallback(({ item }: { item: DiaryRow }) => {
    const cover = item.mediaKeys.map((key) => libraryByKey.get(key)).find((entry): entry is LibraryEntry => !!entry && (entry.item.type === 'image' || entry.item.type === 'video'));
    const sharedCover = item.fromMe === false && !cover ? item.mediaKeys.find((key) => splitSharedPath(key) !== null) : undefined;
    return (
      <DiaryCard
        title={item.title}
        body={item.body.trim().split('\n')[0]}
        categoryLabel={diaryCategoryLabel(item.category, customs, t)}
        mood={item.mood}
        dateLabel={formatDate(item.createdAt, calendarMode, language, digits)}
        saved={item.saved}
        cover={cover}
        sharedCover={sharedCover}
        extraMedia={Math.max(0, (item.mediaKeys.length || item.sharedMedia || 0) - 1)}
        replied={replies.get(item.id)?.answered === true}
        repliedLabel={t('diaryReplied')}
        attachmentsLabel={item.mediaKeys.length === 0 && (item.sharedMedia ?? 0) > 0 ? t('diarySharedMedia').replace('{n}', toDigits(item.sharedMedia ?? 0, digits)) : undefined}
        onPress={() => openEntry(item.id)}
      />
    );
  }, [customs, language, calendarMode, digits, libraryByKey, openEntry, replies, t]);

  return (
    <ScreenFrame tabBar contentStyle={{ paddingTop: 12, paddingBottom: 0 }}>
      <View style={{ flex: 1 }}>
        <View style={styles.searchWrap}>
          <Input value={query} onChangeText={setQuery} placeholder={t('diarySearchPlaceholder')} icon="search" returnKeyType="search" />
        </View>
        <SortToolbar
          tools={[
            { id: 'time', label: t('sortTime'), value: t(TIME_LABEL[order]), active: order !== 'all' },
            { id: 'type', label: t('sortType'), value: category !== 'all' ? typeText(category) : undefined, active: category !== 'all' },
            { id: 'range', label: t('sortRange'), value: monthRange ? `${monthText(monthRange.start)} – ${monthText(monthRange.end)}` : undefined, active: monthRange !== null },
          ]}
          onOpen={(id) => {
            if (id === 'range') { setDraftStart(monthRange?.start ?? null); setDraftEnd(monthRange?.end ?? null); }
            setTool(id);
          }}
        />
        {/* Always mounted: swapping it with a spinner/empty view while the screen comes back from /diary/new crashed the app. */}
        <FlatList
          refreshControl={pull.control}
          data={entries}
          renderItem={renderEntry}
          keyExtractor={(item) => item.id}
          contentContainerStyle={entries.length === 0 ? styles.emptyContent : styles.listContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={8}
          windowSize={7}
          removeClippedSubviews={false}
          ListEmptyComponent={
            loadState === 'loading' ? (
              <View style={styles.empty}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : loadState === 'failed' ? (
              <View style={styles.empty}>
                <EmptyState message={t('diaryLoadFailed')} />
              </View>
            ) : (
              <View style={styles.empty}>
                <EmptyState message={emptyMessage} actionLabel={filtered ? undefined : t('diaryCreateFirst')} actionIcon="book-open" onAction={openNew} />
              </View>
            )
          }
        />
      </View>
      <Fab icon="book-open" floating aboveTabBar accessibilityLabel={t('diaryNewEntry')} onPress={openNew} />
      <SortDrawer
        visible={tool === 'time'}
        title={t('sortTime')}
        options={TIME_ORDERS.map((id) => ({ id, label: t(TIME_LABEL[id]) }))}
        value={order}
        onSelect={setOrder}
        onClose={() => setTool(null)}
        bottomOffset={sheetOffset}
      />
      <SortDrawer
        visible={tool === 'type'}
        title={t('sortType')}
        options={typeOptions}
        value={category}
        onSelect={(id) => (id === 'manage' ? setManageOpen(true) : setCategory(id))}
        onClose={() => setTool(null)}
        bottomOffset={sheetOffset}
      />
      <SortDrawer
        visible={tool === 'range'}
        title={t('sortRange')}
        onClose={() => setTool(null)}
        bottomOffset={sheetOffset}
        actionLabel={t('rangeApply')}
        actionDisabled={!draftStart || !draftEnd}
        onAction={() => {
          if (draftStart && draftEnd) setMonthRange(normalizeRange(draftStart, draftEnd));
          setTool(null);
        }}
      >
        <MonthRangePicker kind={cal} start={draftStart} end={draftEnd} onStart={setDraftStart} onEnd={setDraftEnd} initialYear={currentYearMonth(cal).year} />
        {monthRange ? (
          <Pressable accessibilityRole="button" onPress={() => { setMonthRange(null); setTool(null); }} style={{ paddingVertical: 16, alignItems: 'center' }}>
            <Text style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), fontSize: 15 }}>{t('rangeClear')}</Text>
          </Pressable>
        ) : null}
      </SortDrawer>
      <CategorySheet
        visible={manageOpen}
        onClose={() => setManageOpen(false)}
        customs={customs}
        bottomOffset={sheetOffset}
        onChanged={() => {
          // A deleted custom category can no longer be the active filter.
          void reloadCustoms().then((list) => setCategory((current) => (
            current === 'all' || current === 'saved' || current === DIARY_NO_CATEGORY || DIARY_CATEGORIES.some((c) => c.id === current) || list.some((c) => c.id === current) ? current : 'all'
          )));
        }}
      />
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  searchWrap: { marginBottom: 14 },
  empty: { flex: 1, justifyContent: 'center', minHeight: 280, paddingBottom: 36 },
  listContent: { paddingTop: 8, paddingBottom: 116 },
  emptyContent: { flexGrow: 1 },
});
