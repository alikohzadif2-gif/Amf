import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as logicModule from '../src/media/pick-logic.ts';

const m = logicModule.snapFileName ? logicModule : logicModule.default;
const { SNAPS_FOLDER, snapFileName, uniqueName, assetExtension, toPickedFiles, selectionLimitFor, pickErrorCode, pickErrorKey } = m;

assert.equal(SNAPS_FOLDER, 'Snaps');
// camera names: UTC, zero padded, lower-case extension
assert.equal(snapFileName(new Date('2026-10-16T09:05:07Z')), 'snap-20261016-090507.jpg');
assert.equal(snapFileName(new Date('2026-01-02T00:00:00Z'), '.PNG'), 'snap-20260102-000000.png');
assert.equal(snapFileName(new Date('2026-01-02T00:00:00Z'), ''), 'snap-20260102-000000.jpg');
// unique names keep the extension and differ per index
assert.equal(uniqueName('a.jpg', 0, 36), 'a-100.jpg');
assert.notEqual(uniqueName('a.jpg', 0, 36), uniqueName('a.jpg', 1, 36));
assert.equal(uniqueName('noext', 2, 36), 'noext-102');
// extension: name, then uri, then mime, then fallback
assert.equal(assetExtension({ uri: 'file:///x/1.HEIC', fileName: null }), 'heic');
assert.equal(assetExtension({ uri: 'file:///x/abc', fileName: 'p.jpeg' }), 'jpeg');
assert.equal(assetExtension({ uri: 'content://media/9', mimeType: 'image/jpeg' }), 'jpg');
assert.equal(assetExtension({ uri: 'content://media/9', mimeType: 'video/mp4' }), 'mp4');
assert.equal(assetExtension({ uri: 'content://media/9' }), 'jpg');
// picked files: names/sizes, max cap
const assets = [1, 2, 3, 4, 5].map((n) => ({ uri: `file:///c/${n}.jpg`, fileName: n === 2 ? null : `p${n}.jpg`, fileSize: n === 3 ? null : n * 10 }));
assert.equal(toPickedFiles(assets).length, 5);
assert.equal(toPickedFiles(assets, 4).length, 4);
assert.deepEqual(toPickedFiles(assets, 1)[0], { uri: 'file:///c/1.jpg', name: 'p1.jpg', size: 10 });
assert.equal(toPickedFiles(assets)[1].name, '2.jpg');
assert.equal(toPickedFiles(assets)[2].size, 0);
assert.equal(toPickedFiles([{ uri: 'content://media/42', fileName: null, mimeType: 'video/mp4' }])[0].name, '42.mp4', 'Missing video extensions are inferred from the MIME type');
// selection limit: single = 1, multiple = max or unlimited (0)
assert.equal(selectionLimitFor(false, 4), 1);
assert.equal(selectionLimitFor(true, 4), 4);
assert.equal(selectionLimitFor(true), 0);
assert.equal(selectionLimitFor(true, 0), 0);
// errors → codes → i18n keys
assert.equal(pickErrorCode(new Error('Cannot find module expo-image-picker')), 'unavailable');
assert.equal(pickErrorCode(new Error('boom')), 'failed');
assert.equal(pickErrorKey('permission-camera'), 'mediaCameraDenied');
assert.equal(pickErrorKey('unavailable'), 'mediaUnavailable');
assert.equal(pickErrorKey('failed'), 'mediaPickFailed');

// wiring checked as text (these files import React Native)
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const appJson = JSON.parse(read('../app.json'));
const plugin = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-image-picker');
assert.ok(plugin, 'expo-image-picker plugin is in app.json');
assert.ok(plugin[1].cameraPermission && plugin[1].photosPermission, 'camera + photos permission texts');
assert.equal(plugin[1].microphonePermission, false);
const cam = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-camera');
assert.doesNotMatch(cam[1].cameraPermission, /only to scan/i, 'camera text no longer says QR only');
const local = read('../src/storage/local-provider.ts');
assert.match(local, /async createFolder\(/);
const pick = read('../src/media/pick.ts');
assert.match(pick, /SNAPS_FOLDER/);
assert.match(pick, /launchCameraAsync/);
assert.match(pick, /requestCameraPermissionsAsync/);
assert.match(pick, /imagesOnly\?: boolean/, 'The shared gallery picker supports image-only screens');
const phoneImport = read('../src/library/import-from-phone.ts');
assert.match(phoneImport, /mediaTypes: imagesOnly \? \['images'\] : \['images', 'videos'\]/);
assert.match(phoneImport, /allowsEditing: false/);
assert.match(phoneImport, /quality: 1/);
assert.match(phoneImport, /videoExportPreset: picker\.VideoExportPreset\.Passthrough/);
const localProvider = read('../src/storage/local-provider.ts');
assert.match(localProvider, /new File\(input\.sourceUri\)\.copySync\(target\)/, 'Picked media is copied without app-side re-encoding');
for (const lang of ['fa', 'en']) {
  const j = JSON.parse(read(`../src/i18n/locales/${lang}.json`));
  for (const k of ['mediaSourceTitle', 'mediaSourceCamera', 'mediaSourceGallery', 'mediaSourceFiles', 'mediaCameraDenied', 'mediaUnavailable', 'mediaPickFailed']) {
    assert.ok(j[k] && j[k].length > 0, `${lang}.${k}`);
  }
}
console.log('media tests ok');
