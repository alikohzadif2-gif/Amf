import { hashString, buildMockTree, buildStressTree, type MockTree } from './mock-tree';
import { mimeFromName, typeFromName } from './item-type';
import type {
  ChangesResult,
  ImageRef,
  ListOptions,
  ListResult,
  ProviderCapabilities,
  ProviderChange,
  ProviderTestResult,
  SourceKind,
  StorageItem,
  StorageProvider,
  UploadInput,
} from './types';

const DEFAULT_LIMIT = 100;
const PALETTE = ['#4D887A', '#B7772E', '#537EAA', '#5F875F', '#7C6E9A', '#677983'];

function placeholder(item: StorageItem, size: number): ImageRef {
  const color = PALETTE[hashString(item.id) % PALETTE.length];
  const label = item.type === 'video' ? '▶' : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect width="100%" height="100%" fill="${color}"/>` +
    `<text x="50%" y="55%" font-size="${Math.round(size / 4)}" fill="#fff" ` +
    `text-anchor="middle">${label}</text></svg>`;
  return { uri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * In-memory fake backend used for demo "server" sources. Same instance = same tree.
 * `seed` picks the tree (default: the kind); two seeds share about 60% of their
 * Photos/Videos files so diff and merge logic can be tested.
 */
export class MockProvider implements StorageProvider {
  readonly isMock = true;
  private tree: MockTree;
  private log: ProviderChange[] = [];

  constructor(
    readonly id: string,
    readonly kind: Exclude<SourceKind, 'local' | 'vault'>,
    private readonly latencyMs = 40,
    stress = false,
    seed: string = kind,
  ) {
    this.tree = stress ? buildStressTree(id) : buildMockTree(seed);
  }

  capabilities(): ProviderCapabilities {
    return {
      canUpload: true,
      canDelete: true,
      supportsChanges: true,
      needsPermission: false,
    };
  }

  async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    await wait(this.latencyMs);
    return {
      ok: true,
      code: 'ok',
      latencyMs: Date.now() - started,
      rootCount: (this.tree.children.get(null) ?? []).length,
    };
  }

  async list(parentId: string | null, options: ListOptions = {}): Promise<ListResult> {
    const ids = this.tree.children.get(parentId) ?? [];
    const items = ids
      .map((id) => this.tree.items.get(id))
      .filter((item): item is StorageItem => item !== undefined)
      .sort((a, b) => {
        if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const page = items.slice(offset, offset + limit);
    const next = offset + limit;
    return { items: page, nextCursor: next < items.length ? String(next) : undefined };
  }

  async stat(id: string): Promise<StorageItem | null> {
    return this.tree.items.get(id) ?? null;
  }

  async getThumb(id: string, size = 256): Promise<ImageRef | null> {
    const item = this.tree.items.get(id);
    if (!item || (item.type !== 'image' && item.type !== 'video')) return null;
    return placeholder(item, size);
  }

  async getPreview(id: string): Promise<ImageRef | null> {
    const item = this.tree.items.get(id);
    if (!item || (item.type !== 'image' && item.type !== 'video')) return null;
    return placeholder(item, 800);
  }

  async getOriginalUrl(id: string): Promise<string | null> {
    return this.tree.items.has(id) ? `mock://${this.id}/${encodeURI(id)}` : null;
  }

  async upload(input: UploadInput): Promise<StorageItem> {
    const parent = input.parentId;
    if (parent !== null && this.tree.items.get(parent)?.type !== 'dir') {
      throw new Error('Parent folder not found');
    }
    const id = parent === null ? input.name : `${parent}/${input.name}`;
    const item: StorageItem = {
      id,
      parentId: parent,
      name: input.name,
      type: typeFromName(input.name),
      size: input.size,
      mtime: new Date().toISOString(),
      md5: input.md5,
      mime: mimeFromName(input.name),
    };
    const existed = this.tree.items.has(id);
    this.tree.items.set(id, item);
    if (!existed) {
      const siblings = this.tree.children.get(parent) ?? [];
      siblings.push(id);
      this.tree.children.set(parent, siblings);
    }
    input.onProgress?.(input.size, input.size);
    this.log.push({ id, op: existed ? 'update' : 'add', item });
    return item;
  }

  async delete(id: string): Promise<void> {
    const item = this.tree.items.get(id);
    if (!item) return;
    const remove = (itemId: string) => {
      for (const child of this.tree.children.get(itemId) ?? []) remove(child);
      this.tree.children.delete(itemId);
      this.tree.items.delete(itemId);
    };
    remove(id);
    const siblings = this.tree.children.get(item.parentId) ?? [];
    this.tree.children.set(
      item.parentId,
      siblings.filter((sibling) => sibling !== id),
    );
    this.log.push({ id, op: 'delete' });
  }

  async changes(since?: string): Promise<ChangesResult> {
    const from = since ? Number.parseInt(since, 10) || 0 : 0;
    return { changes: this.log.slice(from), cursor: String(this.log.length) };
  }
}
