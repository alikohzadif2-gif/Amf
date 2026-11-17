import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mod from '../src/lib/welcome.ts';

const m = mod.slideIndex ? mod : mod.default;
const { WELCOME_SLIDES, slideIndex, logicalIndexAt, welcomeTarget } = m;

// 4 slides in the planned order, with the 5.1 gradient colours
assert.deepEqual(WELCOME_SLIDES.map((s) => s.id), ['status', 'events', 'diary', 'gallery']);
assert.deepEqual(WELCOME_SLIDES.map((s) => s.color), ['#FEA4A4', '#93F2EC', '#FFD84F', '#7163EE']);
// LTR: identity. RTL: mirrored, and mirroring twice gives the same index
for (let i = 0; i < 4; i++) {
  assert.equal(slideIndex(i, 4, false), i);
  assert.equal(slideIndex(i, 4, true), 3 - i);
  assert.equal(slideIndex(slideIndex(i, 4, true), 4, true), i);
}
// scroll offset -> logical slide (width 400)
assert.equal(logicalIndexAt(0, 400, 4, false), 0);
assert.equal(logicalIndexAt(790, 400, 4, false), 2);
assert.equal(logicalIndexAt(5000, 400, 4, false), 3);
assert.equal(logicalIndexAt(-30, 400, 4, false), 0);
assert.equal(logicalIndexAt(0, 400, 4, true), 3); // RTL: list starts at the right = first slide, offset 0 is the LAST visual item
assert.equal(logicalIndexAt(1200, 400, 4, true), 0);
assert.equal(logicalIndexAt(10, 0, 4, false), 0);
// first-run gate: never decide before the settings are read
assert.equal(welcomeTarget(false, false), 'wait');
assert.equal(welcomeTarget(false, true), 'wait');
assert.equal(welcomeTarget(true, false), 'welcome');
assert.equal(welcomeTarget(true, true), 'app');

// wiring (React Native files are read as text)
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const store = read('../src/state/settings-store.ts');
assert.match(store, /onboarded: false,/, 'new installs start not onboarded');
assert.match(store, /version: 5,/);
assert.match(store, /version < 4\s*\?\s*\{ \.\.\.state, onboarded: true \}/, 'existing installs skip the welcome');
assert.match(store, /onboarded: state\.onboarded/, 'Reset settings keeps the first-run flag');
assert.match(store, /export function useSettingsHydrated/);
const layout = read('../app/_layout.tsx');
assert.match(layout, /useSettingsHydrated/);
assert.match(layout, /Stack\.Protected guard=\{target === 'welcome'\}/);
assert.match(layout, /Stack\.Protected guard=\{target === 'app'\}/);
const welcome = read('../app/welcome.tsx');
assert.match(welcome, /router\.push\('\/onboarding\/name'\)/); // U9: the button opens onboarding; the last step sets `onboarded`
assert.doesNotMatch(welcome, /google|Create (new )?account|Log ?in/i, 'no account buttons');
assert.equal((welcome.match(/<Button /g) ?? []).length, 1, 'exactly one button');
for (const lang of ['fa', 'en']) {
  const j = JSON.parse(read(`../src/i18n/locales/${lang}.json`));
  for (const k of ['welcomeTagline', 'welcomeStart', 'welcomePrevNext', 'welcomePrevDays', 'welcomePrevToday', 'welcomePrevPrivate',
    'welcomeS1Title', 'welcomeS1Text', 'welcomeS2Title', 'welcomeS2Text', 'welcomeS3Title', 'welcomeS3Text', 'welcomeS4Title', 'welcomeS4Text']) {
    assert.ok(j[k] && j[k].length > 0, `${lang}.${k}`);
  }
}
console.log('welcome tests ok');
