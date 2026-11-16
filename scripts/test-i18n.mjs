import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (lang) =>
  JSON.parse(readFileSync(new URL(`../src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
const en = load('en');
const fa = load('fa');

const enKeys = Object.keys(en).sort();
const faKeys = Object.keys(fa).sort();
assert.deepEqual(enKeys, faKeys, 'en and fa must have exactly the same keys');
for (const key of enKeys) {
  const e = en[key];
  const f = fa[key];
  if (Array.isArray(e)) {
    assert.equal(e.length, f.length, `array length differs for ${key}`);
  } else {
    assert.ok(typeof e === 'string' && e.trim() !== '', `empty en value: ${key}`);
    assert.ok(typeof f === 'string' && f.trim() !== '', `empty fa value: ${key}`);
  }
}
console.log(`i18n parity ok (${enKeys.length} keys)`);
