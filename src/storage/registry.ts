import { createDriveProvider } from '@/src/drive/runtime';
import { createServerProvider } from '@/src/server/runtime';
import { LocalProvider } from './local-provider';
import { VaultProvider } from './vault-provider';
import { isSourceActive } from './active';
import { MockProvider } from './mock-provider';
import type { SourceConfig, StorageProvider } from './types';

const instances = new Map<string, StorageProvider>();

function create(source: SourceConfig): StorageProvider {
  if (source.kind === 'local') return new LocalProvider(source.id);
  if (source.kind === 'vault') return new VaultProvider(source.id);
  if (source.kind === 'drive') return createDriveProvider(source.id);
  if (source.backend === 'mock') return new MockProvider(source.id, source.kind, 40, source.stress === true);
  return createServerProvider(source.id);
}

/** One instance per source, so mock trees keep their changes while the app runs. */
export function getProvider(source: SourceConfig): StorageProvider {
  let provider = instances.get(source.id);
  if (!provider) {
    provider = create(source);
    instances.set(source.id, provider);
  }
  return provider;
}

export function disposeProvider(sourceId: string) {
  instances.delete(sourceId);
}

export function getEnabledProviders(sources: SourceConfig[]): StorageProvider[] {
  return sources.filter(isSourceActive).map(getProvider);
}
