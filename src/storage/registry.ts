import { VaultProvider } from './vault-provider';
import type { SourceConfig, StorageProvider } from './types';

const instances = new Map<string, StorageProvider>();

/** Direct (the vault) is the only real provider since stage 2A-3. */
function create(source: SourceConfig): StorageProvider {
  return new VaultProvider(source.id);
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

