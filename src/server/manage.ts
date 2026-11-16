import { useServersStore } from '@/src/state/servers-store';
import { useSourcesStore } from '@/src/state/sources-store';

/** Removes a real server source together with all its saved addresses and tokens. */
export async function removeServerSource(sourceId: string) {
  const entries = useServersStore.getState().servers.filter((server) => server.sourceId === sourceId);
  for (const entry of entries) await useServersStore.getState().removeServer(entry.id);
  useSourcesStore.getState().removeSource(sourceId);
}
