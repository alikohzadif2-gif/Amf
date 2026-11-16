import assert from 'node:assert/strict';
import * as colorModule from '../constants/colors.ts';
import {
  cardScaleForDisplay,
  navBarHeightForFontScale,
  radii,
  scaleNumericStyleValues,
  spacing,
  textScaleForDisplay,
} from '../constants/theme.ts';
import { rowOf, wheelLayout } from '../src/lib/layout.ts';
import { readFileSync } from 'node:fs';

const { accentColors, accentPressedColors, darken, defaultAccent, withAlpha } = colorModule;
// tsx may wrap the default export once more depending on the loader
const colors = colorModule.default?.light ? colorModule.default : colorModule.default.default;

// both palettes define exactly the same tokens, all as hex
const light = Object.keys(colors.light).sort();
assert.deepEqual(Object.keys(colors.dark).sort(), light, 'light and dark have the same keys');
// "Connected" must not look like an error: success is its own colour, not the coral accent or the error red.
for (const scheme of ['light', 'dark']) {
  assert.ok(/^#[0-9A-F]{6}$/i.test(colors[scheme].success), `${scheme} success is a 6-digit hex`);
  assert.notEqual(colors[scheme].success, colors[scheme].destructive, `${scheme} success differs from destructive`);
  assert.notEqual(colors[scheme].success, '#FF6B6B', `${scheme} success differs from the coral accent`);
}
for (const scheme of ['light', 'dark']) {
  for (const [key, value] of Object.entries(colors[scheme])) {
    assert.match(value, /^#[0-9A-F]{6}([0-9A-F]{2})?$/i, `${scheme}.${key} = ${value}`);
  }
}

// reference values from UI_PHASES.md 5.1
assert.equal(colors.dark.background, '#040B15');
assert.equal(colors.dark.card, '#112240');
assert.equal(colors.dark.sheet, '#0A1930');
assert.equal(colors.dark.navBar, '#0D1C33');
assert.equal(colors.dark.switchOn, '#2196F3');
assert.equal(colors.dark.moodSelected, '#9A28B1');
assert.equal(colors.dark.statusCardTint, '#261C35');
assert.equal(colors.light.chipSelected, '#0B1626', 'R4: selected chip is dark in the light theme');
assert.equal(colors.light.chipSelectedForeground, '#FFFFFF');
assert.equal(colors.light.background, '#F6F8FB');
assert.equal(colors.light.card, '#FFFFFF');
assert.equal(colors.light.border, '#E3E8F0');

// accents: coral is the default and the six old ones are still there
assert.equal(accentColors.coral, '#FF6B6B');
assert.equal(defaultAccent, 'coral');
// the store (React Native imports, so it is read as text here) uses that default and keeps theme = auto (Q6)
const store = readFileSync(new URL('../src/state/settings-store.ts', import.meta.url), 'utf8');
assert.match(store, /accent: defaultAccent,/);
assert.match(store, /theme: 'auto',/);
assert.match(store, /version: 5,/);
assert.match(store, /displaySize: 'normal',/);
assert.deepEqual(
  ['small', 'normal', 'large', 'extraLarge'].map((size) => textScaleForDisplay(size)),
  [0.88, 1, 1.12, 1.24],
);
assert.deepEqual(
  ['small', 'normal', 'large', 'extraLarge'].map((size) => cardScaleForDisplay(size)),
  [0.9, 1, 1.1, 1.2],
);
assert.deepEqual(
  scaleNumericStyleValues({ fontSize: 16, lineHeight: 24, opacity: 0.6 }, ['fontSize', 'lineHeight'], 1.25),
  { fontSize: 20, lineHeight: 30, opacity: 0.6 },
);
for (const name of ['teal', 'amber', 'blue', 'green', 'violet', 'slate']) assert.ok(accentColors[name], name);
assert.equal(accentPressedColors.coral, '#FF5353');

// helpers
assert.equal(withAlpha('#FF6B6B', 0.35), '#FF6B6B59');
assert.equal(withAlpha('#FF6B6B', 0.4), '#FF6B6B66');
assert.equal(withAlpha('#FF6B6B', 2), '#FF6B6BFF');
assert.equal(withAlpha('red', 0.5), 'red');
assert.equal(darken('#FFFFFF', 0.5), '#808080');
assert.equal(darken('#000000', 0.9), '#000000');

// radii/spacing sanity
assert.equal(radii.pill, 999);
assert.ok(radii.card >= 24 && radii.card <= 32 && radii.tile >= 18 && radii.tile <= 20 && radii.sheetTop === 28);
assert.ok(spacing.sm < spacing.md && spacing.md < spacing.lg);
assert.equal(rowOf(true), 'row', 'RTL rows use inherited Yoga direction, not a second reversal');
assert.equal(rowOf(false), 'row');
assert.deepEqual(wheelLayout(1), { itemHeight: 40, visibleRows: 7 });
assert.deepEqual(wheelLayout(2), { itemHeight: 108, visibleRows: 3 });
assert.equal(navBarHeightForFontScale(1), 72);
assert.equal(navBarHeightForFontScale(2), 116);
console.log('theme tests ok');

// UI kit helpers (U4): section labels are uppercase + spaced for Latin text only, never for Persian
const { sectionLabelText, sectionLabelSpacing } = await import('../src/lib/ui-text.ts');
assert.equal(sectionLabelText('this week', 'en'), 'THIS WEEK');
assert.equal(sectionLabelText('این هفته', 'fa'), 'این هفته');
assert.equal(sectionLabelSpacing('en', 1.1), 1.1);
assert.equal(sectionLabelSpacing('fa', 1.1), 0);
console.log('ui-text tests ok');

const tabBar = readFileSync(new URL('../components/ui/FloatingTabBar.tsx', import.meta.url), 'utf8');
assert.match(tabBar, /direction: isRTL \? 'rtl' : 'ltr'/);
assert.doesNotMatch(tabBar, /numberOfLines=\{1\}/, 'tab labels can wrap at large font scales');
const frame = readFileSync(new URL('../components/ScreenFrame.tsx', import.meta.url), 'utf8');
assert.match(frame, /const direction = isRTL \? 'rtl' : 'ltr'/, 'screen content owns its layout direction');
const bottomSheet = readFileSync(new URL('../components/ui/BottomSheet.tsx', import.meta.url), 'utf8');
assert.match(bottomSheet, /StyleSheet\.absoluteFill, \{ direction: isRTL \? 'rtl' : 'ltr' \}/, 'overlays set their own layout direction');
const activityTile = readFileSync(new URL('../components/status/ActivityTile.tsx', import.meta.url), 'utf8');
assert.match(activityTile, /ACTIVITY_TILE_WIDTH = 172/);
assert.match(activityTile, /effectiveFontScale - 1/, 'activity tile width grows with app and system text scaling');
const chip = readFileSync(new URL('../components/ui/Chip.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(chip, /numberOfLines=\{1\}/, 'chips wrap long localized labels');
const notFound = readFileSync(new URL('../app/+not-found.tsx', import.meta.url), 'utf8');
assert.match(notFound, /useI18n/);
const errorFallback = readFileSync(new URL('../components/ErrorFallback.tsx', import.meta.url), 'utf8');
assert.match(errorFallback, /useI18n/);
for (const lang of ['fa', 'en']) {
  const dict = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
  for (const key of ['errorTitle', 'errorMessage', 'errorRetry', 'errorDetails', 'errorViewDetails', 'errorCloseDetails', 'notFoundTitle', 'notFoundMessage', 'notFoundHome']) {
    assert.ok(dict[key], `${lang}.${key}`);
  }
}

// UI kit B helpers (U5)
const { clampProgress, shouldDismissSheet } = await import('../src/lib/ui-text.ts');
assert.equal(clampProgress(0.4), 0.4);
assert.equal(clampProgress(-1), 0);
assert.equal(clampProgress(7), 1);
assert.equal(clampProgress(Number.NaN), 0);
assert.equal(shouldDismissSheet(-20, 2, 400), false, 'dragging up never closes');
assert.equal(shouldDismissSheet(50, 0.1, 400), false, 'short slow drag springs back');
assert.equal(shouldDismissSheet(130, 0.1, 400), true, 'more than 30% of the height closes');
assert.equal(shouldDismissSheet(20, 1.2, 400), true, 'a fast flick closes');
console.log('ui kit B tests ok');

// Navigation shell (U6): route files match UI_PHASES section 6 and nothing links to the old names
import { existsSync, readFileSync as readF } from 'node:fs';
for (const f of ['index', 'status', 'explore', 'events', 'diary']) assert.ok(existsSync(`app/(tabs)/${f}.tsx`), `tab ${f}`);
for (const f of ['mood', 'dates', 'settings']) assert.ok(!existsSync(`app/(tabs)/${f}.tsx`), `old tab ${f} is gone`);
assert.ok(existsSync('app/settings/index.tsx'), 'Settings stack screen');
const tabsLayout = readF('app/(tabs)/_layout.tsx', 'utf8');
for (const n of ["'index'", "'status'", "'explore'", "'events'", "'diary'"]) assert.ok(tabsLayout.includes(`name: ${n}`), n);
console.log('navigation shell tests ok');

// U22: Settings uses shared rows; profile edits remain local and reuse the U9 date wheel/media kit.
const settingsScreen = readF('app/settings/index.tsx', 'utf8');
assert.match(settingsScreen, /settingsGeneral/);
assert.match(settingsScreen, /MAIN_SECTION_IDS = new Set\(\['google-drive', 'media-cache', 'security', 'tools'\]\)/);
assert.match(settingsScreen, /MAIN_SECTION_IDS\.has\(section\.id\) \|\| !!section\.flag/, 'feature-flagged groups remain reachable when enabled');
assert.match(settingsScreen, /router\.push\('\/settings\/profile'\)/);
const profileScreen = readF('app/settings/profile.tsx', 'utf8');
assert.match(profileScreen, /DateWheel/);
assert.match(readF('components/ui/DateWheel.tsx', 'utf8'), /WheelPicker/, 'Q7: the profile wheels moved to the shared DateWheel');
assert.match(profileScreen, /MediaSourceSheet/);
assert.match(profileScreen, /pickAvatarFrom/);
assert.match(profileScreen, /setTogetherSince/);
assert.match(profileScreen, /refreshWidget/);
assert.match(profileScreen, /sendProfile/, 'R10c: a saved profile (name, photo) reaches the partner when paired');
assert.doesNotMatch(profileScreen, /partner-profile/);
assert.match(profileScreen, /avatarUri/);
for (const lang of ['fa', 'en']) {
  const dict = JSON.parse(readF(`src/i18n/locales/${lang}.json`, 'utf8'));
  for (const key of [
    'settingsGeneral', 'system', 'profileEdit', 'profileLocalOnly', 'profileSaveLocal',
    'profileSavedLocal', 'profileDateHint', 'profileDateAdd', 'profileDateRemove',
    'profileNoDate', 'displaySize', 'displaySizeSmall', 'displaySizeNormal',
    'displaySizeLarge', 'displaySizeExtraLarge',
  ]) {
    assert.ok(dict[key] && dict[key].length > 0, `${lang}.${key}`);
  }
}
assert.match(settingsScreen, /value=\{settings\.displaySize\}/, 'display size preference is adjustable in Settings');
assert.match(settingsScreen, /displaySizeExtraLarge/, 'all four display size choices are offered');
for (const sourceFile of [
  'app/(tabs)/index.tsx',
  'app/(tabs)/events.tsx',
  'app/(tabs)/status.tsx',
  'components/events/EventItem.tsx',
  'components/diary/DiaryCard.tsx',
  'components/status/StickyMoodCard.tsx',
]) {
  assert.match(readF(sourceFile, 'utf8'), /components\/ui\/ScaledText/, `${sourceFile} uses app-wide text scaling`);
}
console.log('settings U22 tests ok');

// U23: Settings links, legal copy and widget refresh stay reachable and bilingual.
const settingsSource = settingsScreen;
assert.match(settingsSource, /router\.push\('\/library'\)/, 'Settings opens the existing Library');
assert.match(settingsSource, /router\.push\('\/settings\/widget'\)/);
assert.match(settingsSource, /settingsLegal/);
assert.match(settingsSource, /router\.push\('\/settings\/privacy'\)/);
assert.match(settingsSource, /router\.push\('\/settings\/terms'\)/);
assert.match(settingsSource, /ResetSettingsRow/);
assert.ok(existsSync('app/settings/widget.tsx'));
assert.ok(existsSync('app/settings/privacy.tsx'));
assert.ok(existsSync('app/settings/terms.tsx'));
const widgetScreen = readF('app/settings/widget.tsx', 'utf8');
assert.match(widgetScreen, /refreshWidget\(\)/, 'Refresh now calls the existing widget refresh');
const toolsSection = readF('src/settings/sections/ToolsSection.tsx', 'utf8');
assert.doesNotMatch(toolsSection, /resetSettings/, 'Reset is moved to the Account group, not duplicated in Tools');
for (const lang of ['fa', 'en']) {
  const dict = JSON.parse(readF(`src/i18n/locales/${lang}.json`, 'utf8'));
  for (const key of [
    'settingsLegal', 'settingsAccount', 'widgetSetup', 'widgetSetupDesc', 'widgetIntro',
    'widgetSetupSteps', 'widgetStepOne', 'widgetStepTwo', 'widgetStepThree',
    'widgetRefreshNow', 'widgetRefreshAttempted', 'privacyPolicy', 'privacyDataTitle',
    'privacyDataBody', 'privacyTrackingTitle', 'privacyTrackingBody', 'privacyMediaTitle',
    'privacyMediaBody', 'termsOfService', 'termsUseTitle', 'termsUseBody',
    'termsStorageTitle', 'termsStorageBody', 'termsResetTitle', 'termsResetBody',
  ]) {
    assert.ok(dict[key] && dict[key].length > 0, `${lang}.${key}`);
  }
}
console.log('settings U23 tests ok');

// S11: the Privacy Policy and Terms screens describe the real behaviour (own server, FCM, no analytics, no deletes)
// in fa and en, and every key a screen uses exists in both languages.
{
  const dicts = Object.fromEntries(['fa', 'en'].map((lang) => [lang, JSON.parse(readF(`src/i18n/locales/${lang}.json`, 'utf8'))]));
  for (const file of ['app/settings/privacy.tsx', 'app/settings/terms.tsx']) {
    const source = readF(file, 'utf8');
    const keys = [...source.matchAll(/(?:heading|body):\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
    assert.ok(keys.length >= 10, `${file} uses its blocks`);
    for (const lang of ['fa', 'en']) for (const key of keys) assert.ok(dicts[lang][key]?.length > 0, `${lang}.${key} (${file})`);
  }
  const text = (lang, prefix) => Object.entries(dicts[lang]).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v).join('\n');
  const legal = { en: text('en', 'privacy') + '\n' + text('en', 'terms'), fa: text('fa', 'privacy') + '\n' + text('fa', 'terms') };
  for (const re of [/your own server/i, /30 days/, /1000/, /HTTPS/, /SecureStore/, /FCM/, /no analytics/i, /never deletes anything on the server/i, /setup\.sh devices/, /setup\.sh revoke <id>/, /lockout|refuses that address/i, /never logs tokens/i]) {
    assert.match(legal.en, re, `en legal text mentions ${re}`);
  }
  for (const re of [/سرور شخصی خودتان/, /۳۰ روز/, /۱۰۰۰/, /HTTPS/, /SecureStore/, /FCM/, /بدون تحلیل رفتار، بدون تبلیغ/, /هرگز چیزی را روی سرور پاک نمی‌کند/, /setup\.sh devices/, /setup\.sh revoke <id>/, /هرگز توکن، نام فایل یا متن پیام را ثبت نمی‌کند/]) {
    assert.match(legal.fa, re, `fa legal text mentions ${re}`);
  }
  // R8a: memories are shared with the partner once paired; the old "Diary entries are not sent" line is gone.
  assert.match(legal.en, /memory and its deletion are sent to your partner/);
  assert.match(legal.fa, /حذفش برای همراه فرستاده می‌شود/);
  assert.doesNotMatch(legal.en + legal.fa, /Diary entries are not sent to your partner|خاطرات برای همراه شما فرستاده نمی‌شوند/);
  // The old "everything stays on the phone / no sync / no backup" statements must be gone.
  for (const re of [/Partner sync is turned off/i, /no cloud sync or automatic backup/i, /stored on this device\. If you add/i, /همگام‌سازی همراه خاموش است/, /پشتیبان‌گیری خودکار ندارد/]) {
    assert.doesNotMatch(legal.en + legal.fa, re);
  }
}
console.log('legal S11 tests ok');
