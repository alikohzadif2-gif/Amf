// Sharing track, stage 5: private vault rules (paths, space, verified delete, trash), the "vault" source kind, backup exclusion, translations.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  SPACE_MARGIN_BYTES, TRASH_DAYS, cleanSegment, deleteVerdict, displayName, enoughSpace, isSafeRel, joinRel, likeBelow, relFromUri, spaceNeeded,
  topOf, totalsOf, trashDaysLeft, trashExpired, uniqueRelPath,
} from '../src/vault/logic.ts';
import { isPhoneKind, isRemoteKind } from '../src/storage/types.ts';
import { itemState, sortRefs } from '../src/library/merge.ts';
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

// ---- the vault is a phone kind, never a backup
assert.equal(isPhoneKind('local') && isPhoneKind('vault'), true);
assert.equal(isPhoneKind('drive') || isPhoneKind('server'), false);
assert.equal(isRemoteKind('drive') && isRemoteKind('server'), true);
assert.equal(isRemoteKind('vault') || isRemoteKind('local') || isRemoteKind(undefined), false);
{
  const kinds = { local: 'local', vault: 'vault', drive: 'drive' };
  const entry = (...ids) => ({ key: 'k', item: { id: 'x', parentId: null, name: 'a.jpg', type: 'image', size: 1, mtime: '2026-01-01T00:00:00Z' }, refs: ids.map((sourceId) => ({ sourceId, itemId: 'i' })) });
  assert.equal(itemState(entry('vault'), kinds, new Set()), 'local-only', 'a vault copy is not a backup');
  assert.equal(itemState(entry('vault', 'local'), kinds, new Set()), 'local-only');
  assert.equal(itemState(entry('vault', 'drive'), kinds, new Set()), 'backed-up');
  assert.equal(itemState(entry('drive'), kinds, new Set()), 'cloud-only');
  assert.deepEqual(sortRefs(entry('drive', 'vault', 'local').refs, kinds).map((r) => r.sourceId), ['local', 'vault', 'drive']);
  const stats = analyzeStorage([entry('vault'), entry('local', 'vault')], kinds);
  assert.deepEqual(stats.bySource.vault, { count: 2, bytes: 2 });
  assert.deepEqual(stats.bySource.local, { count: 1, bytes: 1 });
}

// ---- Archive "Source": the vault is a fourth value; the default is unchanged in this stage
assert.ok(SOURCE_MODES.includes('vault'));
assert.equal(sourceKindOf('vault'), 'vault');
assert.equal(DEFAULT_SOURCE_MODE, 'phone');
{
  const kinds = { local: 'local', vault: 'vault' };
  const a = { key: 'a', item: { id: 'a', parentId: null, name: 'a', type: 'image', size: 1, mtime: '' }, refs: [{ sourceId: 'vault', itemId: '1' }] };
  const b = { key: 'b', item: { id: 'b', parentId: null, name: 'b', type: 'image', size: 1, mtime: '' }, refs: [{ sourceId: 'local', itemId: '2' }] };
  assert.deepEqual(applySourceMode([a, b], 'vault', kinds).map((e) => e.key), ['a']);
  assert.deepEqual(applySourceMode([a, b], 'phone', kinds).map((e) => e.key), ['b']);
}

// ---- wiring that has no pure function: read the source
{
  const sources = read('src/state/sources-store.ts');
  assert.ok(/VAULT_SOURCE_ID = 'vault'/.test(sources) && /version: 4/.test(sources), 'vault is a built-in source, with a migration');
  assert.ok(/kind === 'vault'/.test(read('src/storage/registry.ts')));
  assert.ok(/kind === 'vault'/.test(read('src/library/indexer.ts')), 'everything in the vault is indexed as hidden (out of Explore, search, tags)');
  assert.ok(/isRemoteKind/.test(read('src/media/free-up.ts')) && /isRemoteKind/.test(read('src/backup/run-backup.ts')), 'free-up and backup never treat the vault as a remote copy');
  const provider = read('src/storage/vault-provider.ts');
  assert.ok(/throw new Error\('Vault files are deleted through the vault trash'\)/.test(provider), 'the provider cannot delete; deletion goes through the trash');
  assert.ok(/startsWith\('\.'\)/.test(provider), 'the trash folder is not listed in the Archive');
  const lib = read('app/library.tsx');
  assert.ok(/source === 'vault'/.test(lib) && /trashProviderIds/.test(lib) && /vault-add/.test(lib));
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

console.log('vault (stage 5): ok');
