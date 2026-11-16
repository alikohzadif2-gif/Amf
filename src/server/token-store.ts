import type { TokenStore } from './types';

const KEY_PREFIX = 'meyou-server-token-';
// SecureStore keys may only contain letters, digits, '.', '-' and '_'.
const keyFor = (serverId: string) => `${KEY_PREFIX}${serverId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

type SecureStoreModule = typeof import('expo-secure-store');

/** Loaded lazily so a missing native module never crashes the app at start-up. */
async function load(): Promise<SecureStoreModule | null> {
  try {
    return await import('expo-secure-store');
  } catch {
    return null;
  }
}

/** Server tokens live in expo-secure-store (brief rule 7); never in AsyncStorage. */
export const secureTokenStore: TokenStore = {
  async get(serverId) {
    const store = await load();
    if (!store) return null;
    try {
      return await store.getItemAsync(keyFor(serverId));
    } catch {
      return null;
    }
  },
  async set(serverId, token) {
    const store = await load();
    if (!store) throw new Error('Secure storage is not available');
    await store.setItemAsync(keyFor(serverId), token);
  },
  async remove(serverId) {
    const store = await load();
    if (!store) return;
    try {
      await store.deleteItemAsync(keyFor(serverId));
    } catch {
      // already gone
    }
  },
};

/** In-memory store for tests. */
export function memoryTokenStore(): TokenStore {
  const map = new Map<string, string>();
  return {
    async get(id) {
      return map.get(id) ?? null;
    },
    async set(id, token) {
      map.set(id, token);
    },
    async remove(id) {
      map.delete(id);
    },
  };
}
