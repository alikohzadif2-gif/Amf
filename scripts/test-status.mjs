import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrateEvents, migrateLibrary, migrateMood, migrateStatus, initializeDatabase } from '../src/lib/database.ts';
import { ACTIVITIES, ACTIVITY_CATEGORY_IDS, ACTIVITY_CATEGORY_LABEL, activityById } from '../src/partner/activities.ts';
import { clearMoodLocal, deleteMood, latestMood, listMoods, listMyStatusHistory, recentUsed, saveMoodLocal, insertMood } from '../src/partner/mood-db.ts';
import { MOODS, MOOD_CATEGORIES, MOOD_CATEGORY_IDS, MOOD_CATEGORY_LABEL, moodByEmoji, moodById } from '../src/partner/moods.ts';
import { categoryChips, categoryEmoji, categoryKey, categoryName, namesHidden, setCategoryName, setNamesHidden } from '../src/partner/status-categories.ts';
import { activityKey, addCustomActivity, addCustomMood, editCustom, findActivity, findMood, isValidStatusEmoji, moodKey, removeCustom, resolveActivities, resolveMoods, setLabelOverride, statusText } from '../src/partner/status-custom.ts';
import { filterActivities, filterMoods, normalizeQuery, recentFirst, toColumns } from '../src/partner/status-search.ts';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dict = { en: read('../src/i18n/locales/en.json'), fa: read('../src/i18n/locales/fa.json') };

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  return {
    execAsync: async (sql) => void db.exec(sql),
    runAsync: async (sql, ...p) => {
      const r = db.prepare(sql).run(...p);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getAllAsync: async (sql, ...p) => db.prepare(sql).all(...p),
    getFirstAsync: async (sql, ...p) => db.prepare(sql).get(...p) ?? null,
  };
}

// ---- catalogues ------------------------------------------------------------------------------
assert.ok(MOODS.length >= 36, `moods: ${MOODS.length}`);
assert.deepEqual(MOOD_CATEGORY_IDS, ['positive', 'energetic', 'calm', 'neutral', 'hard']);
assert.equal(new Set(MOODS.map((m) => m.id)).size, MOODS.length, 'unique mood ids');
assert.equal(new Set(MOODS.map((m) => m.emoji)).size, MOODS.length, 'unique mood emojis');
for (const c of MOOD_CATEGORY_IDS) assert.ok(MOODS.filter((m) => m.category === c).length >= 5, `category ${c} has moods`);
assert.deepEqual(MOOD_CATEGORIES.flatMap((c) => c.emojis).sort(), MOODS.map((m) => m.emoji).sort(), 'compat category view covers every mood');
assert.ok(ACTIVITIES.length >= 40, `activities: ${ACTIVITIES.length}`);
assert.deepEqual(ACTIVITY_CATEGORY_IDS, ['entertainment', 'hobbies', 'health', 'social', 'home', 'travel']);
assert.equal(new Set(ACTIVITIES.map((a) => a.id)).size, ACTIVITIES.length, 'unique activity ids');
for (const c of ACTIVITY_CATEGORY_IDS) assert.ok(ACTIVITIES.filter((a) => a.category === c).length >= 5, `activity category ${c}`);
assert.doesNotMatch([...MOODS, ...ACTIVITIES].map((x) => x.emoji).join(''), /[❤💕💖💗💘💋🔞🍆🍑]/u, 'neutral: no hearts or explicit emoji');
for (const lang of ['en', 'fa']) {
  for (const key of [...MOODS.map((m) => m.name), ...ACTIVITIES.map((a) => a.name), ...Object.values(MOOD_CATEGORY_LABEL), ...Object.values(ACTIVITY_CATEGORY_LABEL), 'statusCatAll']) {
    assert.ok(dict[lang][key] && dict[lang][key].trim().length > 0, `${lang}.${key}`);
  }
}
assert.equal(moodByEmoji('😀').id, 'happy');
assert.equal(moodById('sad').emoji, '😔');
assert.equal(moodByEmoji('x'), undefined);
assert.equal(moodByEmoji(null), undefined);
assert.equal(activityById('running').emoji, '🏃');
assert.equal(activityById('nope'), undefined);

// ---- search / filter helpers -----------------------------------------------------------------
const nameEn = (x) => dict.en[x.name];
const nameFa = (x) => dict.fa[x.name];
assert.equal(normalizeQuery('  Ha  PPY '), 'ha ppy');
assert.equal(normalizeQuery('كيك'), 'کیک', 'Arabic ke/ye -> Persian');
assert.equal(normalizeQuery('۱۲۳٤'), '1234', 'Persian/Arabic digits');
assert.deepEqual(filterMoods(MOODS, {}, nameEn).length, MOODS.length, 'no filter = all');
assert.deepEqual(filterMoods(MOODS, { category: 'all', query: '' }, nameEn).length, MOODS.length);
assert.ok(filterMoods(MOODS, { category: 'hard' }, nameEn).every((m) => m.category === 'hard'));
assert.deepEqual(filterMoods(MOODS, { query: 'HAPP' }, nameEn).map((m) => m.id), ['happy'], 'case-insensitive substring');
assert.deepEqual(filterMoods(MOODS, { category: 'calm', query: 'happy' }, nameEn), [], 'category and query combine');
assert.deepEqual(filterMoods(MOODS, { query: '😀' }, nameEn).map((m) => m.id), ['happy'], 'search by emoji');
assert.deepEqual(filterMoods(MOODS, { query: 'غمگین' }, nameFa).map((m) => m.id), ['sad'], 'Persian search');
assert.deepEqual(filterMoods(MOODS, { query: 'zzzz' }, nameEn), []);
assert.deepEqual(filterActivities(ACTIVITIES, { category: 'travel', query: 'beach' }, nameEn).map((a) => a.id), ['beach']);
assert.ok(filterActivities(ACTIVITIES, { category: 'health' }, nameEn).every((a) => a.category === 'health'));
assert.deepEqual(filterActivities(ACTIVITIES, { query: 'دویدن' }, nameFa).map((a) => a.id), ['running']);
assert.equal(filterActivities(ACTIVITIES, {}, nameEn).length, ACTIVITIES.length);

// ---- tile grid columns (U14) -------------------------------------------------------------------
assert.deepEqual(toColumns([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]], 'fills a column top to bottom, then the next');
assert.deepEqual(toColumns([1, 2, 3, 4, 5], 2, true), [[5], [3, 4], [1, 2]], 'RTL: first column last, so it sits at the right edge');
assert.deepEqual(toColumns([], 4), []);
assert.deepEqual(toColumns([1, 2], 0), [[1], [2]], 'rows is clamped to at least 1');
assert.equal(toColumns(MOODS, 4).flat().length, MOODS.length, 'no mood lost');

// ---- Status screen wiring (U14) ----------------------------------------------------------------
{
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const screen = src('../app/(tabs)/status.tsx');
  assert.match(screen, /SearchRow/);
  assert.match(screen, /filterMoods\(moodItems/, 'search + category filter');
  assert.match(screen, /toColumns\(visibleMoods, GRID_ROWS, isRTL\)/);
  assert.doesNotMatch(screen, /Haptics\.selectionAsync/, 'no haptic when picking a mood / activity');
  assert.match(screen, /statusFeeling/);
  assert.match(screen, /MoodTile/);
  assert.doesNotMatch(screen, /LEVELS|moodIntensity|label="moodNote"/, 'intensity and note UI dropped');
  // U15
  assert.match(screen, /filterActivities\(actItems/, 'activity search + category filter');
  assert.match(screen, /ActivityTile/);
  assert.match(screen, /saveMoodLocal\(db, \{ emoji, activity: activityId \|\| null, text \}\)/, 'saves the chosen activity locally');
  assert.match(screen, /Haptics\.notificationAsync\(Haptics\.NotificationFeedbackType\.Success\)/, 'success haptic');
  assert.match(screen, /<Toast /);
  assert.match(screen, /HistorySheet/);
  assert.match(screen, /latestMood\(db, true\)/, 'card starts from the latest saved status');
  assert.match(src('../components/status/ActivityTile.tsx'), /numberOfLines=\{1\}/, 'ellipsis');
  assert.match(src('../components/status/HistorySheet.tsx'), /listMyStatusHistory/);
  assert.doesNotMatch(src('../app/(tabs)/index.tsx') + src('../components/home/HomeCards.tsx'), /MyStatusCard/, 'R2: "My status" is gone from Home');
  assert.doesNotMatch(src('../components/ui/Toast.tsx') + src('../components/status/HistorySheet.tsx') + src('../components/status/ActivityTile.tsx') + src('../components/status/CategoryChips.tsx'), /marginLeft|marginRight|paddingLeft|paddingRight/);
  for (const lang of ['en', 'fa']) for (const k of ['statusCurrent', 'statusActivities', 'statusSearchActivities', 'statusNoActivities']) assert.ok(dict[lang][k], `${lang}.${k}`);
  assert.match(src('../components/status/MoodTile.tsx'), /moodSelected/);
  assert.doesNotMatch(src('../components/status/HScroll.tsx') + src('../components/status/MoodTile.tsx') + src('../components/status/SearchRow.tsx'), /marginLeft|marginRight|paddingLeft|paddingRight/);
  for (const lang of ['en', 'fa']) for (const k of ['statusFeeling', 'statusReady', 'statusPick', 'statusSearchMoods', 'statusNoMoods']) assert.ok(dict[lang][k], `${lang}.${k}`);
}

// ---- DB: migration of an old database, save / latest / history -------------------------------
{
  // a phone that already ran migrations 1-4 (no `activity` column) with one old row
  const db = memoryDb();
  await db.execAsync("CREATE TABLE migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
  await migrateLibrary(db);
  await migrateMood(db);
  await migrateEvents(db);
  await db.runAsync("INSERT INTO moods (msg_id, from_me, emoji, text, intensity, ts) VALUES ('old1', 1, '😊', 'old note', 4, '2026-10-10T08:00:00.000Z')");
  const before = await db.getAllAsync('PRAGMA table_info(moods)');
  assert.ok(!before.some((c) => c.name === 'activity'));

  await initializeDatabase(db);
  await initializeDatabase(db); // idempotent: the column is added once
  const cols = await db.getAllAsync('PRAGMA table_info(moods)');
  assert.equal(cols.filter((c) => c.name === 'activity').length, 1);
  await migrateStatus(db);
  const versions = await db.getAllAsync('SELECT version, name FROM migrations ORDER BY version');
  assert.ok(versions.some((v) => v.name === 'u13-status' && v.version === 5));

  const old = await latestMood(db, true);
  assert.deepEqual([old.emoji, old.text, old.intensity, old.activity], ['😊', 'old note', 4, null], 'old rows still load with activity null');

  const a = await saveMoodLocal(db, { emoji: '😀', activity: 'running', ts: '2026-10-16T08:00:00.000Z' });
  assert.deepEqual([a.activity, a.intensity, a.text, a.fromMe], ['running', 3, null, true], 'defaults: intensity 3, note null');
  const b = await saveMoodLocal(db, { emoji: '😴', ts: '2026-10-17T08:00:00.000Z' });
  assert.equal(b.activity, null);
  const c = await saveMoodLocal(db, { emoji: '🌙', activity: '', ts: '2026-10-15T08:00:00.000Z' });
  assert.equal(c.activity, null, 'empty activity is stored as null');
  assert.equal((await latestMood(db, true)).emoji, '😴', 'latest = newest by time');
  assert.equal(await insertMood(db, { msgId: 'p1', fromMe: false, emoji: '🤗', text: null, intensity: 3, ts: '2026-10-18T08:00:00.000Z' }), true);
  assert.equal((await latestMood(db, false)).activity, null, 'partner moods have no activity');
  assert.equal((await latestMood(db, true)).emoji, '😴', 'partner row does not touch mine');

  const mine = await listMyStatusHistory(db);
  assert.deepEqual(mine.map((r) => r.ts.slice(0, 10)), ['2026-10-17', '2026-10-16', '2026-10-15', '2026-10-10'], 'my history only, newest first');
  assert.deepEqual(mine.map((r) => r.activity), [null, 'running', null, null], 'history includes the activity');
  assert.equal((await listMyStatusHistory(db, 2)).length, 2);
  assert.equal((await listMoods(db)).length, 5, 'listMoods still returns both sides');
}
{
  // fresh install: initializeDatabase alone creates the column
  const db = memoryDb();
  await initializeDatabase(db);
  const r = await saveMoodLocal(db, { emoji: '😀', activity: 'gym' });
  assert.equal((await latestMood(db, true)).activity, 'gym');
  assert.ok(r.id > 0);
}
// ---- R3: clear, 😈, recents, delete, hide ---------------------------------------------------------
{
  assert.equal(moodByEmoji('😈').id, 'mischievous');
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const db = memoryDb();
  await initializeDatabase(db);
  const a = await saveMoodLocal(db, { emoji: '😀', activity: 'gym', ts: '2026-10-10T08:00:00.000Z' });
  await saveMoodLocal(db, { emoji: '😴', activity: 'rest', ts: '2026-10-11T08:00:00.000Z' });
  await saveMoodLocal(db, { emoji: '😀', ts: '2026-10-12T08:00:00.000Z' });
  assert.deepEqual(await recentUsed(db), { emojis: ['😀', '😴'], activities: ['rest', 'gym'] }, 'recent first, no duplicates');
  assert.equal(await clearMoodLocal(db, true, null, '2026-10-13T08:00:00.000Z'), true);
  assert.equal(await latestMood(db, true), null, 'cleared = no current mood');
  assert.equal((await listMyStatusHistory(db)).length, 3, 'the clear marker is not in the history');
  assert.equal((await recentUsed(db)).emojis.length, 2);
  // partner side: a clear after a mood, duplicate delivery ignored, a later mood replaces it
  await insertMood(db, { msgId: 'p1', fromMe: false, emoji: '🤗', text: null, intensity: 3, ts: '2026-10-14T08:00:00.000Z' });
  assert.equal((await latestMood(db, false)).emoji, '🤗');
  assert.equal(await clearMoodLocal(db, false, 'p2', '2026-10-14T09:00:00.000Z'), true);
  assert.equal(await clearMoodLocal(db, false, 'p2', '2026-10-14T09:00:00.000Z'), false, 'duplicate');
  assert.equal(await latestMood(db, false), null);
  assert.equal((await listMoods(db)).some((r) => r.emoji === ''), false);
  await insertMood(db, { msgId: 'p3', fromMe: false, emoji: '😈', text: null, intensity: 3, ts: '2026-10-14T10:00:00.000Z' });
  assert.equal((await latestMood(db, false)).emoji, '😈');
  await deleteMood(db, a.id);
  assert.deepEqual((await recentUsed(db)).activities, ['rest'], 'deleting a history row also drops it from recents');
  assert.deepEqual(recentFirst([1, 2, 3, 4], ['3', '1'], String), [3, 1, 2, 4]);
  assert.deepEqual(recentFirst([1, 2], [], String), [1, 2]);
  const screen = src('../app/(tabs)/status.tsx');
  assert.match(screen, /clearMood\(db\)/);
  assert.match(screen, /hiddenMoods\.includes/);
  assert.match(screen, /hiddenActivities\.includes/);
  assert.match(src('../app/settings/status-items.tsx'), /hiddenMoods/);
  assert.match(src('../components/status/HistorySheet.tsx'), /deleteMood/);
  assert.match(src('../src/state/settings-store.ts'), /hiddenMoods: \[\]/);
  for (const lang of ['en', 'fa']) for (const k of ['moodName_mischievous', 'moodClear', 'moodCleared', 'moodClearedSent', 'moodDeleteItem', 'statusItems', 'statusItemsDesc', 'statusItemsIntro', 'statusMoodsTitle']) assert.ok(dict[lang][k], `${lang}.${k}`);
}
// ---- R4: sticky card + filled chip ------------------------------------------------------------
{
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const card = src('../components/status/StickyMoodCard.tsx');
  assert.match(card, /LinearGradient/, 'gradient card');
  assert.match(card, /elevation/, 'shadow');
  assert.match(card, /position: 'absolute'/, 'card stays fixed while the grid scrolls');
  assert.doesNotMatch(card, /marginLeft|marginRight|paddingLeft|paddingRight/);
  const screen = src('../app/(tabs)/status.tsx');
  assert.match(screen, /<StickyHeader onHeight=\{setHeaderH\}>/);
  assert.match(screen, /<MoodCard/);
  assert.match(src('../components/ui/Chip.tsx'), /colors\.chipSelected\b/, 'selected chip is filled');
  for (const mode of ['light', 'dark']) {
    const tokens = src('../constants/colors.ts');
    assert.match(tokens, /chipSelected: '#/, mode);
  }
  for (const lang of ['en', 'fa']) assert.ok(dict[lang].statusMyMood, `${lang}.statusMyMood`);
}
// ---- Q3: the mood card follows the emoji ---------------------------------------------------------
{
  const { default: palettes } = await import('../constants/colors.ts');
  const { MOOD_PALETTE, MOOD_PRESETS, MOOD_CARD_ALPHA, MOOD_CARD_SECONDARY_TEXT_ALPHA, moodColorsFor } = await import('../src/partner/mood-colors.ts');
  const HEX = /^#[0-9A-F]{6}$/i;
  for (const mood of MOODS) {
    const pair = MOOD_PALETTE[mood.id];
    assert.ok(pair && pair.length === 2 && HEX.test(pair[0]) && HEX.test(pair[1]) && pair[0].toLowerCase() !== pair[1].toLowerCase(), `${mood.id} has a two-colour palette`);
    assert.deepEqual(moodColorsFor(mood.emoji), pair, `${mood.id}: the emoji finds its palette`);
  }
  assert.deepEqual(Object.keys(MOOD_PALETTE).sort(), MOODS.map((m) => m.id).sort(), 'no palette without a mood');
  assert.equal(moodColorsFor('🦄'), undefined); assert.equal(moodColorsFor(''), undefined); assert.equal(moodColorsFor(null), undefined);
  assert.equal(MOOD_PRESETS.length, 8, 'about eight presets for custom moods (Q4)');
  for (const preset of MOOD_PRESETS) assert.ok(HEX.test(preset.colors[0]) && HEX.test(preset.colors[1]), `preset ${preset.id}`);
  assert.equal(new Set(MOOD_PRESETS.map((p) => p.id)).size, 8);
  // the colour families the owner asked for
  const hue = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  for (const id of ['angry', 'period']) assert.ok([hue(MOOD_PALETTE[id][0])].every((h) => h < 15 || h > 345), `${id} starts red`);
  for (const id of ['happy', 'cheerful', 'energized']) assert.ok(hue(MOOD_PALETTE[id][0]) >= 35 && hue(MOOD_PALETTE[id][0]) <= 55, `${id} starts yellow`);
  // contrast on both themes: text over the tinted card (both stops over the card surface)
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (h) => { const [r, g, b] = rgb(h).map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (f, b, a) => `#${rgb(f).map((v, i) => Math.round(v * a + rgb(b)[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
  for (const scheme of ['light', 'dark']) {
    const p = palettes[scheme];
    for (const [id, pair] of Object.entries(MOOD_PALETTE)) for (const c of pair) {
      const bg = mix(c, p.card, MOOD_CARD_ALPHA[scheme]);
      assert.ok(ratio(p.foreground, bg) >= 4.5, `${scheme}/${id}: title contrast ${ratio(p.foreground, bg).toFixed(2)}`);
      assert.ok(ratio(mix(p.foreground, bg, MOOD_CARD_SECONDARY_TEXT_ALPHA), bg) >= 4.5, `${scheme}/${id}: subtitle contrast`);
    }
    for (const preset of MOOD_PRESETS) for (const c of preset.colors) assert.ok(ratio(p.foreground, mix(c, p.card, MOOD_CARD_ALPHA[scheme])) >= 4.5, `${scheme}/preset ${preset.id}`);
  }
  const card = readFileSync(new URL('../components/status/StickyMoodCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /moodColorsFor\(emoji, customMoods\)/, 'the card takes its gradient from the picked emoji (and my own moods)');
  assert.match(card, /colors=\{gradient\}/);
}
// ---- Q4: own moods/activities, edited labels, deselect, text sent ---------------------------------
{
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const t = (k) => dict.en[k];
  assert.ok(isValidStatusEmoji('🦄') && isValidStatusEmoji('👨‍👩‍👧') && isValidStatusEmoji('🛋️'));
  for (const bad of ['', ' ', 'a', '12', 'ab😀', '😀 😀', 'x'.repeat(20), '😀'.repeat(9)]) assert.equal(isValidStatusEmoji(bad), false, JSON.stringify(bad));
  let moods = [];
  const r1 = addCustomMood(moods, { emoji: '🦄', label: '  Magical   day ', preset: 4 }, () => 0.5, () => 1000);
  assert.ok(r1.ok); moods = r1.list;
  assert.equal(moods[0].label, 'Magical day', 'spaces collapsed'); assert.equal(moods[0].preset, 4);
  assert.equal(addCustomMood(moods, { emoji: '🦄', label: 'x', preset: 0 }).reason, 'duplicate', 'own emoji twice');
  assert.equal(addCustomMood(moods, { emoji: '😀', label: 'x', preset: 0 }).reason, 'duplicate', 'a built-in emoji');
  assert.equal(addCustomMood(moods, { emoji: '🛋', label: 'x', preset: 0 }).reason, 'duplicate', 'variation selector ignored');
  assert.equal(addCustomMood(moods, { emoji: 'q', label: 'x', preset: 0 }).reason, 'emoji');
  assert.equal(addCustomMood(moods, { emoji: '🐢', label: '   ', preset: 0 }).reason, 'label');
  assert.equal(addCustomMood(moods, { emoji: '🐢', label: 'Slow', preset: 99 }).item.preset, 0, 'bad preset falls back');
  const a1 = addCustomActivity([], { emoji: '🎳', label: 'Bowling' });
  assert.ok(a1.ok);
  assert.equal(addCustomActivity(a1.list, { emoji: '🎳', label: 'Bowling 2' }).ok, true, 'activities may share an emoji (the id identifies them)');
  assert.equal(editCustom(moods, moods[0].id, { label: '  ' }), null, 'empty label refused');
  assert.equal(editCustom(moods, moods[0].id, { label: 'New', preset: 2 })[0].label, 'New');
  assert.deepEqual(removeCustom(moods, moods[0].id), []);
  // labels: an override replaces the default, an empty or default text resets it
  let labels = setLabelOverride({}, moodKey('neutral'), 'بی‌حس', t('moodName_neutral'));
  assert.deepEqual(labels, { 'm:neutral': 'بی‌حس' });
  const shown = resolveMoods(moods, labels, t);
  assert.equal(shown.length, MOODS.length + moods.length);
  assert.equal(findMood(shown, '😐').label, 'بی‌حس'); assert.equal(findMood(shown, '😐').edited, true);
  assert.equal(findMood(shown, '😀').label, t('moodName_happy')); assert.equal(findMood(shown, '🦄').custom, true);
  assert.deepEqual(setLabelOverride(labels, moodKey('neutral'), '', t('moodName_neutral')), {});
  assert.deepEqual(setLabelOverride(labels, moodKey('neutral'), t('moodName_neutral'), t('moodName_neutral')), {});
  const acts = resolveActivities(a1.list, setLabelOverride({}, activityKey('movie'), 'Cinema', t('actName_movie')), t);
  assert.equal(findActivity(acts, 'movie').label, 'Cinema'); assert.equal(findActivity(acts, a1.list[0].id).label, 'Bowling'); assert.equal(findActivity(acts, 'nope'), undefined);
  // what the partner receives
  assert.equal(statusText(findMood(resolveMoods([], {}, t), '😀'), undefined), '', 'plain built-in mood: nothing extra (their phone has its own name)');
  assert.equal(statusText(findMood(shown, '🦄'), undefined), 'New'.length ? 'Magical day' : '', 'own mood: its label');
  assert.equal(statusText(findMood(shown, '😐'), findActivity(acts, 'movie')), 'بی‌حس · 🎬 Cinema', 'edited mood + activity as sent');
  assert.equal(statusText(undefined, findActivity(acts, 'gym')), '🏋️ Gym');
  // screen wiring (source guards: React Native screens cannot run here)
  const screen = src('../app/(tabs)/status.tsx');
  assert.match(screen, /setEmoji\(\(cur\) => \(cur === e \? '' : e\)\)/, 'tap the picked mood again to un-pick it');
  assert.match(screen, /statusText\(mood, activity\)/); assert.match(screen, /text, intensity: 3, activity: activityId/);
  assert.match(screen, /onLongPress=\{\(\) => openEdit/); assert.match(screen, /onTrailingPress=\{\(\) => openAdd\('mood'\)\}/);
  assert.match(screen, /saveMoodLocal\(db, \{ emoji, activity: activityId \|\| null, text \}\)/);
  assert.match(src('../app/settings/status-items.tsx'), /resolveMoods\(customMoods, labels, t\)/);
  assert.match(src('../src/state/settings-store.ts'), /statusCustomMoods: \[\]/);
  assert.match(src('../components/status/HistorySheet.tsx'), /resolveMoods/);
  assert.match(src('../src/partner/manage.ts'), /activity: mood\.activity \?\? null/, 'a sent status keeps its activity on this phone');
  const { MOOD_PALETTE, MOOD_PRESETS, moodColorsFor } = await import('../src/partner/mood-colors.ts');
  assert.ok(moodColorsFor('🦄', [{ emoji: '🦄', preset: 4 }]) === MOOD_PRESETS[4].colors, 'own mood takes its preset');
  assert.equal(moodColorsFor('🦄', []), undefined); assert.equal(moodColorsFor('😀', [{ emoji: '😀', preset: 4 }]), MOOD_PALETTE.happy, 'built-ins win');
  for (const lang of ['en', 'fa']) for (const k of ['statusAdd', 'statusAddMood', 'statusAddActivity', 'statusEditMood', 'statusEditActivity', 'statusEmojiField', 'statusLabelField', 'statusColorField', 'statusResetLabel', 'statusDeleteItem', 'statusCatCustom', 'statusEmojiInvalid', 'statusEmojiDuplicate', 'statusLabelRequired', 'statusLimitReached', 'statusEditHint']) assert.ok(dict[lang][k], `${lang}.${k}`);
}
// ---- Q5: rename categories, hide their text -------------------------------------------------------
{
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const t = (k) => dict.en[k];
  assert.equal(categoryName('mood', 'neutral', {}, t), t('moodCatNeutral'), 'default name');
  let labels = setCategoryName({}, 'mood', 'neutral', '  بی‌حس ', t);
  assert.deepEqual(labels, { 'mc:neutral': 'بی‌حس' }, 'name persists in the labels map (spaces trimmed)');
  assert.equal(categoryName('mood', 'neutral', labels, t), 'بی‌حس');
  labels = setCategoryName(labels, 'activity', 'home', 'Home sweet home', t);
  assert.equal(labels['ac:home'], 'Home sweet home'); assert.equal(labels['mc:neutral'], 'بی‌حس', 'moods and activities do not clash');
  assert.deepEqual(setCategoryName(labels, 'mood', 'neutral', '', t), { 'ac:home': 'Home sweet home' }, 'empty = original name');
  assert.deepEqual(setCategoryName(labels, 'mood', 'neutral', t('moodCatNeutral'), t), { 'ac:home': 'Home sweet home' }, 'original text = no override');
  assert.equal(Object.keys(labels).some((k) => /^(m|a):/.test(k)), false, 'category keys never touch item keys');
  // chips: renamed text, emoji only when hidden, "All"/"Mine" stay
  let chips = categoryChips('mood', labels, [], t, true);
  assert.deepEqual(chips.slice(0, 2).map((c) => c.id), ['all', 'custom']);
  assert.equal(chips.find((c) => c.id === 'neutral').label, 'بی‌حس');
  let hidden = setNamesHidden([], categoryKey('mood', 'neutral'), true);
  chips = categoryChips('mood', labels, hidden, t, false);
  const hiddenChip = chips.find((c) => c.id === 'neutral');
  assert.equal(hiddenChip.label, categoryEmoji('mood', 'neutral')); assert.equal(hiddenChip.a11y, 'بی‌حس', 'screen readers still get the name');
  assert.equal(chips.find((c) => c.id === 'calm').label, t('moodCatCalm'), 'only that category is hidden');
  assert.equal(chips[0].label, t('statusCatAll'));
  assert.equal(namesHidden(hidden, 'mood', 'neutral'), true); assert.equal(namesHidden(hidden, 'activity', 'neutral'), false); assert.equal(namesHidden(hidden, 'mood', 'calm'), false);
  hidden = setNamesHidden(hidden, 'all', true);
  assert.equal(namesHidden(hidden, 'activity', 'home'), true, 'all = emoji only everywhere');
  assert.ok(categoryChips('activity', {}, hidden, t, false).slice(1).every((c) => c.label === categoryEmoji('activity', c.id)));
  assert.deepEqual(setNamesHidden(hidden, 'all', false), [categoryKey('mood', 'neutral')]); assert.deepEqual(setNamesHidden(setNamesHidden([], 'x', true), 'x', true), ['x'], 'no duplicates');
  for (const id of ['positive', 'energetic', 'calm', 'neutral', 'hard']) assert.ok(categoryEmoji('mood', id) !== '•', id);
  for (const id of ['entertainment', 'hobbies', 'health', 'social', 'home', 'travel']) assert.ok(categoryEmoji('activity', id) !== '•', id);
  // wiring + defaults + parity
  const settings = src('../src/state/settings-store.ts');
  assert.match(settings, /statusHiddenNames: \[\]/, 'reset (settingsDefaults) restores shown names');
  const screen = src('../app/(tabs)/status.tsx');
  assert.match(screen, /openCategory\('mood', id\)/); assert.match(screen, /openCategory\('activity', id\)/);
  assert.match(screen, /hideName=\{namesHidden\(hiddenNames, 'activity', a\.category\)\}/);
  assert.match(src('../components/status/CategoryChips.tsx'), /onLongPress/); assert.match(src('../app/settings/status-items.tsx'), /HIDE_ALL/);
  for (const lang of ['en', 'fa']) for (const k of ['statusEditCategory', 'statusShowCatName', 'statusShowAllNames', 'statusShowAllNamesDesc', 'statusEditHint']) assert.ok(dict[lang][k], `${lang}.${k}`);
}
console.log('status tests ok');
