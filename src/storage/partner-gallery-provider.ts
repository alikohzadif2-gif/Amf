import { getDictionary } from '@/src/i18n';
import { buildPartnerTree, listPartner, parsePartnerId, PARTNER_PREVIEW_ABOVE, statPartner, type PartnerTree } from '@/src/gallery/archive-source-logic';
import { partnerEpoch } from '@/src/gallery/archive-epoch';
import { loadedGalleryItems } from '@/src/gallery/gallery-db';
import { galleryRef } from '@/src/gallery/gallery-ref';
import { getPartnerMedia, partnerOriginalUri } from '@/src/partner/media-store';
import { getSharedDb } from '@/src/vault/db-ref';
import { useSettingsStore } from '@/src/state/settings-store';
import type { ChangesResult, ImageRef, ListOptions, ListResult, ProviderCapabilities, ProviderTestResult, StorageItem, StorageProvider, UploadInput } from './types';

type Snapshot = { key: string; tree: PartnerTree };

/**
 * Shared gallery, stage 5: the partner's gallery as a read-only Archive/Explore source (kind `partner`). It lists only the files of which this
 * phone holds a picture (loaded in the partner's gallery screen, or downloaded). Everything it shows is already on the phone, so no call here
 * asks the partner's phone for anything; the original is asked for in the viewer (`ArchiveOriginalBar`).
 * The list is read once per `partnerEpoch()` and kept, so an index walk (one `list` per folder) reads the database once.
 */
export class PartnerGalleryProvider implements StorageProvider {
  readonly isMock = false;
  readonly kind = 'partner' as const;
  private snapshot: Snapshot | null = null;
  private pending: { key: string; promise: Promise<Snapshot> } | null = null;

  constructor(readonly id: string) {}

  capabilities(): ProviderCapabilities {
    return { canUpload: false, canDelete: false, supportsChanges: false, needsPermission: false };
  }

  private rootName(): string {
    return getDictionary(useSettingsStore.getState().language).galleryPartnerTitle;
  }

  private current(): Promise<Snapshot> {
    const key = partnerEpoch();
    if (this.snapshot && this.snapshot.key === key) return Promise.resolve(this.snapshot);
    if (this.pending && this.pending.key === key) return this.pending.promise;
    const promise = (async (): Promise<Snapshot> => {
      let tree = buildPartnerTree([]);
      try {
        const db = getSharedDb();
        if (db) tree = buildPartnerTree(await loadedGalleryItems(db));
      } catch {
        // the list could not be read: show nothing rather than fail the whole index
      }
      const made = { key, tree };
      this.snapshot = made;
      return made;
    })();
    this.pending = { key, promise };
    return promise;
  }

  async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    const roots = await this.list(null);
    return { ok: true, code: 'ok', latencyMs: Date.now() - started, rootCount: roots.items.length };
  }

  async list(parentId: string | null, options: ListOptions = {}): Promise<ListResult> {
    const { tree } = await this.current();
    return listPartner(tree, parentId, this.rootName(), options.cursor, options.limit);
  }

  async stat(id: string): Promise<StorageItem | null> {
    const { tree } = await this.current();
    return statPartner(tree, id, this.rootName());
  }

  /** The ref (`Shared/<id>/<name>`) under which the picture cache stores this file; null for a folder or an unknown id. */
  private async refOf(id: string): Promise<string | null> {
    const parsed = parsePartnerId(id);
    if (!parsed || parsed.type !== 'file') return null;
    const { tree } = await this.current();
    const item = tree.byId.get(parsed.id);
    return item ? galleryRef(item.id, item.path) : null;
  }

  /** The small picture for a tile; a big tile (Explore's large ones) gets the 500-700 KB preview when this phone has it. */
  async getThumb(id: string, size?: number): Promise<ImageRef | null> {
    const ref = await this.refOf(id);
    const db = getSharedDb();
    if (!ref || !db) return null;
    const found = await getPartnerMedia(db, ref, size !== undefined && size > PARTNER_PREVIEW_ABOVE ? 'preview' : 'thumb');
    return found ? found.image : null;
  }

  /** The best picture on the phone: the original when downloaded, else the preview, else the thumbnail. */
  async getPreview(id: string): Promise<ImageRef | null> {
    const ref = await this.refOf(id);
    const db = getSharedDb();
    if (!ref || !db) return null;
    const found = await getPartnerMedia(db, ref, 'original');
    return found ? found.image : null;
  }

  async getOriginalUrl(id: string): Promise<string | null> {
    const ref = await this.refOf(id);
    const db = getSharedDb();
    if (!ref || !db) return null;
    return partnerOriginalUri(db, ref);
  }

  async upload(_input: UploadInput): Promise<StorageItem> {
    throw new Error("The partner's gallery is read only");
  }

  async delete(_id: string): Promise<void> {
    throw new Error("The partner's gallery is read only");
  }

  async changes(): Promise<ChangesResult> {
    return { changes: [], cursor: String(Date.now()) };
  }
}
