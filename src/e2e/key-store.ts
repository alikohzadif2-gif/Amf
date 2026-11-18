/** Where the E2E keys live: expo-secure-store only (never AsyncStorage, never the server, never a backup). Same lazy-load pattern as `src/server/token-store.ts`. */
export type KvStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

type SecureStoreModule = typeof import('expo-secure-store');

async function load(): Promise<SecureStoreModule | null> {
  try {
    return await import('expo-secure-store');
  } catch {
    return null;
  }
}

export const secureKvStore: KvStore = {
  async get(key) {
    const store = await load();
    if (!store) return null;
    try {
      return await store.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key, value) {
    const store = await load();
    if (!store) throw new Error('Secure storage is not available');
    await store.setItemAsync(key, value);
  },
  async remove(key) {
    const store = await load();
    if (!store) return;
    try {
      await store.deleteItemAsync(key);
    } catch {
      // already gone
    }
  },
};

/** In-memory store for tests. */
export function memoryKvStore(): KvStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}
