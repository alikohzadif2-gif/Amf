import { usePartnerMediaVersion } from '@/src/partner/media-version';
import { usePartnerStore } from '@/src/state/partner-store';

/**
 * Changes whenever what the partner's gallery source would list may have changed: a picture of the partner was stored or removed
 * (`usePartnerMediaVersion`) or the partner's list changed (`galleryTick`). The library index adds it to its signature, so the next
 * `build()` lists the source again; the provider keeps its snapshot under the same key.
 */
export function partnerEpoch(): string {
  return `${usePartnerMediaVersion.getState().version}.${usePartnerStore.getState().galleryTick}`;
}
