// Shared gallery, stage 1: fast add (no checksums), file-manager order, app-wide resumable transfer, the rename. Pure logic + source wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deleteVerdict, naturalCompare, sortEntries, uniqueRelPath } from '../src/vault/logic.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const names = (list) => list.map((e) => e.name);

// ---- natural order: the order of a file manager, stable and total
assert.deepEqual(['IMG_10.jpg', 'IMG_2.jpg', 'IMG_1.jpg', 'img_3.jpg'].sort(naturalCompare), ['IMG_1.jpg', 'IMG_2.jpg', 'img_3.jpg', 'IMG_10.jpg']);
assert.deepEqual(['b', 'A', 'a', 'B'].sort(naturalCompare), ['A', 'a', 'B', 'b'], 'case-insensitive, ties broken by the raw text so the order is total');
assert.equal(naturalCompare('x', 'x'), 0);
assert.ok(naturalCompare('a2', 'a10') < 0 && naturalCompare('a10', 'a2') > 0);
assert.ok(naturalCompare('a01', 'a1') !== 0, 'different zero padding is not "equal"');
assert.ok(naturalCompare('a1', 'a1b') < 0, 'a prefix comes first');
assert.ok(naturalCompare('file 9', 'file 10') < 0);
assert.ok(naturalCompare('99999999999999999999', '100000000000000000000') < 0, 'long numbers do not overflow');
{
  const shuffled = Array.from({ length: 200 }, (_, i) => `Day ${(i * 37) % 200} IMG_${(i * 11) % 50}.jpg`);
  const once = [...shuffled].sort(naturalCompare);
  assert.deepEqual([...once].reverse().sort(naturalCompare), once, 'sorting is deterministic whatever the input order');
  for (let i = 1; i < once.length; i += 1) assert.ok(naturalCompare(once[i - 1], once[i]) <= 0);
}
// folders first, then files (a folder named "Z" still precedes the file "A.jpg")
assert.deepEqual(
  names(sortEntries([{ name: 'A.jpg', dir: false }, { name: 'Z', dir: true }, { name: 'b', dir: true }, { name: 'IMG_10.jpg', dir: false }, { name: 'IMG_9.jpg', dir: false }])),
  ['b', 'Z', 'A.jpg', 'IMG_9.jpg', 'IMG_10.jpg'],
);
{
  const input = [{ name: 'b', dir: false }];
  assert.notEqual(sortEntries(input), input, 'a new array, the input is untouched');
}

// ---- unique names keep the order of the scan (a clash gets " (2)", never overwrites)
{
  const taken = new Set();
  const out = ['Trip/a.jpg', 'Trip/a.jpg', 'Trip/b.jpg'].map((rel) => {
    const next = uniqueRelPath(rel, taken);
    taken.add(next);
    return next;
  });
  assert.deepEqual(out, ['Trip/a.jpg', 'Trip/a (2).jpg', 'Trip/b.jpg']);
}

// ---- the original is deleted only when the copy has exactly the size the source has now (no checksum)
assert.equal(deleteVerdict({ mode: 'move', sourceSize: 5, targetSize: 5 }), 'delete');
assert.equal(deleteVerdict({ mode: 'move', sourceSize: 5, targetSize: 4 }), 'mismatch');
assert.equal(deleteVerdict({ mode: 'move', sourceSize: 5, targetSize: -1 }), 'mismatch', 'an unreadable copy never deletes the original');
assert.equal(deleteVerdict({ mode: 'move', sourceSize: null, targetSize: 5 }), 'unverified');
assert.equal(deleteVerdict({ mode: 'move', sourceSize: Number.NaN, targetSize: 5 }), 'unverified');
assert.equal(deleteVerdict({ mode: 'copy', sourceSize: 5, targetSize: 5 }), 'copy-mode');

// ---- wiring (no phone APIs in Node, so the source is read)
{
  const saf = read('src/vault/saf.ts');
  assert.ok(!/statOf|md5/.test(saf), 'scanning never hashes a file (7 GB must not be read to be listed)');
  assert.ok(/sortEntries\(named\)/.test(saf), 'the scan lists folders first, then files, in natural order');
  const imp = read('src/vault/import.ts');
  const code = imp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/md5|compareSources|openFileReader|statOf|Crypto\.digest/.test(code.replace(/md5: null/g, '')), 'no checksum in the add engine');
  assert.ok(/sizeOf\(target\)/.test(code) && /size-mismatch/.test(code), 'the copy is checked by size');
  assert.ok(/source\.delete\(\)/.test(code) && /verdict !== 'delete'/.test(code), 'delete only on a "delete" verdict');
  assert.ok(/if \(busy\) return/.test(code), 'one transfer at a time');
  assert.ok(/export async function resumeOpenJobs/.test(code) && /openJobs\(db\)/.test(code), 'open jobs can be resumed');
  assert.ok(!/foreground/i.test(imp), 'no always-on service (removed in S10)');
  const add = read('app/vault-add.tsx');
  assert.ok(!/pauseJob\(\); \}, \[\]\)/.test(add), 'leaving the add screen does not pause the transfer');
  assert.ok(/useState<ImportMode \| null>\('copy'\)/.test(add), 'copy is preselected');
  assert.ok(/mode === 'copy'/.test(add) && /void start\('copy'\)/.test(add), 'copy starts without a confirmation');
  assert.ok(/vaultConfirmMoveTitle/.test(add), 'move still asks once');
  const layout = read('app/_layout.tsx');
  assert.ok(/resumeOpenJobs\(db\)/.test(layout), 'an unfinished transfer continues after the app starts');
  assert.ok(/naturalCompare\(a\.name, b\.name\)/.test(read('src/storage/vault-provider.ts')), 'the vault is listed in the same order the scan used');
}

// ---- the rename: only the vault strings changed; the chat is still called Direct
{
  const en = JSON.parse(read('src/i18n/locales/en.json'));
  const fa = JSON.parse(read('src/i18n/locales/fa.json'));
  const vaultKeys = Object.keys(en).filter((k) => k.startsWith('vault') || k === 'libSrcVault');
  for (const k of vaultKeys) {
    assert.ok(!/Direct|دایرکت/.test(en[k]) && !/Direct|دایرکت/.test(fa[k]), `${k}: no "Direct" left in a vault string`);
  }
  assert.equal(en.libSrcVault, 'Shared gallery');
  assert.equal(fa.libSrcVault, 'گالری مشترک');
  assert.equal(en.vaultTitle, 'Shared gallery');
  assert.equal(fa.vaultTitle, 'گالری مشترک');
  for (const k of ['viewerSendDirect', 'directSent', 'directOpenChat', 'storyReplySent', 'storyReplyFailed']) {
    assert.ok(/Direct/.test(en[k]), `en ${k} still names the chat`);
    assert.ok(/دایرکت/.test(fa[k]), `fa ${k} still names the chat`);
  }
  for (const k of ['vaultModeMoveDesc', 'vaultConfirmMoveBody', 'vaultDoneKept']) {
    assert.ok(!/checksum|MD5|hash/i.test(en[k]) && !/هش|چک‌سام/.test(fa[k]), `${k} no longer promises a checksum`);
  }
}

console.log('shared gallery (stage 1): ok');
