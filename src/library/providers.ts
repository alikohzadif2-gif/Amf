import { getProvider } from '@/src/storage/registry';
import type { SourceKind, StorageProvider } from '@/src/storage/types';
import { useSourcesStore } from '@/src/state/sources-store';
import { isSourceActive } from '@/src/storage/active';
import { partnerEpoch } from '@/src/gallery/archive-epoch';

export function enabledProviders(): StorageProvider[] {
  return useSourcesStore
    .getState()
    .sources.filter(isSourceActive)
    .map(getProvider);
}

export function providerFor(sourceId: string): StorageProvider | null {
  const source = useSourcesStore.getState().sources.find((s) => s.id === sourceId);
  return source ? getProvider(source) : null;
}

/** sourceId -> kind for every known source (enabled or not). */
export function sourceKinds(): Record<string, SourceKind> {
  const kinds: Record<string, SourceKind> = {};
  for (const source of useSourcesStore.getState().sources) kinds[source.id] = source.kind;
  return kinds;
}

/**
 * Which sources are on, plus (while the partner's gallery is on) a counter that moves when its list may have changed, so a plain
 * `build()` lists everything again after a picture of the partner arrived and does nothing otherwise.
 */
export function enabledSignature(): string {
  const active = useSourcesStore.getState().sources.filter(isSourceActive);
  const ids = active.map((source) => source.id).join('|');
  return active.some((source) => source.kind === 'partner') ? `${ids}|${partnerEpoch()}` : ids;
}
