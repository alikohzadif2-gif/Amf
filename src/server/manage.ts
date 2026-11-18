import { useServersStore } from '@/src/state/servers-store';

/** Removes a saved server (all its addresses and tokens). */
export async function removeServerSource(sourceId: string) {
  const entries = useServersStore.getState().servers.filter((server) => server.sourceId === sourceId);
  for (const entry of entries) await useServersStore.getState().removeServer(entry.id);
}
