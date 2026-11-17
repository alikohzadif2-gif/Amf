// Sharing track, stage 5: private vault rules (paths, space, verified delete, trash), the "vault" source kind, backup exclusion, translations.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import {
  SPACE_MARGIN_BYTES, TRASH_DAYS, cleanSegment, deleteVerdict, displayName, enoughSpace, isSafeRel, joinRel, likeBelow, relFromUri, spaceNeeded,
  topOf, totalsOf, trashDaysLeft, trashExpired, uniqueRelPath,
} from '../src/vault/logic.ts';
import { isPhoneKind } from '../src/storage/types.ts';
import { sortRefs } from '../src/library/merge.ts';
import { analyzeStorage } from '../src/tools/storage-stats.ts';
import { applySourceMode, DEFAULT_SOURCE_MODE, SOURCE_MODES, sourceKindOf } from '../src/library/source-mode.ts';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---- names and paths stay inside the vault
assert.equal(cleanSegment('a/b\\c:d*e?.jpg'), 'a_b_c_d_e_.jpg');
assert.equal(cleanSegment('..'), '_');
assert.equal(cleanSegment('.trash'), 'trash', 'a name can never become the hidden trash folder');
assert.equal(cleanSegment('   '), '_');
assert.ok(cleanSegment('x'.repeat(300) + '.mp4').endsWith('.mp4') && cleanSegment('x'.repeat(300) + '.mp4').length <= 120);
assert.equal(joinRel('Holiday', 'IMG 1.jpg'), 'Holiday/IMG 1.jpg');
assert.equal(isSafeRel('Holiday/a.jpg'), true);
for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', '.trash/x', 'a/.hidden']) assert.equal(isSafeRel(bad), false, bad);
assert.equal(topOf('Holiday/day1/a.jpg'), 'Holiday');
assert.equal(topOf('a.jpg'), 'a.jpg');

// ---- unique names (never overwrite)
const taken = new Set(['Holiday/a.jpg', 'Holiday/a (2).jpg', 'note']);
assert.equal(uniqueRelPath('Holiday/b.jpg', taken), 'Holiday/b.jpg');
assert.equal(uniqueRelPath('Holiday/a.jpg', taken), 'Holiday/a (3).jpg');
assert.equal(uniqueRelPath('note', taken), 'note (2)');

// ---- free-space check: a copy needs everything, a move only the largest file; the margin is always kept
const totals = totalsOf([100, 5_000, 300]);
assert.deepEqual(totals, { count: 3, bytes: 5_400, largest: 5_000 });
assert.equal(spaceNeeded('copy', totals), 5_400 + SPACE_MARGIN_BYTES);
assert.equal(spaceNeeded('move', totals), 5_000 + SPACE_MARGIN_BYTES);
assert.equal(enoughSpace('copy', totals, 5_400 + SPACE_MARGIN_BYTES), true);
assert.equal(enoughSpace('copy', totals, 5_399 + SPACE_MARGIN_BYTES), false);
assert.equal(enoughSpace('move', totals, 5_000 + SPACE_MARGIN_BYTES), true);
assert.deepEqual(totalsOf([]), { count: 0, bytes: 0, largest: 0 });

// ---- an original is deleted only in move mode, after size AND checksum match; otherwise it stays
const ok = { mode: 'move', sourceSize: 10, targetSize: 10, sourceMd5: 'AB12', targetMd5: 'ab12' };
assert.equal(deleteVerdict(ok), 'delete');
assert.equal(deleteVerdict({ ...ok, mode: 'copy' }), 'copy-mode', 'copy never deletes');
assert.equal(deleteVerdict({ ...ok, targetSize: 9 }), 'mismatch');
assert.equal(deleteVerdict({ ...ok, targetMd5: 'ffff' }), 'mismatch');
assert.equal(deleteVerdict({ ...ok, sourceMd5: undefined }), 'unverified', 'no checksum: keep the original');
assert.equal(deleteVerdict({ ...ok, targetMd5: null }), 'unverified');

// ---- trash: 30 days
assert.equal(TRASH_DAYS, 30);
const DAY = 86_400_000;
assert.equal(trashExpired(0, 30 * DAY - 1), false);
assert.equal(trashExpired(0, 30 * DAY), true);
assert.equal(trashDaysLeft(0, 0), 30);
assert.equal(trashDaysLeft(0, 29 * DAY + 1), 1);
assert.equal(trashDaysLeft(0, 40 * DAY), 0);

// ---- uri <-> relative path (a path outside the vault, or in the trash, is rejected)
const vault = 'file:///data/user/0/app/files/meyou-vault/';
assert.equal(relFromUri('file:///data/user/0/app/files/meyou-vault/Holiday/a%20b.jpg', vault), 'Holiday/a b.jpg');
assert.equal(relFromUri('file:///data/user/0/app/files/meyou-vault/Holiday/', vault), 'Holiday');
assert.equal(relFromUri('file:///data/user/0/app/files/other/a.jpg', vault), null);
assert.equal(relFromUri('file:///data/user/0/app/files/meyou-vault/.trash/x', vault), null);
assert.equal(relFromUri('file:///data/user/0/app/files/meyou-vault/../x.jpg', vault), null);
assert.equal(relFromUri('file:///data/user/0/app/files/meyou-vault-evil/a.jpg', vault), null, 'a sibling folder with the same prefix is not the vault');
assert.equal(displayName('primary%3ADCIM%2FCamera%2FIMG_1.jpg'), 'IMG_1.jpg');
assert.equal(displayName('primary:DCIM'), 'DCIM');
assert.equal(displayName('plain.jpg'), 'plain.jpg');
assert.equal(likeBelow('a_b%c'), 'a\\_b\\%c/%');

// ---- the vault is a phone kind
assert.equal(isPhoneKind('local') && isPhoneKind('vault'), true);
assert.equal(isPhoneKind(undefined), false);
{
  const kinds = { local: 'local', vault: 'vault' };
  const entry = (...ids) => ({ key: 'k', item: { id: 'x', parentId: null, name: 'a.jpg', type: 'image', size: 1, mtime: '2026-01-01T00:00:00Z' }, refs: ids.map((sourceId) => ({ sourceId, itemId: 'i' })) });
  assert.deepEqual(sortRefs(entry('vault', 'local').refs, kinds).map((r) => r.sourceId), ['local', 'vault']);
  const stats = analyzeStorage([entry('vault'), entry('local', 'vault')], kinds);
  assert.deepEqual(stats.bySource.vault, { count: 2, bytes: 2 });
  assert.deepEqual(stats.bySource.local, { count: 1, bytes: 1 });
}

// ---- Archive "Source": Direct (the vault) is the ONLY source since stage 2A-3 (the gallery source is gone)
assert.deepEqual([...SOURCE_MODES], ['vault']);
assert.equal(sourceKindOf('vault'), 'vault');
assert.equal(DEFAULT_SOURCE_MODE, 'vault');
{
  const kinds = { local: 'local', vault: 'vault' };
  const a = { key: 'a', item: { id: 'a', parentId: null, name: 'a', type: 'image', size: 1, mtime: '' }, refs: [{ sourceId: 'vault', itemId: '1' }] };
  const b = { key: 'b', item: { id: 'b', parentId: null, name: 'b', type: 'image', size: 1, mtime: '' }, refs: [{ sourceId: 'local', itemId: '2' }] };
  assert.deepEqual(applySourceMode([a, b], 'vault', kinds).map((e) => e.key), ['a']);
}

// ---- wiring that has no pure function: read the source
{
  const sources = read('src/state/sources-store.ts');
  assert.ok(/VAULT_SOURCE_ID = 'vault'/.test(sources) && /version: 6/.test(sources) && !/LOCAL_SOURCE/.test(sources), 'Direct is the only built-in source; the saved list drops `local`');
  assert.ok(/new VaultProvider/.test(read('src/storage/registry.ts')) && !/LocalProvider/.test(read('src/storage/registry.ts')));
  const indexer = read('src/library/indexer.ts');
  assert.ok(!/hidden: provider\.kind === 'vault'/.test(indexer), 'Direct (the vault) is no longer indexed as hidden: it shows in Explore, search, tags and albums');
  assert.ok(/isHiddenFolderName\(item\.name\)/.test(indexer), 'Shared/Snaps folders stay hidden by name');
  const provider = read('src/storage/vault-provider.ts');
  assert.ok(/throw new Error\('Vault files are deleted through the vault trash'\)/.test(provider), 'the provider cannot delete; deletion goes through the trash');
  assert.ok(/startsWith\('\.'\)/.test(provider), 'the trash folder is not listed in the Archive');
  const lib = read('app/library.tsx');
  assert.ok(/source === 'vault'/.test(lib) && /trashProviderIds/.test(lib) && /vault-add/.test(lib) && !/setTool\('source'\)/.test(lib), 'no Source tool any more');
  assert.ok(/vault-add/.test(read('src/settings/sections/PartnerNotificationsSection.tsx')), 'the sharing settings open the same add screen');
  const add = read('src/vault/import.ts');
  assert.ok(!/foreground/i.test(add), 'no foreground service');
  assert.ok(/deleteVerdict/.test(add) && /verdict !== 'delete'/.test(add), 'an original is deleted only on a "delete" verdict');
  const db = read('src/lib/database.ts');
  assert.ok(/migrateVault\(database\)/.test(db) && /vault_items_live/.test(db));
}

// ---- Android backup: the vault folder is excluded next to the partner pictures and SecureStore
{
  const plugin = require('../plugins/with-backup-exclude.js');
  assert.equal(plugin.EXCLUDE_VAULT, '<exclude domain="file" path="meyou-vault/"/>');
  const secure = '<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n  <exclude domain="sharedpref" path="SecureStore"/>\n</full-backup-content>\n';
  const patched = plugin.patchBackup(secure);
  assert.ok(patched.includes('SecureStore') && patched.includes(plugin.EXCLUDE) && patched.includes(plugin.EXCLUDE_VAULT));
  assert.equal(plugin.patchBackup(patched), patched, 'idempotent');
  const stage4 = secure.replace('</full-backup-content>', `  ${plugin.EXCLUDE}\n</full-backup-content>`);
  assert.ok(plugin.patchBackup(stage4).includes(plugin.EXCLUDE_VAULT), 'a project built at stage 4 gets the vault rule added');
  const ext = plugin.patchExtraction('<data-extraction-rules>\n  <cloud-backup>\n    <exclude domain="sharedpref" path="SecureStore"/>\n  </cloud-backup>\n  <device-transfer>\n    <exclude domain="sharedpref" path="SecureStore"/>\n  </device-transfer>\n</data-extraction-rules>\n');
  assert.equal(ext.split(plugin.EXCLUDE_VAULT).length - 1, 2, 'cloud backup and device transfer');
  assert.equal(ext.split('path="SecureStore"').length - 1, 2, 'SecureStore stays excluded');
  assert.equal(plugin.patchExtraction(ext), ext);
}

// ---- translations: every vault key exists in both languages
{
  const en = JSON.parse(read('src/i18n/locales/en.json'));
  const fa = JSON.parse(read('src/i18n/locales/fa.json'));
  const keys = Object.keys(en).filter((k) => k.startsWith('vault') || k === 'libSrcVault');
  assert.ok(keys.length >= 50);
  for (const k of keys) assert.ok(typeof fa[k] === 'string' && fa[k].trim() !== '', `fa ${k}`);
  const used = new Set();
  for (const file of ['app/vault.tsx', 'app/vault-add.tsx', 'app/library.tsx', 'src/settings/sections/PartnerNotificationsSection.tsx']) {
    for (const m of read(file).matchAll(/['"`](vault[A-Za-z]+|libSrcVault)['"`]/g)) used.add(m[1]);
  }
  for (const k of used) assert.ok(k in en, `used key exists: ${k}`);
}

// ---- Stage 2A-2: Direct thumbnails and adding picked files
{
  const t = await import('../src/vault/thumb-logic.ts');
  assert.equal(t.THUMB_FOLDER, '.thumbs');
  assert.equal(isSafeRel(`${t.THUMB_FOLDER}/x.jpg`), false, 'a user path can never point into the thumbnail folder');
  assert.equal(t.thumbEdge(undefined), 320);
  assert.equal(t.thumbEdge(256), 320);
  assert.equal(t.thumbEdge(320), 320);
  assert.equal(t.thumbEdge(321), 640);
  assert.equal(t.thumbEdge(1080), 640);
  const a = t.thumbName('Holiday/a.jpg', 320);
  assert.match(a, /^[0-9a-f]{16}\.320\.jpg$/);
  assert.equal(a, t.thumbName('Holiday/a.jpg', 320), 'stable');
  assert.notEqual(a, t.thumbName('Holiday/b.jpg', 320));
  assert.notEqual(a, t.thumbName('Holiday/a.jpg', 640));
  const names = new Set();
  for (let i = 0; i < 5000; i += 1) names.add(t.thumbName(`Album ${i % 50}/IMG_${i}.jpg`, 320));
  assert.equal(names.size, 5000, 'no collisions in 5000 realistic names');
  assert.equal(t.isThumbFresh(null, 5), false);
  assert.equal(t.isThumbFresh(undefined, undefined), false);
  assert.equal(t.isThumbFresh(10, null), true);
  assert.equal(t.isThumbFresh(10, 10), true);
  assert.equal(t.isThumbFresh(9, 10), false, 'a replaced file gets a new thumbnail');
  assert.deepEqual(t.fitEdge(4000, 3000, 320), { width: 320, height: 240, scaled: true });
  assert.deepEqual(t.fitEdge(3000, 4000, 320), { width: 240, height: 320, scaled: true });
  assert.deepEqual(t.fitEdge(200, 100, 320), { width: 200, height: 100, scaled: false }, 'never enlarges');
  assert.deepEqual(t.fitEdge(0, 0, 320), { width: 0, height: 0, scaled: false });

  const add = read('src/vault/direct-add.ts');
  assert.ok(/source\.size/.test(add) && /size-mismatch/.test(add), 'a copy is checked by size before it is recorded');
  assert.ok(/putItem\(db/.test(add) && /ensureThumb/.test(add), 'recorded in vault_items, thumbnail started');
  assert.ok(/isCacheCopy\(p\.uri\)/.test(add), 'only the picker cache copy is removed, never the original or a story file');
  assert.ok(!/MediaLibrary|local-provider/.test(add), 'no gallery write, no local provider');
  const imp = read('src/library/import-from-phone.ts');
  assert.ok(/addPickedToDirect/.test(imp) && !/getProvider|'local'/.test(imp), 'gallery, camera and files now copy into Direct, not the local library');
  const provider = read('src/storage/vault-provider.ts');
  assert.ok(/ensureThumb\(rel, type, thumbEdge\(size\)\)/.test(provider), 'grids get the small cached picture, not the original');
  assert.ok(/dropThumbs\(item\.rel\)/.test(read('src/vault/trash.ts')), 'thumbnails go with a file that leaves the vault folder');
  assert.ok(/setSharedDb\(db\)/.test(read('app/_layout.tsx')), 'the open database is handed to the pick kit');
}

console.log('vault (stage 5): ok');

// ---- Stage 2A-3 (part 1): the old library is copied into Direct and user data keeps its keys
{
  const l = await import('../src/vault/legacy-logic.ts');
  assert.deepEqual(l.legacyTarget('fs:file:///data/user/0/x/files/meyou-library/a.jpg', 'a.jpg'), { name: 'a.jpg' });
  assert.deepEqual(l.legacyTarget('fs:file:///data/files/meyou-library/Trip%202020/Day1/b.jpg', 'b.jpg'), { folder: 'Trip 2020 - Day1', name: 'b.jpg' });
  assert.deepEqual(l.legacyTarget('ml:asset:77', 'IMG_1.jpg'), { folder: 'Gallery', name: 'IMG_1.jpg' });
  const refs = l.parseRefs(JSON.stringify([{ sourceId: 'local', itemId: 'fs:x' }]));
  assert.equal(l.isLegacyOnly(refs), true);
  assert.equal(l.isLegacyOnly([...refs, { sourceId: 'vault', itemId: 'fs:y' }]), false, 'a file that already has a Direct copy is not copied again');
  assert.equal(l.isLegacyOnly(l.parseRefs('not json')), false);
  const map = new Map([['old1', 'new1'], ['old2', 'new1']]);
  assert.deepEqual(l.remapKeysJson('["old1","k","old2"]', map), { json: '["new1","k"]', changed: true }, 'two old keys of one file become one');
  assert.deepEqual(l.remapKeysJson('["k"]', map), { json: '["k"]', changed: false });
  assert.equal(l.remapKeysJson('oops', map).changed, false);
  const plan = l.planRemap({ a: 'Gallery/a.jpg', b: 'b.jpg', c: 'c.jpg' }, new Map([['Gallery/a.jpg', 'A'], ['b.jpg', 'b']]));
  assert.deepEqual([...plan], [['a', 'A']], 'only keys that changed are rewritten; a missing copy is left for the next launch');
  assert.deepEqual(l.parseLegacyState(null), { done: false, attempts: 0, copied: {}, src: {} });
  assert.equal(l.parseLegacyState('{"done":true,"attempts":2,"copied":{"a":"b"}}').done, true);

  const mig = read('src/vault/legacy-migrate.ts');
  assert.ok(!/runAsync\(`DELETE FROM (diary|events|vault_items)/.test(mig.replace(/DELETE FROM \$\{table\}/g, '')), 'the migration deletes no memory/event/vault row');
  assert.ok(/copy\.size \?\? -1\) === old\.size/.test(mig) && /removeVerifiedLegacyFiles/.test(mig), 'an old app-folder file is removed only after its Direct copy has the same size');
  assert.ok(!/Asset\.delete|ml:asset[^\n]*\.delete\(/.test(mig), 'gallery pictures are never deleted');
  assert.ok(/UPDATE OR IGNORE/.test(mig) && /withTransactionAsync/.test(mig), 'keys are rewritten in one transaction without overwriting');
  assert.ok(/addPickedToDirect/.test(mig) && /getPermissionsAsync/.test(mig) && !/requestPermissions/.test(mig), 'copies through the Direct add path and never asks for permission at start-up');
  assert.ok(/runLegacyMigration/.test(read('app/_layout.tsx')), 'started once after the database opens');
  assert.equal(existsSync(new URL('../src/storage/local-provider.ts', import.meta.url)), false, 'LocalProvider is removed');
}
