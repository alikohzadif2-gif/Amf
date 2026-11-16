import { Directory, File } from 'expo-file-system';
import { relFromUri } from '@/src/vault/logic';
import { vaultDirectory } from '@/src/vault/files';
import { mimeFromName, typeFromName } from './item-type';
import type { ChangesResult, ImageRef, ListOptions, ListResult, ProviderCapabilities, ProviderTestResult, StorageItem, StorageProvider, UploadInput } from './types';

const FS = 'fs:';
const DEFAULT_LIMIT = 100;

const isoFromMs = (ms: number | null | undefined): string => new Date(typeof ms === 'number' && ms > 0 ? ms : 0).toISOString();

/** True for the vault folder itself and anything inside it (never the trash): an id can not point outside the vault. */
function insideVault(uri: string): boolean {
  const root = vaultDirectory().uri.replace(/\/+$/, '');
  const clean = uri.split('?')[0].replace(/\/+$/, '');
  return clean === root || relFromUri(clean, root) !== null;
}

function entryItem(entry: Directory | File, parentId: string | null): StorageItem {
  if (entry instanceof Directory) {
    return { id: `${FS}${entry.uri}`, parentId, name: entry.name, type: 'dir', size: 0, mtime: isoFromMs(null) };
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

/**
 * The private vault as an Archive source (kind `vault`, shown as "Vault"). Read only: adding, unhiding and deleting go through
 * `src/vault/*`, which keep the database and the files in step (and give deletions a way back through the trash).
 */
export class VaultProvider implements StorageProvider {
  readonly isMock = false;
  readonly kind = 'vault' as const;

  constructor(readonly id: string) {}

  capabilities(): ProviderCapabilities {
    return { canUpload: false, canDelete: false, supportsChanges: false, needsPermission: false };
  }

  async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const roots = await this.list(null);
      return { ok: true, code: 'ok', latencyMs: Date.now() - started, rootCount: roots.items.length };
    } catch {
      return { ok: false, code: 'error', latencyMs: Date.now() - started };
    }
  }

  async list(parentId: string | null, options: ListOptions = {}): Promise<ListResult> {
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
    const limit = options.limit ?? DEFAULT_LIMIT;
    let dir: Directory;
    if (parentId === null) dir = vaultDirectory();
    else if (parentId.startsWith(FS) && insideVault(parentId.slice(FS.length))) dir = new Directory(parentId.slice(FS.length));
    else return { items: [] };
    const items = dir
      .list()
      .filter((entry) => !entry.name.startsWith('.')) // `.trash` and the like are not part of the Archive
      .map((entry) => entryItem(entry, parentId))
      .sort((a, b) => {
        if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const next = offset + limit;
    return { items: items.slice(offset, next), nextCursor: next < items.length ? String(next) : undefined };
  }

  async stat(id: string): Promise<StorageItem | null> {
    try {
      if (!id.startsWith(FS) || !insideVault(id.slice(FS.length))) return null;
      const uri = id.slice(FS.length);
      const dir = new Directory(uri);
      if (dir.exists) return entryItem(dir, null);
      const file = new File(uri);
      return file.exists ? entryItem(file, null) : null;
    } catch {
      return null;
    }
  }

  async getThumb(id: string): Promise<ImageRef | null> {
    return this.getPreview(id);
  }

  async getPreview(id: string): Promise<ImageRef | null> {
    const uri = await this.getOriginalUrl(id);
    if (!uri) return null;
    const type = typeFromName(uri.split('/').pop() ?? '');
    return type === 'image' || type === 'video' ? { uri } : null;
  }

  async getOriginalUrl(id: string): Promise<string | null> {
    return id.startsWith(FS) && insideVault(id.slice(FS.length)) ? id.slice(FS.length) : null;
  }

  async upload(_input: UploadInput): Promise<StorageItem> {
    throw new Error('Add files to the vault with the vault screen');
  }

  async delete(_id: string): Promise<void> {
    throw new Error('Vault files are deleted through the vault trash');
  }

  async changes(): Promise<ChangesResult> {
    return { changes: [], cursor: String(Date.now()) };
  }
}
