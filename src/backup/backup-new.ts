import { ensureDrivePath } from '@/src/drive/folders';
import { dirId, parseDirId } from '@/src/server/ids';
import { indexProviders } from '@/src/library/indexer';
import type { LibraryEntry } from '@/src/library/merge';
import type { StorageItem, StorageProvider } from '@/src/storage/types';
import type { EnqueueInput } from './queue';

/** Files above this size are uploaded without an md5 (hashing would block the app). */
export const MD5_MAX_BYTES = 50 * 1024 * 1024;

export type LocalInfo = { size: number; md5?: string };

export type BackupScope = 'camera' | 'all' | 'selected';

export type BackupChoice = {
  photos: boolean;
  videos: boolean;
  scope: BackupScope;
  /** Album ids for scope 'selected'. */
  albums: string[];
};

export const defaultChoice: BackupChoice = { photos: true, videos: true, scope: 'camera', albums: [] };

export type BackupDeps = {
  phone: StorageProvider;
  target: StorageProvider;
  /** Already uploaded phone items (queue.backedUp). */
  backedUp: Record<string, string>;
  /** Reads size (and md5 for small files) of a phone file; null if unreadable. */
  localInfo: (uri: string) => LocalInfo | null;
  onProgress?: (count: number) => void;
  /** What to back up; defaults to photos + videos from the camera folder. */
  choice?: BackupChoice;
  /** Test hook. */
  now?: () => Date;
};

export type BackupScan = {
  jobs: EnqueueInput[];
  /** Photos/videos that matched the choice. */
  scanned: number;
  /** Already on the server (same name and size, or same md5) or uploaded before. */
  alreadyThere: number;
  /** Files the phone could not read (not queued). */
  unreadable: number;
  /** Phone albums that were looked at (0 = nothing matched the choice). */
  albums: number;
};

/** Albums whose name means "the camera" (English, Persian, and the Android folder names). */
const CAMERA_NAMES = new Set(['camera', 'dcim', '100andro', 'دوربین']);

/** The phone's app-private library (`fs:` ids) is never backed up: only gallery albums are. */
export function isGalleryAlbum(item: StorageItem): boolean {
  return item.type === 'dir' && item.id.startsWith('ml:album:');
}

export function isCameraAlbum(name: string): boolean {
  return CAMERA_NAMES.has(name.trim().toLowerCase());
}

/** Which of the phone's roots are backed up for this choice. */
export function pickAlbums(roots: StorageItem[], choice: BackupChoice): StorageItem[] {
  const albums = roots.filter(isGalleryAlbum);
  if (choice.scope === 'all') return albums;
  if (choice.scope === 'selected') return albums.filter((a) => choice.albums.includes(a.id));
  return albums.filter((a) => isCameraAlbum(a.name));
}

/** The phone provider showing only the chosen albums as its roots (nothing else changes). */
export function restrictRoots(phone: StorageProvider, roots: StorageItem[]): StorageProvider {
  const view = Object.create(phone) as StorageProvider;
  view.list = (parentId, options) => (parentId === null ? Promise.resolve({ items: roots }) : phone.list(parentId, options));
  return view;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `year/month` folder of a date in the phone's time zone; `undated` when the date is unknown. */
export function dateFolder(isoUtc: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return 'undated';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}`;
}

/** The server (and Google Drive) accept a modification time only up to a day ahead; epoch 0 means unknown. */
export function uploadMtime(isoUtc: string, now: Date): string | undefined {
  const t = new Date(isoUtc).getTime();
  if (Number.isNaN(t) || t <= 0) return undefined;
  return new Date(Math.min(t, now.getTime())).toISOString();
}

/** Server root for a media type: `Photos` for images, `Videos` for videos (created by `init`), else the first root. */
function pickRoot(roots: StorageItem[], type: 'image' | 'video'): StorageItem | null {
  const dirs = roots.filter((r) => r.type === 'dir');
  const wanted = type === 'image' ? 'photos' : 'videos';
  return dirs.find((r) => r.name.toLowerCase() === wanted) ?? dirs[0] ?? null;
}

/** Where a phone item goes on the target: `Photos/<year>/<month>` (`Videos/...`) on the real server and on Google Drive, the first root on mocks. */
async function targetParent(
  target: StorageProvider,
  root: StorageItem | null,
  type: 'image' | 'video',
  isoUtc: string,
  driveCache: Map<string, string | null>,
): Promise<string | null> {
  if (target.kind === 'drive') return ensureDrivePath(target, [type === 'image' ? 'Photos' : 'Videos', ...dateFolder(isoUtc).split('/')], driveCache);
  if (!root) return null;
  if (target.kind === 'server' && !target.isMock) {
    const ref = parseDirId(root.id);
    if (ref) return dirId(ref.rootId, `${ref.path ? `${ref.path}/` : ''}${dateFolder(isoUtc)}`);
  }
  return root.id;
}

/**
 * Finds phone photos/videos the target does not have yet (same md5, or same
 * name and size) and returns upload jobs for them. Nothing is uploaded here and
 * nothing is deleted anywhere.
 */
export async function scanNewMedia(deps: BackupDeps): Promise<BackupScan> {
  const choice = deps.choice ?? defaultChoice;
  const now = (deps.now ?? (() => new Date()))();
  const empty: BackupScan = { jobs: [], scanned: 0, alreadyThere: 0, unreadable: 0, albums: 0 };
  if (!choice.photos && !choice.videos) return empty;

  const phoneRoots = (await deps.phone.list(null)).items;
  const albums = pickAlbums(phoneRoots, choice);
  // A phone that is not the real gallery (tests, mocks) has no `ml:album:` roots: use its roots as they are.
  const scanRoots = albums.length > 0 || phoneRoots.some(isGalleryAlbum) ? albums : phoneRoots.filter((r) => r.type === 'dir');
  if (scanRoots.length === 0) return empty;

  const phoneEntries: LibraryEntry[] = await indexProviders([restrictRoots(deps.phone, scanRoots)], deps.onProgress ?? (() => {}));
  const media = phoneEntries.filter(
    (e) => (e.item.type === 'image' && choice.photos) || (e.item.type === 'video' && choice.videos),
  );
  const remote = await indexProviders([deps.target], () => {});

  const names = new Map<string, Set<number>>();
  const md5s = new Set<string>();
  for (const entry of remote) {
    const key = entry.item.name.toLowerCase();
    const sizes = names.get(key) ?? new Set<number>();
    sizes.add(entry.item.size);
    names.set(key, sizes);
    if (entry.item.md5) md5s.add(entry.item.md5);
  }

  // Google Drive has no fixed `Photos`/`Videos` roots: its date folders are made when a file needs them.
  const targetRoots = deps.target.kind === 'drive' ? [] : (await deps.target.list(null)).items;
  const driveCache = new Map<string, string | null>();

  const jobs: EnqueueInput[] = [];
  let alreadyThere = 0;
  let unreadable = 0;
  for (const entry of media) {
    if (deps.backedUp[entry.key]) {
      alreadyThere += 1;
      continue;
    }
    const ref = entry.refs[0];
    const uri = await deps.phone.getOriginalUrl(ref.itemId);
    const info = uri ? deps.localInfo(uri) : null;
    if (!uri || !info) {
      unreadable += 1;
      continue;
    }
    const sameName = names.get(entry.item.name.toLowerCase());
    if (sameName && (info.size === 0 || sameName.has(info.size))) {
      alreadyThere += 1;
      continue;
    }
    if (info.md5 && md5s.has(info.md5)) {
      alreadyThere += 1;
      continue;
    }
    const type = entry.item.type === 'video' ? 'video' : 'image';
    jobs.push({
      sourceId: deps.target.id,
      parentId: await targetParent(deps.target, pickRoot(targetRoots, type), type, entry.item.mtime, driveCache),
      uri,
      name: entry.item.name,
      size: info.size,
      md5: info.md5,
      mtime: uploadMtime(entry.item.mtime, now),
      backupKey: entry.key,
    });
  }
  return { jobs, scanned: media.length, alreadyThere, unreadable, albums: scanRoots.length };
}
