import { mimeFromName, typeFromName } from './item-type';
import type { StorageItem } from './types';

/** Deterministic PRNG so mock trees are identical after every restart. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 32 hex chars that look like an md5 (fake, deterministic). */
export function fakeMd5(key: string): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += hashString(`${i}:${key}`).toString(16).padStart(8, '0');
  }
  return out;
}

type FolderSpec = {
  name: string;
  /** Items placed directly in this folder. */
  photos?: number;
  videos?: number;
  files?: number;
  texts?: number;
  children?: FolderSpec[];
};

/**
 * Four top folders with nested subfolders, about 300 items in total.
 * Both mocks share the first ~60% of items of "Photos" and "Videos"
 * (same name, size, mtime, md5) so later sync phases can test diffs.
 */
const SPEC: FolderSpec[] = [
  {
    name: 'Photos',
    children: [
      { name: '2024', photos: 28, children: [{ name: 'Summer', photos: 22 }, { name: 'Winter', photos: 18 }] },
      { name: '2025', photos: 30, children: [{ name: 'City', photos: 20 }] },
      { name: 'Favorites', photos: 24 },
    ],
  },
  {
    name: 'Videos',
    children: [
      { name: 'Trips', videos: 14, children: [{ name: 'Mountains', videos: 10 }] },
      { name: 'Everyday', videos: 18 },
    ],
  },
  {
    name: 'Documents',
    files: 18,
    texts: 12,
    children: [
      { name: 'Notes', texts: 20 },
      { name: 'Papers', files: 14 },
    ],
  },
  {
    name: 'Shared',
    photos: 16,
    videos: 6,
    children: [{ name: 'Inbox', photos: 12, texts: 6 }, { name: 'Misc', files: 8 }],
  },
];

export type MockTree = {
  items: Map<string, StorageItem>;
  children: Map<string | null, string[]>;
};

const START = Date.UTC(2022, 0, 1);
const SPAN = Date.UTC(2026, 9, 1) - START;

function makeFile(
  kind: 'photo' | 'video' | 'file' | 'text',
  index: number,
  parentId: string,
  rand: () => number,
  nameKey: string,
): StorageItem {
  const stamp = Math.floor(rand() * 1e6);
  let name: string;
  let size: number;
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;
  if (kind === 'photo') {
    name = `IMG_${String(index + 1).padStart(4, '0')}.jpg`;
    size = 800_000 + Math.floor(rand() * 5_000_000);
    const landscape = rand() > 0.35;
    width = landscape ? 4032 : 3024;
    height = landscape ? 3024 : 4032;
  } else if (kind === 'video') {
    name = `VID_${String(index + 1).padStart(4, '0')}.mp4`;
    size = 8_000_000 + Math.floor(rand() * 180_000_000);
    width = 1920;
    height = 1080;
    duration = 5 + Math.floor(rand() * 240);
  } else if (kind === 'text') {
    name = `note-${String(index + 1).padStart(3, '0')}.txt`;
    size = 200 + Math.floor(rand() * 9_000);
  } else {
    name = `file-${String(index + 1).padStart(3, '0')}.pdf`;
    size = 40_000 + Math.floor(rand() * 4_000_000);
  }
  const mtime = new Date(START + Math.floor(rand() * SPAN)).toISOString();
  const id = `${parentId}/${name}`;
  return {
    id,
    parentId,
    name,
    type: typeFromName(name),
    size,
    mtime,
    md5: fakeMd5(`${nameKey}|${name}|${size}|${mtime}|${stamp % 1}`),
    mime: mimeFromName(name),
    width,
    height,
    duration,
  };
}

export function buildMockTree(providerSeed: string): MockTree {
  const items = new Map<string, StorageItem>();
  const children = new Map<string | null, string[]>();
  const add = (item: StorageItem) => {
    items.set(item.id, item);
    const list = children.get(item.parentId) ?? [];
    list.push(item.id);
    children.set(item.parentId, list);
  };

  const walk = (spec: FolderSpec, parentId: string | null, path: string) => {
    const id = parentId === null ? spec.name : `${parentId}/${spec.name}`;
    add({
      id,
      parentId,
      name: spec.name,
      type: 'dir',
      size: 0,
      mtime: new Date(START + (hashString(id) % SPAN)).toISOString(),
    });
    const groups: ['photo' | 'video' | 'file' | 'text', number | undefined][] = [
      ['photo', spec.photos],
      ['video', spec.videos],
      ['file', spec.files],
      ['text', spec.texts],
    ];
    const sharedFolder = path.startsWith('Photos') || path.startsWith('Videos');
    for (const [kind, count] of groups) {
      for (let i = 0; i < (count ?? 0); i += 1) {
        const shared = sharedFolder && i < Math.ceil((count ?? 0) * 0.6);
        const nameKey = shared ? 'shared' : providerSeed;
        const rand = mulberry32(hashString(`${nameKey}:${id}:${kind}:${i}`));
        add(makeFile(kind, i, id, rand, nameKey));
      }
    }
    for (const child of spec.children ?? []) {
      walk(child, id, `${path}/${child.name}`);
    }
  };

  for (const top of SPEC) walk(top, null, top.name);
  return { items, children };
}

export function countFiles(tree: MockTree): number {
  let n = 0;
  for (const item of tree.items.values()) if (item.type !== 'dir') n += 1;
  return n;
}

/**
 * Large demo tree (about 5,000 photos/videos) for testing scroll speed.
 * Separate from buildMockTree so the normal mocks stay at ~300 items.
 */
export function buildStressTree(providerSeed: string, total = 5000): MockTree {
  const items = new Map<string, StorageItem>();
  const children = new Map<string | null, string[]>();
  const add = (item: StorageItem) => {
    items.set(item.id, item);
    const list = children.get(item.parentId) ?? [];
    list.push(item.id);
    children.set(item.parentId, list);
  };
  const root = 'Large';
  add({ id: root, parentId: null, name: root, type: 'dir', size: 0, mtime: new Date(START).toISOString() });
  const folders = 10;
  const perFolder = Math.ceil(total / folders);
  let made = 0;
  for (let f = 0; f < folders; f += 1) {
    const folderId = `${root}/Set-${String(f + 1).padStart(2, '0')}`;
    add({ id: folderId, parentId: root, name: `Set-${String(f + 1).padStart(2, '0')}`, type: 'dir', size: 0, mtime: new Date(START).toISOString() });
    for (let i = 0; i < perFolder && made < total; i += 1, made += 1) {
      const rand = mulberry32(hashString(`${providerSeed}:stress:${made}`));
      add(makeFile(made % 12 === 0 ? 'video' : 'photo', made, folderId, rand, `stress-${providerSeed}`));
    }
  }
  return { items, children };
}
