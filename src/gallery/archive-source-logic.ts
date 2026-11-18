/**
 * Shared gallery, stage 5: the partner's gallery as a source of the Archive and Explore. Pure rules (no phone APIs, tested in Node).
 * Only files that are ON THIS PHONE are shown: a file whose picture (thumbnail, preview or original) the person loaded or downloaded.
 * The rest of the partner's list stays in the partner's gallery screen. Folders show only when something below them is loaded.
 */
import { mimeFromName } from '../storage/item-type';
import type { ListResult, StorageItem } from '../storage/types';
import { ancestorsOf, sortFolderNames, splitGalleryPath } from './gallery-logic';

export const PARTNER_SOURCE_ID = 'partner-gallery';
const FILE = 'pg:';
const DIR = 'pgd:';
const DEFAULT_LIMIT = 100;
/** A tile asking for more than this many pixels is given the 500-700 KB preview instead of the small thumbnail. */
export const PARTNER_PREVIEW_ABOVE = 400;

export const partnerFileId = (id: string): string => `${FILE}${id}`;
export const partnerDirId = (path: string): string => `${DIR}${path}`;

export type PartnerId = { type: 'file'; id: string } | { type: 'dir'; path: string };

/** `pg:<item id>` = a file, `pgd:<folder path>` = a folder (`pgd:` alone = the top of the partner's gallery). Anything else is not ours. */
export function parsePartnerId(id: string): PartnerId | null {
  if (id.startsWith(DIR)) return { type: 'dir', path: id.slice(DIR.length) };
  if (id.startsWith(FILE) && id.length > FILE.length) return { type: 'file', id: id.slice(FILE.length) };
  return null;
}

/** One gallery file of which this phone holds a picture. `used` = when its thumbnail arrived (ms), 0 = no thumbnail stored. */
export type LoadedGalleryItem = { id: string; path: string; name: string; kind: 'i' | 'v' | 'f'; size: number; ord: number; used: number };

export type PartnerTree = {
  files: Map<string, LoadedGalleryItem[]>;
  dirs: Map<string, { path: string; name: string }[]>;
  byId: Map<string, LoadedGalleryItem>;
};

export function buildPartnerTree(items: readonly LoadedGalleryItem[]): PartnerTree {
  const files = new Map<string, LoadedGalleryItem[]>();
  const dirSets = new Map<string, Map<string, { path: string; name: string }>>();
  const byId = new Map<string, LoadedGalleryItem>();
  for (const item of items) {
    if (item.kind === 'f') continue; // only photos and videos belong to the Archive
    byId.set(item.id, item);
    const { parent } = splitGalleryPath(item.path);
    const list = files.get(parent) ?? [];
    list.push(item);
    files.set(parent, list);
    for (const folder of ancestorsOf(item.path)) {
      const f = splitGalleryPath(folder);
      const set = dirSets.get(f.parent) ?? new Map();
      set.set(folder, { path: folder, name: f.name });
      dirSets.set(f.parent, set);
    }
  }
  for (const list of files.values()) list.sort((a, b) => a.ord - b.ord || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dirs = new Map<string, { path: string; name: string }[]>();
  for (const [parent, set] of dirSets) dirs.set(parent, sortFolderNames([...set.values()]));
  return { files, dirs, byId };
}

/** Date shown for a file: when its thumbnail reached this phone. No thumbnail = no real date (stays under one day after 1970, which the app treats as "no date"). */
export function partnerMtime(item: LoadedGalleryItem): string {
  const ms = item.used > 0 ? item.used : (Math.abs(item.ord) % 86_000) * 1000;
  return new Date(ms).toISOString();
}

export function fileItem(item: LoadedGalleryItem): StorageItem {
  const parent = splitGalleryPath(item.path).parent;
  return {
    id: partnerFileId(item.id),
    parentId: partnerDirId(parent),
    name: item.name,
    type: item.kind === 'v' ? 'video' : 'image',
    size: item.size,
    mtime: partnerMtime(item),
    mime: mimeFromName(item.name),
  };
}

export function dirItem(path: string, parentId: string | null, name: string): StorageItem {
  return { id: partnerDirId(path), parentId, name, type: 'dir', size: 0, mtime: new Date(0).toISOString() };
}

/**
 * `list(parentId)` of the provider. null = the roots: ONE folder named `rootName` (nothing when no file is loaded). `pgd:<path>` = that folder:
 * sub-folders first (file-manager order), then files in the sender's copy order; paged by an offset cursor like the vault.
 */
export function listPartner(tree: PartnerTree, parentId: string | null, rootName: string, cursor?: string, limit = DEFAULT_LIMIT): ListResult {
  if (parentId === null) return tree.byId.size === 0 ? { items: [] } : { items: [dirItem('', null, rootName)] };
  const parsed = parsePartnerId(parentId);
  if (!parsed || parsed.type !== 'dir') return { items: [] };
  const folders = (tree.dirs.get(parsed.path) ?? []).map((d) => dirItem(d.path, parentId, d.name));
  const files = (tree.files.get(parsed.path) ?? []).map(fileItem);
  const all = [...folders, ...files];
  const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
  const next = offset + limit;
  return { items: all.slice(offset, next), nextCursor: next < all.length ? String(next) : undefined };
}

/** `stat(id)`: a loaded file, or a folder that has something loaded below it. */
export function statPartner(tree: PartnerTree, id: string, rootName: string): StorageItem | null {
  const parsed = parsePartnerId(id);
  if (!parsed) return null;
  if (parsed.type === 'file') {
    const item = tree.byId.get(parsed.id);
    return item ? fileItem(item) : null;
  }
  if (parsed.path === '') return tree.byId.size === 0 ? null : dirItem('', null, rootName);
  const f = splitGalleryPath(parsed.path);
  const known = (tree.dirs.get(f.parent) ?? []).some((d) => d.path === parsed.path);
  return known ? dirItem(parsed.path, partnerDirId(f.parent), f.name) : null;
}

/** The gallery item id inside a library item id (`pg:<id>`); null for any other id. */
export function partnerFileIdOfItem(itemId: string): string | null {
  const parsed = parsePartnerId(itemId);
  return parsed && parsed.type === 'file' ? parsed.id : null;
}

/**
 * The gallery item id of a library entry that exists ONLY in the partner's gallery (every ref is a partner ref), else null. An entry that
 * also has a copy in the vault needs nothing from the partner's phone.
 */
export function partnerOnlyItemId(refs: readonly { sourceId: string; itemId: string }[], kinds: Readonly<Record<string, string>>): string | null {
  if (refs.length === 0 || refs.some((r) => kinds[r.sourceId] !== 'partner')) return null;
  for (const r of refs) {
    const id = partnerFileIdOfItem(r.itemId);
    if (id) return id;
  }
  return null;
}
