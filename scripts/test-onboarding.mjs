import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mod from '../src/lib/onboarding.ts';

const m = mod.stepProgress ? mod : mod.default;
const { ONBOARDING_STEPS, stepProgress, previousStep, cleanName, isValidName, NAME_MAX, daysInMonth, birthdayYears, clampDay, defaultBirthdayParts, convertParts, birthdayToIso, ageOn } = m;

// steps and progress: growing, never empty, never full
assert.deepEqual(ONBOARDING_STEPS, ['name', 'gender', 'birthday', 'photo']);
assert.deepEqual(ONBOARDING_STEPS.map(stepProgress), [0.2, 0.4, 0.6, 0.8]);
assert.equal(previousStep('name'), null);
assert.equal(previousStep('gender'), 'name');
assert.equal(previousStep('birthday'), 'gender');
assert.equal(previousStep('photo'), 'birthday');

// name
assert.equal(cleanName('  Ali   Reza '), 'Ali Reza');
assert.equal(cleanName('x'.repeat(100)).length, NAME_MAX);
assert.equal(isValidName('   '), false);
assert.equal(isValidName(''), false);
assert.equal(isValidName('علی'), true);

// month lengths in both calendars
assert.equal(daysInMonth('gregorian', 2024, 2), 29);
assert.equal(daysInMonth('gregorian', 2023, 2), 28);
assert.equal(daysInMonth('gregorian', 2023, 12), 31);
assert.equal(daysInMonth('jalali', 1400, 1), 31);
assert.equal(daysInMonth('jalali', 1400, 7), 30);
assert.equal(daysInMonth('jalali', 1399, 12), 30); // leap
assert.equal(daysInMonth('jalali', 1400, 12), 29);
assert.deepEqual(clampDay('jalali', { year: 1400, month: 12, day: 30 }), { year: 1400, month: 12, day: 29 });
assert.deepEqual(clampDay('gregorian', { year: 2023, month: 2, day: 31 }), { year: 2023, month: 2, day: 28 });
assert.deepEqual(clampDay('gregorian', { year: 2023, month: 2, day: 0 }), { year: 2023, month: 2, day: 1 });

// year list: 111 entries, ascending, ends with the current year of that calendar
const now = new Date('2026-10-16T12:00:00Z'); // 24 Mehr 1405
const gy = birthdayYears('gregorian', now);
const jy = birthdayYears('jalali', now);
assert.equal(gy.length, 111);
assert.equal(gy.at(-1), 2026);
assert.equal(gy[0], 1916);
assert.equal(jy.at(-1), 1405);
assert.ok(gy.every((y, i) => i === 0 || y === gy[i - 1] + 1));
assert.deepEqual(defaultBirthdayParts('gregorian', now), { year: 2001, month: 1, day: 1 });
assert.deepEqual(defaultBirthdayParts('jalali', now), { year: 1380, month: 1, day: 1 });

// switching the calendar keeps the same day (11 Dey 1378 = 1 Jan 2000)
assert.deepEqual(convertParts('jalali', 'gregorian', { year: 1378, month: 10, day: 11 }), { year: 2000, month: 1, day: 1 });
assert.deepEqual(convertParts('gregorian', 'jalali', { year: 2000, month: 1, day: 1 }), { year: 1378, month: 10, day: 11 });
assert.deepEqual(convertParts('jalali', 'jalali', { year: 1378, month: 10, day: 11 }), { year: 1378, month: 10, day: 11 });

// storage: UTC ISO Gregorian only (brief rule 4), same date from either calendar
assert.equal(birthdayToIso('jalali', { year: 1378, month: 10, day: 11 }, now), '2000-01-01T00:00:00.000Z');
assert.equal(birthdayToIso('gregorian', { year: 2000, month: 1, day: 1 }, now), '2000-01-01T00:00:00.000Z');
assert.equal(birthdayToIso('gregorian', { year: 2023, month: 2, day: 30 }, now), null, 'invalid date');
assert.equal(birthdayToIso('gregorian', { year: 2026, month: 12, day: 1 }, now), null, 'future date');
assert.equal(birthdayToIso('gregorian', { year: 2026, month: 10, day: 16 }, now), '2026-10-16T00:00:00.000Z', 'today is allowed');

// age
assert.equal(ageOn('2000-01-01T00:00:00.000Z', now), 26);
assert.equal(ageOn('2000-10-17T00:00:00.000Z', now), 25);
assert.equal(ageOn('2000-10-16T00:00:00.000Z', now), 26);
assert.equal(ageOn('2030-01-01T00:00:00.000Z', now), 0);

// wiring (React Native files are read as text)
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const welcome = read('../app/welcome.tsx');
assert.match(welcome, /router\.push\('\/onboarding\/name'\)/, 'Get started opens the first step');
assert.doesNotMatch(welcome, /setSetting\('onboarded'/, 'welcome no longer finishes first run');
const layout = read('../app/_layout.tsx');
assert.match(layout, /Stack\.Screen name="onboarding"/);
const photo = read('../app/onboarding/photo.tsx');
assert.match(photo, /setSetting\('onboarded', true\)/, 'the last step finishes first run');
assert.match(photo, /MediaSourceSheet/);
for (const f of ['name', 'gender', 'birthday']) {
  assert.doesNotMatch(read(`../app/onboarding/${f}.tsx`), /setSetting\('onboarded'/, `${f} must not finish first run`);
}
const all = ['name', 'gender', 'birthday', 'photo'].map((f) => read(`../app/onboarding/${f}.tsx`)).join('\n') + read('../components/onboarding/OnboardingFrame.tsx');
assert.doesNotMatch(all, /sendProfile|sendMood|sendEvent|mailbox-client|partner\/manage/, 'onboarding never publishes');
assert.doesNotMatch(all, /(?:marginLeft|marginRight|paddingLeft|paddingRight|left:|right:)/, 'logical properties only');
assert.match(read('../app/onboarding/birthday.tsx'), /partner-store/);
assert.match(read('../app/onboarding/birthday.tsx'), /birthdayToIso/);
// gender is required: no skip, Next stays disabled until chosen; it feeds the Period screen
assert.match(read('../app/onboarding/gender.tsx'), /nextDisabled=\{!gender\}/);
assert.match(read('../app/period.tsx'), /gender !== 'male'/, 'men see only the partner cycle');
assert.match(read('../app/onboarding/name.tsx'), /onboarding\/gender/);
assert.match(read('../app/onboarding/gender.tsx'), /onboarding\/birthday/);
assert.match(read('../app/period.tsx'), /periodStartedBtn/);
assert.doesNotMatch(read('../app/period.tsx'), /periodPainBtn|periodBetterBtn|periodAgo|SegmentedControl/, 'one date + one button only');
assert.match(read('../src/partner/avatar.ts'), /width: 64, height: 64/, 'avatar is shrunk to 64 px');
assert.match(read('../src/partner/avatar.ts'), /AVATAR_FULL_WIDTH = 512/, 'R10c: a sharper 512 px copy is kept for the Shared upload');
assert.match(read('../src/partner/manage.ts'), /avatar-\$\{getDeviceId\(\)\}/, 'R10c: sendProfile uploads the sharper photo to Shared/avatar-<deviceId>');

// every new string exists in fa and en
const KEYS = ['onboardingNext', 'onboardingFinish', 'onboardingProgress', 'onboardingNameTitle', 'onboardingNameSubtitle', 'onboardingNameLabel',
  'onboardingNamePlaceholder', 'onboardingBirthdayTitle', 'onboardingBirthdaySubtitle', 'onboardingBirthdayWheel', 'onboardingPhotoTitle',
  'onboardingPhotoSubtitle', 'onboardingPhotoHint', 'onboardingPhotoChange', 'onboardingPhotoPermission', 'onboardingPhotoFailed',
  'onboardingGenderTitle', 'onboardingGenderSubtitle', 'onboardingGenderFemale', 'onboardingGenderMale'];
for (const lang of ['fa', 'en']) {
  const j = JSON.parse(read(`../src/i18n/locales/${lang}.json`));
  for (const k of KEYS) assert.ok(j[k] && j[k].length > 0, `${lang}.${k}`);
}
console.log('onboarding tests ok');
