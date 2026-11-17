import { getProvider } from '@/src/storage/registry';
import type { SourceKind, StorageProvider } from '@/src/storage/types';
import { useSourcesStore } from '@/src/state/sources-store';
import { isSourceActive } from '@/src/storage/active';

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

export function enabledSignature(): string {
  return useSourcesStore
    .getState()
    .sources.filter(isSourceActive)
    .map((source) => source.id)
    .join('|');
}
