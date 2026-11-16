import { Directory, File, Paths } from 'expo-file-system';
import { mimeFromName, typeFromName } from './item-type';
import type {
  ChangesResult,
  ImageRef,
  ListOptions,
  ListResult,
  ProviderCapabilities,
  ProviderTestResult,
  StorageItem,
  StorageProvider,
  UploadInput,
} from './types';

type MediaLib = typeof import('expo-media-library');

const FS = 'fs:';
const ALBUM = 'ml:album:';
const ASSET = 'ml:asset:';
const LIBRARY_ID = `${FS}library`;
const DEFAULT_LIMIT = 100;
const PERMS: ('photo' | 'video')[] = ['photo', 'video'];

/** Loaded lazily: Expo Go limits media access, and the module may be missing. */
async function loadMediaLibrary(): Promise<MediaLib | null> {
  try {
    return await import('expo-media-library');
  } catch {
    return null;
  }
}

function libraryDirectory(): Directory {
  const dir = new Directory(Paths.document, 'meyou-library');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function resolveFsUri(id: string): string {
  return id === LIBRARY_ID ? libraryDirectory().uri : id.slice(FS.length);
}

function isoFromMs(ms: number | null | undefined): string {
  return new Date(typeof ms === 'number' && ms > 0 ? ms : 0).toISOString();
}

function fsItem(entry: Directory | File, parentId: string | null): StorageItem {
  if (entry instanceof Directory) {
    return {
      id: `${FS}${entry.uri}`,
      parentId,
      name: entry.name,
      type: 'dir',
      size: 0,
      mtime: isoFromMs(null),
    };
  }
  return {
    id: `${FS}${entry.uri}`,
    parentId,
    name: entry.name,
    type: typeFromName(entry.name),
    size: entry.size ?? 0,
    mtime: isoFromMs(entry.modificationTime),
    mime: mimeFromName(entry.name),
  };
}

export class LocalProvider implements StorageProvider {
  readonly isMock = false;
  readonly kind = 'local' as const;

  constructor(readonly id: string) {}

  capabilities(): ProviderCapabilities {
    return {
      canUpload: true,
      canDelete: true,
      supportsChanges: false,
      needsPermission: true,
    };
  }

  private async hasGalleryAccess(lib: MediaLib | null): Promise<boolean> {
    if (!lib) return false;
    try {
      const result = await lib.getPermissionsAsync(false, PERMS);
      return result.granted;
    } catch {
      return false;
    }
  }

  async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      libraryDirectory();
      const lib = await loadMediaLibrary();
      const granted = await this.hasGalleryAccess(lib);
      const roots = await this.list(null);
      return {
        ok: granted,
        code: granted ? 'ok' : lib ? 'permission-needed' : 'unavailable',
        latencyMs: Date.now() - started,
        rootCount: roots.items.length,
      };
    } catch {
      return { ok: false, code: 'error', latencyMs: Date.now() - started };
    }
  }

  async requestAccess(): Promise<ProviderTestResult> {
    try {
      const lib = await loadMediaLibrary();
      if (lib) await lib.requestPermissionsAsync(false, PERMS);
    } catch {
      // fall through: test() reports the real state
    }
    return this.test();
  }

  async list(parentId: string | null, options: ListOptions = {}): Promise<ListResult> {
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
    const limit = options.limit ?? DEFAULT_LIMIT;

    if (parentId === null) {
      const roots: StorageItem[] = [
        {
          id: LIBRARY_ID,
          parentId: null,
          name: 'meYou',
          type: 'dir',
          size: 0,
          mtime: isoFromMs(null),
        },
      ];
      const lib = await loadMediaLibrary();
      if (lib && (await this.hasGalleryAccess(lib))) {
        try {
          const albums = await lib.Album.getAll();
          // One broken album (e.g. its title cannot be read) must not hide the albums after it: each one is read on its own.
          const seen = new Set<string>();
          for (const album of albums) {
            try {
              const id = `${ALBUM}${album.id}`;
              if (seen.has(id)) continue;
              seen.add(id);
              const title = (await album.getTitle()).trim();
              if (!title) continue;
              roots.push({ id, parentId: null, name: title, type: 'dir', size: 0, mtime: isoFromMs(null) });
            } catch {
              // skip only this album
            }
          }
        } catch {
          // gallery unavailable: only app files are listed
        }
      }
      return { items: roots };
    }

    if (parentId.startsWith(FS)) {
      const entries = new Directory(resolveFsUri(parentId)).list();
      const items = entries
        .map((entry) => fsItem(entry, parentId))
        .sort((a, b) => {
          if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const next = offset + limit;
      return {
        items: items.slice(offset, next),
        nextCursor: next < items.length ? String(next) : undefined,
      };
    }

    if (parentId.startsWith(ALBUM)) {
      const lib = await loadMediaLibrary();
      if (!lib) return { items: [] };
      const album = new lib.Album(parentId.slice(ALBUM.length));
      const rows = await new lib.Query()
        .album(album)
        .orderBy({ key: lib.AssetField.CREATION_TIME, ascending: false })
        .limit(limit + 1)
        .offset(offset)
        .exeForMetadata();
      const page = rows.slice(0, limit).map<StorageItem>((row) => ({
        id: `${ASSET}${row.id}`,
        parentId,
        name: row.filename ?? row.id,
        // MediaStore sometimes reports a video/photo as "unknown" (e.g. .mkv, .3gp); the file name then decides.
        type:
          row.mediaType === lib.MediaType.VIDEO
            ? 'video'
            : row.mediaType === lib.MediaType.IMAGE
              ? 'image'
              : typeFromName(row.filename ?? ''),
        size: 0,
        mtime: isoFromMs(row.modificationTime ?? row.creationTime),
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        // MediaStore gives the duration in milliseconds; the app uses seconds (like the server)
        duration: row.duration ? Math.round(row.duration / 1000) : undefined,
      }));
      return {
        items: page,
        nextCursor: rows.length > limit ? String(offset + limit) : undefined,
      };
    }

    return { items: [] };
  }

  async stat(id: string): Promise<StorageItem | null> {
    try {
      if (id.startsWith(FS)) {
        const uri = resolveFsUri(id);
        const info = Paths.info(uri);
        if (!info.exists) return null;
        return fsItem(info.isDirectory ? new Directory(uri) : new File(uri), null);
      }
      if (id.startsWith(ASSET)) {
        const lib = await loadMediaLibrary();
        if (!lib) return null;
        const asset = new lib.Asset(id.slice(ASSET.length));
        const name = await asset.getFilename();
        return {
          id,
          parentId: null,
          name,
          type: typeFromName(name),
          size: 0,
          mtime: isoFromMs(await asset.getModificationTime()),
          width: await asset.getWidth(),
          height: await asset.getHeight(),
          duration: await asset.getDuration().then((ms) => (ms ? Math.round(ms / 1000) : undefined)),
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  async getThumb(id: string): Promise<ImageRef | null> {
    return this.getPreview(id);
  }

  async getPreview(id: string): Promise<ImageRef | null> {
    const uri = await this.getOriginalUrl(id);
    if (!uri) return null;
    const type = typeFromName(uri.split('/').pop() ?? '');
    return id.startsWith(ASSET) || type === 'image' || type === 'video' ? { uri } : null;
  }

  async getOriginalUrl(id: string): Promise<string | null> {
    try {
      if (id.startsWith(FS)) return resolveFsUri(id);
      if (id.startsWith(ASSET)) {
        const lib = await loadMediaLibrary();
        return lib ? await new lib.Asset(id.slice(ASSET.length)).getUri() : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  async upload(input: UploadInput): Promise<StorageItem> {
    const parentUri =
      input.parentId === null || input.parentId === LIBRARY_ID
        ? libraryDirectory().uri
        : input.parentId.startsWith(FS)
          ? resolveFsUri(input.parentId)
          : null;
    if (parentUri === null) throw new Error('Uploads go to app files only');
    const target = new File(new Directory(parentUri), input.name);
    // Keep picked media byte-for-byte: no resize, re-encode, EXIF stripping, or transcoding here.
    new File(input.sourceUri).copySync(target);
    input.onProgress?.(input.size, input.size);
    return fsItem(target, input.parentId);
  }

  /** Finds or creates a sub-folder of the app library (U7: `Snaps`). Only app files, never the phone gallery. */
  async createFolder(name: string, parentId: string | null): Promise<StorageItem> {
    const clean = name.replace(/[\\/:*?"<>|]/g, '').trim();
    if (!clean) throw new Error('Folder name is empty');
    const parentUri =
      parentId === null || parentId === LIBRARY_ID ? libraryDirectory().uri : parentId.startsWith(FS) ? resolveFsUri(parentId) : null;
    if (parentUri === null) throw new Error('Folders go to app files only');
    const dir = new Directory(new Directory(parentUri), clean);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return fsItem(dir, parentId ?? LIBRARY_ID);
  }

  async delete(id: string): Promise<void> {
    if (id.startsWith(FS)) {
      const uri = resolveFsUri(id);
      if (!Paths.info(uri).exists) return;
      if (Paths.info(uri).isDirectory) new Directory(uri).delete();
      else new File(uri).delete();
      return;
    }
    if (id.startsWith(ASSET)) {
      const lib = await loadMediaLibrary();
      if (lib) await lib.Asset.delete([new lib.Asset(id.slice(ASSET.length))]);
    }
  }

  async changes(): Promise<ChangesResult> {
    return { changes: [], cursor: String(Date.now()) };
  }
}
