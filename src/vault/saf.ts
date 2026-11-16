/**
 * File-manager access (Android Storage Access Framework). The person chooses a folder (or files); the app reads it through the
 * grant Android gives for that choice. Nothing outside what was chosen is visible to the app.
 */
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File } from 'expo-file-system';
import { cleanSegment, displayName } from './logic';
import { statOf } from './files';

export type SourceFile = { uri: string; rel: string; size: number };
export type PickedFolder = { kind: 'folder'; uri: string; name: string; files: SourceFile[]; skipped: number };
export type PickedFiles = { kind: 'files'; uris: string[]; files: { uri: string; name: string; size: number }[] };
export type Picked = PickedFolder | PickedFiles;

/** Opens the system folder chooser. Null when the person backs out (or the picker is not available). */
export async function pickFolder(): Promise<PickedFolder | null> {
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    return null;
  }
  return describeFolder(dir);
}

/** Lists a folder the app can already read (the person chose it before, or a vault export) as something that can be added to the vault. */
export function describeFolder(dir: Directory): PickedFolder {
  const name = cleanSegment(displayName(dir.name || dir.uri));
  const files: SourceFile[] = [];
  const state = { skipped: 0 };
  scan(dir, '', files, state);
  return { kind: 'folder', uri: dir.uri, name, files, skipped: state.skipped };
}

/** A direct child (folder or file) by display name, or null. */
export function findChild(dir: Directory, name: string): Directory | File | null {
  try {
    return dir.list().find((entry) => displayName(entry.name || entry.uri) === name) ?? null;
  } catch {
    return null;
  }
}

/** Several files at once (no copy into the cache: the app reads them where they are). */
export async function pickFiles(): Promise<PickedFiles | null> {
  try {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: false, type: '*/*' });
    if (res.canceled || res.assets.length === 0) return null;
    const files = res.assets.map((a) => ({ uri: a.uri, name: cleanSegment(displayName(a.name)), size: a.size ?? statOf(new File(a.uri)).size ?? 0 }));
    return { kind: 'files', uris: files.map((f) => f.uri), files };
  } catch {
    return null;
  }
}

function scan(dir: Directory, prefix: string, out: SourceFile[], state: { skipped: number }): void {
  let entries: (Directory | File)[] = [];
  try {
    entries = dir.list();
  } catch {
    state.skipped += 1;
    return;
  }
  for (const entry of entries) {
    const name = displayName(entry.name || entry.uri);
    // `.`-names (thumbnail caches, .nomedia, ...) are not copied; they stay where they are
    if (name.startsWith('.')) {
      state.skipped += 1;
      continue;
    }
    const rel = prefix === '' ? cleanSegment(name) : `${prefix}/${cleanSegment(name)}`;
    if (entry instanceof Directory) scan(entry, rel, out, state);
    else out.push({ uri: entry.uri, rel, size: statOf(entry).size ?? 0 });
  }
}

/** Deletes folders that are completely empty (never one that still holds anything), deepest first. True when `dir` itself is gone. */
export function pruneEmptyFolders(dir: Directory): boolean {
  try {
    for (const entry of dir.list()) if (entry instanceof Directory) pruneEmptyFolders(entry);
    if (dir.list().length > 0) return false;
    dir.delete();
    return true;
  } catch {
    return false;
  }
}
