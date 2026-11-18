import { PartnerGalleryProvider } from './partner-gallery-provider';
import { VaultProvider } from './vault-provider';
import type { SourceConfig, StorageProvider } from './types';

const instances = new Map<string, StorageProvider>();

/** Two real providers: Direct (the vault, since stage 2A-3) and the partner's gallery (stage 5, read only). */
function create(source: SourceConfig): StorageProvider {
  return source.kind === 'partner' ? new PartnerGalleryProvider(source.id) : new VaultProvider(source.id);
}

/** One instance per source, so providers keep their state while the app runs. */
export function getProvider(source: SourceConfig): StorageProvider {
  let provider = instances.get(source.id);
  if (!provider) {
    provider = create(source);
    instances.set(source.id, provider);
  }
  return provider;
}

