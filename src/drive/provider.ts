import type { ChunkReader, OpenReader } from '../server/types';
import { mimeFromName, typeFromName } from '../storage/item-type';
import type {
  ChangesResult,
  ImageRef,
  ItemType,
  ListOptions,
  ListResult,
  ProviderCapabilities,
  ProviderTestResult,
  StorageItem,
  StorageProvider,
  TestCode,
  UploadInput,
} from '../storage/types';
import { DriveClient } from './client';
import { DriveError, isDriveError } from './errors';
import { uploadToDrive } from './upload';
import { FOLDER_MIME, GOOGLE_APPS_PREFIX, type DriveAbout, type DriveAccount, type DriveAuth, type DriveFile, type FetchLike } from './types';

const EPOCH = new Date(0).toISOString();
const PAGE = 200;
const CACHE_MAX = 5000;
/** Drive's thumbnail links are short-lived; one older than this is asked for again. */
const THUMB_LINK_MS = 20 * 60_000;
/** Name of the folder made in My Drive the first time the person signs in. */
export const DEFAULT_ROOT_NAME = 'meYou';

export type DriveRoot = { id: string; name: string };

export type DriveProviderOptions = {
  auth: DriveAuth;
  /** Is somebody signed in? (the account is kept in the drive store; no network) */
  hasAccount: () => boolean;
  /** The chosen Archive folder, or null when none is chosen yet (then `meYou` is found or made in My Drive). */
  rootFolder: () => DriveRoot | null;
  onRootFolder?: (folder: DriveRoot) => void;
  /** Opens the Google sign-in screen and returns the account (wired to the sign-in module and the drive store). */
  signIn?: () => Promise<DriveAccount>;
  openReader?: OpenReader;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function testCodeFor(error: unknown): TestCode {
  if (isDriveError(error)) {
    if (error.kind === 'cancelled') return 'permission-needed';
    if (error.kind === 'unauthorized') return 'unauthorized';
    if (error.kind === 'network' || error.kind === 'unsupported') return 'unavailable';
  }
  return 'error';
}

/** Folder, image, video, text or other file; null for what has no bytes (Google Docs/Sheets, shortcuts). */
export function itemTypeOf(file: DriveFile): ItemType | null {
  if (file.mimeType === FOLDER_MIME) return 'dir';
  if (file.mimeType.startsWith(GOOGLE_APPS_PREFIX)) return null;
  if (file.mimeType.startsWith('image/')) return 'image';
  if (file.mimeType.startsWith('video/')) return 'video';
  if (file.mimeType.startsWith('text/')) return 'text';
  return typeFromName(file.name);
}

/**
 * StorageProvider for the person's own Google Drive. It talks to Google directly from the phone: the personal server
 * is not involved. The Archive's top level is one Drive folder (`rootFolder`), so the Archive index walks only that
 * folder and not the whole Drive. Deleting moves to the Drive bin.
 */
export class DriveProvider implements StorageProvider {
  readonly kind = 'drive' as const;
  readonly isMock = false;
  private readonly client: DriveClient;
  private readonly cache = new Map<string, { item: StorageItem; thumb?: string; thumbAt: number }>();
  private rootPromise: Promise<string> | null = null;

  constructor(
    readonly id: string,
    private readonly options: DriveProviderOptions,
  ) {
    this.client = new DriveClient(options.auth, options.fetch, options.timeoutMs);
  }

  capabilities(): ProviderCapabilities {
    return { canUpload: true, canDelete: true, supportsChanges: false, needsPermission: true };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private requireAccount() {
    if (!this.options.hasAccount()) throw new DriveError('unauthorized', 0, 'not signed in to Google');
  }

  /** The account's name, e-mail and storage use (for Settings). */
  async about(): Promise<DriveAbout> {
    this.requireAccount();
    return this.client.about();
  }

  /** Forget the remembered root so a changed folder choice (or a new account) is read again. */
  resetRoot(): void {
    this.rootPromise = null;
    this.cache.clear();
  }

  /** The Archive's top folder id: the chosen folder, else `meYou` in My Drive (found, or made on first use). */
  async ensureRoot(): Promise<string> {
    this.requireAccount();
    const chosen = this.options.rootFolder();
    if (chosen) return chosen.id;
    if (!this.rootPromise) {
      this.rootPromise = (async () => {
        const my = await this.client.rootId();
        const existing = await this.client.findFolder(DEFAULT_ROOT_NAME, my);
        const folder = existing ?? (await this.client.createFolder(DEFAULT_ROOT_NAME, my));
        this.options.onRootFolder?.({ id: folder.id, name: folder.name });
        return folder.id;
      })().catch((error) => {
        this.rootPromise = null;
        throw error;
      });
    }
    return this.rootPromise;
  }

  async test(): Promise<ProviderTestResult> {
    const started = this.now();
    if (!this.options.hasAccount()) return { ok: false, code: 'permission-needed', latencyMs: 0 };
    try {
      await this.client.about();
      const root = await this.ensureRoot();
      const page = await this.client.listChildren(root, undefined, 1, true);
      return { ok: true, code: 'ok', latencyMs: this.now() - started, rootCount: page.files.length };
    } catch (error) {
      const busy = isDriveError(error) && error.kind === 'quota';
      return { ok: false, code: testCodeFor(error), latencyMs: this.now() - started, ...(busy ? { busy: true } : {}) };
    }
  }

  /** Opens the Google sign-in screen (when this build has it) and tests the connection. */
  async requestAccess(): Promise<ProviderTestResult> {
    const started = this.now();
    if (!this.options.signIn) return { ok: false, code: 'unavailable', latencyMs: 0 };
    try {
      await this.options.signIn();
      this.resetRoot();
    } catch (error) {
      return { ok: false, code: testCodeFor(error), latencyMs: this.now() - started };
    }
    return this.test();
  }

  private remember(file: DriveFile, parentId: string | null, type: ItemType): StorageItem {
    const item: StorageItem = {
      id: file.id,
      parentId,
      name: file.name,
      type,
      size: type === 'dir' ? 0 : Number(file.size ?? 0) || 0,
      mtime: file.modifiedTime ?? file.createdTime ?? EPOCH,
      md5: file.md5Checksum,
      mime: type === 'dir' ? undefined : file.mimeType,
      width: file.imageMediaMetadata?.width ?? file.videoMediaMetadata?.width,
      height: file.imageMediaMetadata?.height ?? file.videoMediaMetadata?.height,
      duration: file.videoMediaMetadata?.durationMillis ? Number(file.videoMediaMetadata.durationMillis) / 1000 : undefined,
    };
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(file.id, { item, thumb: file.thumbnailLink, thumbAt: this.now() });
    return item;
  }

  async list(parentId: string | null, options: ListOptions = {}): Promise<ListResult> {
    this.requireAccount();
    const folder = parentId ?? (await this.ensureRoot());
    const page = await this.client.listChildren(folder, options.cursor, options.limit ?? PAGE);
    const items: StorageItem[] = [];
    for (const file of page.files) {
      const type = itemTypeOf(file);
      if (type) items.push(this.remember(file, parentId, type));
    }
    return { items, nextCursor: page.nextPageToken };
  }

  /** Sub-folders of a Drive folder (`'root'` = My Drive), for the folder picker. Up to `maxPages` pages. */
  async listFolders(parentId: string, maxPages = 5): Promise<{ id: string; name: string }[]> {
    this.requireAccount();
    const out: { id: string; name: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.client.listChildren(parentId, cursor, 200, true);
      for (const file of result.files) out.push({ id: file.id, name: file.name });
      cursor = result.nextPageToken;
      if (!cursor) break;
    }
    return out;
  }

  /** Makes a folder under any Drive folder (`'root'` = My Drive) and returns it. */
  async makeFolder(name: string, parentId: string): Promise<{ id: string; name: string }> {
    this.requireAccount();
    const clean = name.trim();
    if (!clean) throw new Error('Folder name is empty');
    const existing = await this.client.findFolder(clean, parentId);
    const folder = existing ?? (await this.client.createFolder(clean, parentId));
    return { id: folder.id, name: folder.name };
  }

  async stat(id: string): Promise<StorageItem | null> {
    const hit = this.cache.get(id);
    if (hit) return hit.item;
    try {
      const file = await this.client.getFile(id);
      if (file.trashed) return null;
      const type = itemTypeOf(file);
      return type ? this.remember(file, file.parents?.[0] ?? null, type) : null;
    } catch (error) {
      if (isDriveError(error) && error.kind === 'not-found') return null;
      throw error;
    }
  }

  /** A fresh thumbnail link for a file (Drive's links expire), or null when Drive has none. */
  private async thumbLink(id: string): Promise<string | null> {
    const hit = this.cache.get(id);
    if (hit?.thumb && this.now() - hit.thumbAt < THUMB_LINK_MS) return hit.thumb;
    const file = await this.client.getFile(id);
    const type = itemTypeOf(file);
    if (type) this.remember(file, file.parents?.[0] ?? null, type);
    return file.thumbnailLink ?? null;
  }

  private async thumbRef(id: string, size: number): Promise<ImageRef | null> {
    const link = await this.thumbLink(id);
    if (!link) return null;
    const sized = /=s\d+(-[a-z0-9-]+)?$/i.test(link) ? link.replace(/=s\d+/i, `=s${size}`) : `${link}=s${size}`;
    return { uri: sized, headers: await this.client.authHeaders() };
  }

  async getThumb(id: string, size = 256): Promise<ImageRef | null> {
    this.requireAccount();
    return this.thumbRef(id, size);
  }

  async getPreview(id: string): Promise<ImageRef | null> {
    this.requireAccount();
    const poster = await this.thumbRef(id, 1600);
    if (poster) return poster;
    return this.getOriginalSource(id);
  }

  async getOriginalUrl(id: string): Promise<string | null> {
    return this.client.mediaUrl(id);
  }

  /** The file's bytes with the Authorization header (video streaming with Range, downloads). */
  async getOriginalSource(id: string): Promise<ImageRef | null> {
    this.requireAccount();
    return { uri: this.client.mediaUrl(id), headers: await this.client.authHeaders() };
  }

  async upload(input: UploadInput): Promise<StorageItem> {
    this.requireAccount();
    const open = this.options.openReader;
    if (!open) throw new Error('Uploads are not available in this environment');
    const parentId = input.parentId ?? (await this.ensureRoot());
    const reader: ChunkReader = await open(input.sourceUri);
    try {
      const file = await uploadToDrive(
        this.client,
        reader,
        { name: input.name, parentId, mimeType: mimeFromName(input.name) ?? 'application/octet-stream', modifiedTime: input.mtime },
        { onProgress: input.onProgress, isCancelled: input.isCancelled, sleep: this.options.sleep },
      );
      const type = itemTypeOf(file) ?? typeFromName(input.name);
      return this.remember(file, input.parentId, type);
    } finally {
      reader.close?.();
    }
  }

  /** Finds a sub-folder by name under `parentId` (null = the Archive's top folder), or makes it. */
  async createFolder(name: string, parentId: string | null): Promise<StorageItem> {
    this.requireAccount();
    const clean = name.trim();
    if (!clean) throw new Error('Folder name is empty');
    const parent = parentId ?? (await this.ensureRoot());
    const existing = await this.client.findFolder(clean, parent);
    const folder = existing ?? (await this.client.createFolder(clean, parent));
    return this.remember(folder, parentId, 'dir');
  }

  /** Moves the file or folder to the Drive bin (30 days to restore it there). */
  async delete(id: string): Promise<void> {
    this.requireAccount();
    await this.client.trash(id);
    this.cache.delete(id);
  }

  async changes(): Promise<ChangesResult> {
    return { changes: [], cursor: '' };
  }
}
