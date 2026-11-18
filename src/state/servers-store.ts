import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ServerEntry } from '@/src/server/types';
import { secureTokenStore } from '@/src/server/token-store';

/**
 * Saved personal servers, in failover order. Entries that share a `sourceId`
 * are addresses of the same library (e.g. home Wi-Fi, public domain, VPN):
 * the first reachable one is used. Tokens are NOT stored here (SecureStore).
 */
type ServersState = {
  servers: ServerEntry[];
  addServer: (entry: Omit<ServerEntry, 'id' | 'addedAt'>) => string;
  updateServer: (id: string, patch: Partial<Pick<ServerEntry, 'name' | 'url' | 'fingerprint' | 'fingerprintConfirmed'>>) => void;
  /** Removes the entry and its token; returns the source id when it was the last entry of that source. */
  removeServer: (id: string) => Promise<string | null>;
  moveServer: (id: string, direction: -1 | 1) => void;
  clearAll: () => Promise<void>;
};

export const useServersStore = create<ServersState>()(
  persist(
    (set, get) => ({
      servers: [],
      addServer: (entry) => {
        const id = `srv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const addedAt = new Date().toISOString();
        set((state) => ({ servers: [...state.servers, { ...entry, id, addedAt }] }));
        return id;
      },
      updateServer: (id, patch) =>
        set((state) => ({
          servers: state.servers.map((server) => (server.id === id ? { ...server, ...patch } : server)),
        })),
      removeServer: async (id) => {
        const entry = get().servers.find((server) => server.id === id);
        if (!entry) return null;
        await secureTokenStore.remove(id);
        const rest = get().servers.filter((server) => server.id !== id);
        set({ servers: rest });
        return rest.some((server) => server.sourceId === entry.sourceId) ? null : entry.sourceId;
      },
      moveServer: (id, direction) =>
        set((state) => {
          const entry = state.servers.find((server) => server.id === id);
          if (!entry) return state;
          const group = state.servers.filter((server) => server.sourceId === entry.sourceId);
          const at = group.findIndex((server) => server.id === id);
          const swap = group[at + direction];
          if (!swap) return state;
          const servers = state.servers.slice();
          const a = servers.findIndex((server) => server.id === id);
          const b = servers.findIndex((server) => server.id === swap.id);
          [servers[a], servers[b]] = [servers[b], servers[a]];
          return { servers };
        }),
      clearAll: async () => {
        for (const server of get().servers) await secureTokenStore.remove(server.id);
        set({ servers: [] });
      },
    }),
    {
      name: 'meyou-servers',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);
