import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { listDiaryEntries } from '@/src/diary/diary-db';
import { listEvents } from '@/src/events/events-db';
import { ensureDrivePath } from '@/src/drive/folders';
import { dirId, parseDirId } from '@/src/server/ids';
import { indexProviders } from '@/src/library/indexer';
import { useLibraryIndex } from '@/src/library/index-store';
import type { LibraryEntry } from '@/src/library/merge';
import { entriesFromSnapshots, loadUserData, useUserData } from '@/src/library/user-data';
import { isLocalUri } from '@/src/media/originals';
import { runFreeUp, scanFreeUp } from '@/src/media/free-up';
import { isRemoteKind, type StorageProvider } from '@/src/storage/types';
import { useDataBackupStore } from '@/src/state/data-backup-store';
import { providerFor, sourceKinds } from '@/src/library/providers';
import { fileMd5 } from '@/src/server/file-reader';
import { useSettingsStore } from '@/src/state/settings-store';
import { useSourcesStore } from '@/src/state/sources-store';
import { isSourceActive } from '@/src/storage/active';
import { uploadQueue } from '@/src/state/upload-queue-store';
import { MD5_MAX_BYTES, restrictRoots, scanNewMedia, type BackupChoice, type LocalInfo } from './backup-new';
import { DATA_FOLDER, memoryKey, mergePlans, planArchiveBackup, planDataBackup, type ArchiveFile, type MediaInfo } from './data-backup';

export type BackupOutcome =
  | { code: 'no-server' }
  | { code: 'no-access' }
  | { code: 'unreachable' }
  /** The server does not announce `upload` (older server: update it). */
  | { code: 'no-upload' }
  /** Photos and videos are both switched off. */
  | { code: 'nothing-selected' }
  /** No album matched the choice (for example no "Camera" folder). */
  | { code: 'no-albums' }
  | { code: 'done'; queued: number; alreadyThere: number; scanned: number; unreadable: number };

function localInfo(uri: string): LocalInfo | null {
  try {
    const info = new File(uri).info();
    if (!info.exists) return null;
    const size = info.size ?? 0;
    return { size, md5: size > 0 && size <= MD5_MAX_BYTES ? fileMd5(uri) : undefined };
  } catch {
    return null;
  }
}

/**
 * Receives backups: Google Drive while somebody is signed in to it, otherwise the first enabled server source (real or demo).
 * So with Drive connected nothing is stored on the personal server any more.
 */
export function backupTargetSourceId(): string | null {
  const sources = useSourcesStore.getState().sources;
  const source =
    sources.find((s) => s.kind === 'drive' && isSourceActive(s)) ?? sources.find((s) => s.kind === 'server' && isSourceActive(s));
  return source ? source.id : null;
}

/** The person's choice from Settings > Backup. */
export function currentChoice(): BackupChoice {
  const s = useSettingsStore.getState();
  return { photos: s.backupPhotos, videos: s.backupVideos, scope: s.backupScope, albums: s.backupAlbums };
}

/**
 * "Back up new media": scan the phone, queue what the server lacks, start uploading.
 * Uploading itself waits for the Wi-Fi / battery rules (queue `canRun`).
 */
export async function backupNewMedia(onProgress?: (count: number) => void): Promise<BackupOutcome> {
  const choice = currentChoice();
  if (!choice.photos && !choice.videos) return { code: 'nothing-selected' };
  const targetId = backupTargetSourceId();
  const target = targetId ? providerFor(targetId) : null;
  const phone = providerFor('local');
  if (!target) return { code: 'no-server' };
  if (!phone) return { code: 'no-access' };
  let access = await phone.test();
  if (!access.ok && phone.requestAccess) access = await phone.requestAccess();
  if (!access.ok) return { code: 'no-access' };
  const reachable = await target.test();
  if (!reachable.ok) return { code: 'unreachable' };
  if (target.features && !target.isMock) {
    try {
      if (!(await target.features()).includes('upload')) return { code: 'no-upload' };
    } catch {
      return { code: 'unreachable' };
    }
  }
  const scan = await scanNewMedia({
    phone,
    target,
    backedUp: uploadQueue.getState().backedUp,
    localInfo,
    onProgress,
    choice,
  });
  if (scan.albums === 0) return { code: 'no-albums' };
  const queued = uploadQueue.getState().enqueue(scan.jobs);
  uploadQueue.getState().beginRun({ scanned: scan.scanned, skipped: scan.alreadyThere, unreadable: scan.unreadable, queued });
  // Jobs that failed only because the network was down earlier get another go.
  void uploadQueue.getState().retryTransient();
  if (queued > 0) void uploadQueue.getState().start();
  return { code: 'done', queued, alreadyThere: scan.alreadyThere, scanned: scan.scanned, unreadable: scan.unreadable };
}

export type DataDb = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

export type DataBackupOutcome =
  | { code: 'off' | 'no-server' | 'unreachable' | 'no-upload' | 'nothing-new' }
  | { code: 'queued'; events: number; memories: number; photos: number };

/** Folder `<first root>/<path>` for the backup files (the server creates missing folders; on Google Drive the folders are made here); mocks use their first root. */
async function dataParent(target: StorageProvider, path: string, driveCache: Map<string, string | null>): Promise<string | null> {
  if (target.kind === 'drive') return ensureDrivePath(target, path.split('/'), driveCache);
  const root = (await target.list(null)).items.find((r) => r.type === 'dir');
  if (!root) return null;
  if (target.kind === 'server' && !target.isMock) {
    const ref = parseDirId(root.id);
    if (ref) return dirId(ref.rootId, `${ref.path ? `${ref.path}/` : ''}${path}`);
  }
  return root.id;
}

const SNAPSHOT_FOLDER = 'data-backup';
const OWN_LIBRARY_ID = 'fs:library';

/** Deletes finished snapshot files from the phone (only the app's own temporary copies, never anything on the server). */
function cleanSnapshots(keepUris: Set<string>) {
  try {
    const dir = new Directory(Paths.document, SNAPSHOT_FOLDER);
    if (!dir.exists) return;
    for (const entry of dir.list()) if (entry instanceof File && !keepUris.has(entry.uri)) entry.delete();
  } catch {
    // a leftover file is harmless
  }
}

/** Finds the phone files behind Library keys, and the files the person added straight to the app's own library. */
async function makeFinder(db: DataDb) {
  if (!useUserData.getState().loaded) await loadUserData(db as SQLiteDatabase);
  const kinds = sourceKinds();
  const phone = providerFor('local');
  const ownEntries: LibraryEntry[] = [];
  if (phone) {
    try {
      const root = (await phone.list(null)).items.find((r) => r.id === OWN_LIBRARY_ID);
      if (root) ownEntries.push(...(await indexProviders([restrictRoots(phone, [root])], () => {})));
    } catch {
      // the own library could not be listed: only memories whose entries are in the Library index are found
    }
  }
  const own = new Map(ownEntries.map((e) => [e.key, e]));
  const localUri = async (entry: LibraryEntry): Promise<string | null> => {
    for (const ref of entry.refs) {
      if (kinds[ref.sourceId] !== 'local') continue;
      try {
        const uri = await providerFor(ref.sourceId)?.getOriginalUrl(ref.itemId);
        if (uri && isLocalUri(uri)) return uri;
      } catch {
        // try the next reference
      }
    }
    return null;
  };
  const onServer = (entry: LibraryEntry) => entry.refs.some((r) => isRemoteKind(kinds[r.sourceId]));
  const data = useUserData.getState();

  return {
    async mediaInfo(key: string): Promise<MediaInfo | undefined> {
      const entry = useLibraryIndex.getState().byKey.get(key) ?? own.get(key) ?? (await entriesFromSnapshots([key]).catch(() => []))[0];
      if (!entry) return undefined;
      const uri = onServer(entry) ? null : await localUri(entry);
      return { key, name: entry.item.name, tags: data.tagsByKey[key] ?? [], uri, mtime: entry.item.mtime };
    },
    async archiveFiles(): Promise<ArchiveFile[]> {
      const out: ArchiveFile[] = [];
      for (const entry of ownEntries) {
        if (entry.item.type !== 'image' && entry.item.type !== 'video') continue;
        const indexed = useLibraryIndex.getState().byKey.get(entry.key);
        if (indexed && onServer(indexed)) continue;
        const uri = await localUri(entry);
        if (!uri) continue;
        const meta = data.archiveMeta[entry.key];
        out.push({
          key: entry.key,
          name: entry.item.name,
          uri,
          mtime: entry.item.mtime,
          date: meta?.date ?? null,
          category: meta?.category ?? 'none',
          favorite: data.favorites.has(entry.key),
          tags: data.tagsByKey[entry.key] ?? [],
          albums: data.albums.filter((a) => (data.albumKeys[a.id] ?? []).includes(entry.key)).map((a) => a.name),
        });
      }
      return out;
    },
  };
}

/**
 * Queues NEW entries for the server, filed by date (`Backup/<Jalali year>/<MM>/<DD>/`, see data-backup.ts): memories (+ their photos/videos),
 * events (+ photo) and files added straight to the Archive. Same upload queue, Wi-Fi/charging rules and "nothing is deleted on the
 * server" as the media backup. Never throws.
 */
export async function backupNewData(db: DataDb, now: Date = new Date()): Promise<DataBackupOutcome> {
  try {
    const settings = useSettingsStore.getState();
    if (!settings.backupMemories && !settings.backupEvents && !settings.backupArchive) return { code: 'off' };
    const targetId = backupTargetSourceId();
    const target = targetId ? providerFor(targetId) : null;
    if (!target) return { code: 'no-server' };
    if (!(await target.test()).ok) return { code: 'unreachable' };
    if (target.features && !target.isMock && !(await target.features()).includes('upload')) return { code: 'no-upload' };
    const store = useDataBackupStore.getState();
    const queue = uploadQueue.getState();
    cleanSnapshots(new Set(queue.jobs.filter((j) => j.state !== 'done').map((j) => j.uri)));

    const events = settings.backupEvents ? await listEvents(db) : [];
    const diary = settings.backupMemories ? await listDiaryEntries(db) : [];
    const finder = await makeFinder(db);
    const media: Record<string, MediaInfo | undefined> = {};
    for (const memory of diary) {
      if (store.marks[memoryKey(memory.id)] === memory.updatedAt) continue;
      for (const key of memory.mediaKeys) if (!(key in media)) media[key] = await finder.mediaInfo(key);
    }
    const dataPlan = planDataBackup({ events, diary, marks: store.marks, media, switches: { memories: settings.backupMemories, events: settings.backupEvents } });
    const archivePlan = settings.backupArchive ? planArchiveBackup({ files: await finder.archiveFiles(), marks: { ...store.marks, ...(dataPlan?.marks ?? {}) } }) : null;
    const plan = mergePlans(dataPlan, archivePlan);
    if (!plan) return { code: 'nothing-new' };

    // What the server already has (same md5, or same name and size) is not sent again.
    const remote = await indexProviders([target], () => {}).catch(() => [] as LibraryEntry[]);
    const sizesByName = new Map<string, Set<number>>();
    const remoteMd5 = new Set<string>();
    for (const entry of remote) {
      const name = entry.item.name.toLowerCase();
      sizesByName.set(name, (sizesByName.get(name) ?? new Set<number>()).add(entry.item.size));
      if (entry.item.md5) remoteMd5.add(entry.item.md5);
    }

    const parents = new Map<string, string | null>();
    const driveCache = new Map<string, string | null>();
    const parentFor = async (day: string) => {
      if (!parents.has(day)) parents.set(day, await dataParent(target, `${DATA_FOLDER}/${day}`, driveCache));
      return parents.get(day) ?? null;
    };
    const jobs: Parameters<typeof queue.enqueue>[0] = [];
    let photos = 0;
    const dir = new Directory(Paths.document, SNAPSHOT_FOLDER);
    if (plan.files.length > 0 && !dir.exists) dir.create({ intermediates: true, idempotent: true });
    let counter = 0;
    for (const f of plan.files) {
      const file = new File(dir, `${now.getTime().toString(36)}-${(counter += 1)}.json`);
      file.create({ overwrite: true });
      file.write(f.json);
      jobs.push({ sourceId: target.id, parentId: await parentFor(f.day), uri: file.uri, name: f.name, size: file.info().size ?? new TextEncoder().encode(f.json).length, mtime: now.toISOString() });
    }
    for (const up of plan.uploads) {
      const info = localInfo(up.uri);
      if (!info) {
        delete plan.marks[up.key]; // file gone: nothing to back up, and no mark so a restored file is tried again
        continue;
      }
      const there = (info.md5 && remoteMd5.has(info.md5)) || (info.size > 0 && sizesByName.get(up.name.toLowerCase())?.has(info.size));
      if (there) {
        plan.marks[up.key] = 'on-server';
        continue;
      }
      jobs.push({ sourceId: target.id, parentId: await parentFor(up.day), uri: up.uri, name: up.name, size: info.size, md5: info.md5, mtime: up.mtime ? uploadMtimeSafe(up.mtime, now) : undefined, backupKey: up.key });
      photos += 1;
    }
    const queued = queue.enqueue(jobs);
    // A failed job stays in the upload list with "retry" (Settings > Backup > Uploads), so the marks are kept.
    useDataBackupStore.getState().remember(plan.marks, now.toISOString());
    if (settings.backupMode === 'move') useDataBackupStore.getState().setMoveDue(true);
    void uploadQueue.getState().retryTransient();
    if (queued > 0) void uploadQueue.getState().start();
    return { code: 'queued', events: plan.events, memories: plan.memories, photos };
  } catch {
    return { code: 'unreachable' };
  }
}

/** The server takes a file date only up to a day ahead; 0 / invalid means unknown. */
function uploadMtimeSafe(isoUtc: string, now: Date): string | undefined {
  const t = new Date(isoUtc).getTime();
  if (Number.isNaN(t) || t <= 0) return undefined;
  return new Date(Math.min(t, now.getTime())).toISOString();
}

/**
 * "Move" mode: once everything queued has been uploaded, the app's own copies that the server holds with the SAME checksum are removed
 * from the phone (the same verified rule as Settings > Free up space). Gallery photos and offline copies are never touched.
 * Returns how many bytes were freed (0 = nothing to do yet).
 */
export async function moveVerifiedToServer(): Promise<number> {
  const store = useDataBackupStore.getState();
  if (useSettingsStore.getState().backupMode !== 'move' || !store.moveDue) return 0;
  const q = uploadQueue.getState();
  if (q.jobs.some((j) => j.state === 'queued' || j.state === 'uploading')) return 0; // wait until the uploads are done
  await useLibraryIndex.getState().build(true); // the server listing now includes what was just uploaded
  const plan = await scanFreeUp(useLibraryIndex.getState().entries, new Date().toISOString());
  plan.offlineCopies = []; // offline copies are kept on purpose by the person
  const freed = await runFreeUp(plan);
  if (q.jobs.every((j) => j.state !== 'failed')) store.setMoveDue(false);
  return freed;
}
