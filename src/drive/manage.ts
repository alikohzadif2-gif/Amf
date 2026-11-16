import { useLibraryIndex } from '@/src/library/index-store';
import { DRIVE_SOURCE_ID, useSourcesStore } from '@/src/state/sources-store';
import { useDriveStore, type DriveRootFolder } from '@/src/state/drive-store';
import { getProvider } from '@/src/storage/registry';
import { isDriveError, type DriveErrorKind } from './errors';
import { DriveProvider } from './provider';
import { signInToDrive, signOutOfDrive } from './runtime';

/** The built-in Google Drive provider (null only if the source was removed from the store). */
export function driveProvider(): DriveProvider | null {
  const source = useSourcesStore.getState().sources.find((s) => s.id === DRIVE_SOURCE_ID);
  if (!source) return null;
  const provider = getProvider(source);
  return provider instanceof DriveProvider ? provider : null;
}

export type ConnectResult = { ok: true } | { ok: false; error: DriveErrorKind };

function rebuildArchive() {
  void useLibraryIndex.getState().build(true).catch(() => undefined);
}

/** Sign in with Google, find or make the `meYou` folder, and index the Drive files. */
export async function connectDrive(): Promise<ConnectResult> {
  try {
    await signInToDrive();
  } catch (error) {
    return { ok: false, error: isDriveError(error) ? error.kind : 'http' };
  }
  driveProvider()?.resetRoot();
  const result = await driveProvider()?.test();
  if (result && !result.ok && result.code !== 'ok') {
    // signed in but the first listing failed (offline, quota ...): keep the account, report the reason
    rebuildArchive();
    return { ok: false, error: result.code === 'unavailable' ? 'network' : result.code === 'unauthorized' ? 'unauthorized' : result.busy ? 'quota' : 'http' };
  }
  rebuildArchive();
  return { ok: true };
}

export async function disconnectDrive(): Promise<void> {
  try {
    await signOutOfDrive();
  } finally {
    driveProvider()?.resetRoot();
    rebuildArchive();
  }
}

/** Use another Drive folder as the Archive's top level. */
export function chooseDriveRoot(folder: DriveRootFolder): void {
  useDriveStore.getState().setRootFolder(folder);
  useDriveStore.getState().setDiaryFolder(null); // it lived inside the old Archive folder
  driveProvider()?.resetRoot();
  rebuildArchive();
}
