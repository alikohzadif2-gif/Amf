import { useLibraryIndex } from '@/src/library/index-store';
import { usePartnerMediaVersion } from '@/src/partner/media-version';
import { usePartnerStore } from '@/src/state/partner-store';

/** Quiet time after the last change before the library index lists the partner's gallery again (a scroll stores many thumbnails in a row). */
export const ARCHIVE_SYNC_QUIET_MS = 6000;

/**
 * Shared gallery, stage 5: keeps Archive and Explore in step with what the partner's gallery holds on this phone. When a picture of the
 * partner is stored or removed, or the partner's list changes, the index is built again after a quiet moment. `build()` does nothing when
 * the signature (which includes `partnerEpoch()`) did not change, and nothing is built before an Archive/Explore screen first asks for it.
 * Returns the function that stops it.
 */
export function startArchiveSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const index = useLibraryIndex.getState();
      if (index.status === 'idle') return;
      if (index.status === 'indexing') {
        later();
        return;
      }
      void index.build().catch(() => undefined);
    }, ARCHIVE_SYNC_QUIET_MS);
  };
  const stopMedia = usePartnerMediaVersion.subscribe(later);
  const stopGallery = usePartnerStore.subscribe((state, previous) => {
    if (state.galleryTick !== previous.galleryTick) later();
  });
  return () => {
    if (timer) clearTimeout(timer);
    stopMedia();
    stopGallery();
  };
}
