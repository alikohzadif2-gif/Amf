import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel } from '../src/widget/model.ts';

const NOW = new Date(2026, 9, 15, 23, 59); // 15 Oct 2026, local evening
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`;

// ---- no date yet -> hint, no number --------------------------------------------------------------
{
  const m = buildModel(null, null, NOW);
  assert.equal(m.days, null);
  assert.equal(m.title, 'روزهای با هم'); // default language is Persian
  assert.equal(m.line, 'روزی که با هم شدید را تعیین کنید');
  assert.equal(buildModel({ togetherSince: 'not a date' }, null, NOW).days, null);
}

// ---- counts the same days as Home, in the chosen digits ----------------------------------------
{
  const since = iso(2025, 10, 15); // exactly one year (365 days) before NOW
  assert.equal(buildModel({ togetherSince: since }, { digits: 'latin' }, NOW).days, '365');
  assert.equal(buildModel({ togetherSince: since }, { digits: 'persian' }, NOW).days, '۳۶۵');
  // today = day 0, a future date never shows a negative number
  assert.equal(buildModel({ togetherSince: iso(2026, 10, 15) }, { digits: 'latin' }, NOW).days, '0');
  assert.equal(buildModel({ togetherSince: iso(2026, 12, 1) }, { digits: 'latin' }, NOW).days, '0');
}

// ---- language, calendar and accent follow the settings -------------------------------------------
{
  const en = buildModel({ togetherSince: iso(2025, 10, 15) }, { language: 'en', digits: 'latin', calendarMode: 'gregorian', accent: 'blue' }, NOW);
  assert.equal(en.title, 'Days together');
  assert.equal(en.line, 'Since 15 October 2025');
  assert.equal(en.accent, 'blue');
  const fa = buildModel({ togetherSince: iso(2025, 10, 15) }, { calendarMode: 'jalali' }, NOW);
  assert.match(fa.line, /^از /);
  assert.match(fa.line, /۱۴۰۴/); // 15 Oct 2025 = 23 Mehr 1404
  assert.equal(buildModel(null, { language: 'en' }, NOW).line, 'Set the day you got together');
}

// ---- widget UI stays connected to the shared theme and accent tokens ------------------------------
{
  const widgetUi = readFileSync(new URL('../src/widget/DaysTogetherWidget.tsx', import.meta.url), 'utf8');
  const taskHandler = readFileSync(new URL('../src/widget/task-handler.tsx', import.meta.url), 'utf8');
  assert.match(widgetUi, /import colors, \{ accentColors \} from '@\/constants\/colors'/);
  assert.match(widgetUi, /const palette = colors\[theme\]/);
  assert.match(widgetUi, /backgroundColor: palette\.card/);
  assert.match(widgetUi, /color: palette\.mutedForeground/);
  assert.match(widgetUi, /accentColors\[model\.accent\]/);
  assert.match(taskHandler, /theme="light"/);
  assert.match(taskHandler, /theme="dark"/);
}

console.log('widget: ok');
