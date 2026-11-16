import { File } from 'expo-file-system';
import { providerFor, sourceKinds } from '@/src/library/providers';
import type { LibraryEntry } from '@/src/library/merge';
import { useUserData } from '@/src/library/user-data';
import { removeOffline } from './originals';
import { isRemoteKind } from '@/src/storage/types';

export type FreeUpPlan = {
  localFiles: { entry: LibraryEntry; sourceId: string; itemId: string; size: number }[];
  offlineCopies: { key: string; size: number }[];
  bytes: number;
};

/** A local copy may be removed only when a remote source holds the same checksum. */
export function isVerifiedBackup(localMd5: string | undefined, remoteMd5: ReadonlySet<string>) {
  return !!localMd5 && remoteMd5.has(localMd5);
}

/**
 * Finds local copies that are safe to delete: files in the app's own library
 * folder whose md5 also exists on a server source, and offline copies of
 * remote items. Both only if the item is dated on or before the cutoff.
 * Gallery photos (ml:asset) are never touched: they cannot be verified here.
 */
export async function scanFreeUp(entries: LibraryEntry[], cutoffIso: string): Promise<FreeUpPlan> {
  const kinds = sourceKinds();
  const remoteMd5 = new Set<string>();
  for (const entry of entries) {
    // only Drive/server copies count as a backup; the vault is on this phone and is never touched here
    const remote = entry.refs.some((r) => isRemoteKind(kinds[r.sourceId]));
    if (remote && entry.item.md5) remoteMd5.add(entry.item.md5);
  }
  const plan: FreeUpPlan = { localFiles: [], offlineCopies: [], bytes: 0 };
  const offline = useUserData.getState().offline;

  for (const entry of entries) {
    if (entry.item.mtime > cutoffIso) continue;
    if (offline[entry.key]) {
      const size = offline[entry.key].size;
      plan.offlineCopies.push({ key: entry.key, size });
      plan.bytes += size;
    }
    const localRef = entry.refs.find(
      (r) => kinds[r.sourceId] === 'local' && r.itemId.startsWith('fs:'),
    );
    if (!localRef) continue;
    try {
      const provider = providerFor(localRef.sourceId);
      const uri = provider ? await provider.getOriginalUrl(localRef.itemId) : null;
      if (!uri) continue;
      const info = new File(uri).info({ md5: true });
      if (isVerifiedBackup(info.md5, remoteMd5)) {
        const size = info.size ?? entry.item.size;
        plan.localFiles.push({ entry, sourceId: localRef.sourceId, itemId: localRef.itemId, size });
        plan.bytes += size;
      }
    } catch {
      // unreadable file: leave it alone
    }
  }
  return plan;
}

export async function runFreeUp(plan: FreeUpPlan): Promise<number> {
  let freed = 0;
  for (const copy of plan.offlineCopies) {
    await removeOffline(copy.key);
    freed += copy.size;
  }
  for (const file of plan.localFiles) {
    try {
      await providerFor(file.sourceId)?.delete(file.itemId);
      freed += file.size;
    } catch {
      // keep going; the file stays
    }
  }
  return freed;
}
