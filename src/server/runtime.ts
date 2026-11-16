import { useSettingsStore } from '@/src/state/settings-store';
import { useServersStore } from '@/src/state/servers-store';
import { openFileReader } from './file-reader';
import { ServerProvider } from './server-provider';
import { secureTokenStore } from './token-store';
import type { Endpoint } from './types';

/** Endpoints of one server source, in failover order, with tokens from SecureStore. */
export async function endpointsFor(sourceId: string): Promise<Endpoint[]> {
  const entries = useServersStore.getState().servers.filter((server) => server.sourceId === sourceId);
  const out: Endpoint[] = [];
  for (const entry of entries) {
    const token = await secureTokenStore.get(entry.id);
    if (token) out.push({ id: entry.id, url: entry.url, token });
  }
  return out;
}

/** The real file-server provider for one source (wired into the registry). */
export function createServerProvider(sourceId: string): ServerProvider {
  return new ServerProvider(sourceId, {
    endpoints: () => endpointsFor(sourceId),
    failover: () => useSettingsStore.getState().serverFailover,
    openReader: openFileReader,
  });
}
