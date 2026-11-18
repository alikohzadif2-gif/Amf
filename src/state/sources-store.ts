import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { PARTNER_SOURCE_ID } from '@/src/gallery/archive-source-logic';
import type { SourceConfig } from '@/src/storage/types';

export { PARTNER_SOURCE_ID };

/** The private vault (sharing track, stage 5): files only this app can see, on this phone. */
export const VAULT_SOURCE_ID = 'vault';
const VAULT_SOURCE: SourceConfig = { id: VAULT_SOURCE_ID, kind: 'vault', backend: 'real', enabled: true, builtIn: true };

/** Stage 5: the partner's side of the Shared gallery. Read only; lists only what this phone already holds (see `src/gallery/archive-source-logic.ts`). */
const PARTNER_SOURCE: SourceConfig = { id: PARTNER_SOURCE_ID, kind: 'partner', backend: 'real', enabled: true, builtIn: true };

/** Stage 2A-3: Direct (the vault) is the first source. The old gallery source (`local`) is dropped from the saved list; its files are copied into Direct by `src/vault/legacy-migrate.ts`. Stage 5 adds the partner's gallery. */
export const DEFAULT_SOURCES: SourceConfig[] = [VAULT_SOURCE, PARTNER_SOURCE];

type SourcesState = {
  sources: SourceConfig[];
  setSourceEnabled: (id: string, enabled: boolean) => void;
  resetSources: () => void;
};

export const useSourcesStore = create<SourcesState>()(
  persist(
    (set) => ({
      sources: DEFAULT_SOURCES,
      setSourceEnabled: (id, enabled) =>
        set((state) => ({
          sources: state.sources.map((source) => (source.id === id ? { ...source, enabled } : source)),
        })),
      resetSources: () => set({ sources: DEFAULT_SOURCES }),
    }),
    {
      name: 'meyou-sources',
      storage: createJSONStorage(() => AsyncStorage),
      version: 7,
      // v6: the gallery source (`local`) is gone too. v7: the partner's gallery joins Direct (an old saved list keeps its own `enabled` flags). Only the saved list changes, no file is touched.
      migrate: (persisted) => {
        const state = (persisted ?? {}) as { sources?: SourceConfig[] };
        const kept = (state.sources ?? []).filter((s) => s.kind === 'vault' || s.kind === 'partner');
        const sources = [...kept];
        if (!sources.some((s) => s.id === VAULT_SOURCE_ID)) sources.unshift(VAULT_SOURCE);
        if (!sources.some((s) => s.id === PARTNER_SOURCE_ID)) sources.push(PARTNER_SOURCE);
        return { ...state, sources };
      },
    },
  ),
);
