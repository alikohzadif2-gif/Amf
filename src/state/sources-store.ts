import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { disposeProvider } from '@/src/storage/registry';
import type { SourceConfig } from '@/src/storage/types';

/** The one built-in Google Drive source. It takes part in the Archive/Explore only while an account is signed in. */
export const DRIVE_SOURCE_ID = 'drive';
const DRIVE_SOURCE: SourceConfig = { id: DRIVE_SOURCE_ID, kind: 'drive', backend: 'real', enabled: true, builtIn: true };
/** The private vault (sharing track, stage 5): files only this app can see, on this phone. */
export const VAULT_SOURCE_ID = 'vault';
const VAULT_SOURCE: SourceConfig = { id: VAULT_SOURCE_ID, kind: 'vault', backend: 'real', enabled: true, builtIn: true };

export const DEFAULT_SOURCES: SourceConfig[] = [
  { id: 'local', kind: 'local', backend: 'real', enabled: true, builtIn: true },
  DRIVE_SOURCE,
  VAULT_SOURCE,
  { id: 'mock-server', kind: 'server', backend: 'mock', enabled: false, builtIn: true },
];

type SourcesState = {
  sources: SourceConfig[];
  addMockSource: (kind: 'server', name?: string) => string;
  addStressSource: (name?: string) => string;
  /** A real personal-server source (its addresses live in the servers store). */
  addServerSource: (name?: string) => string;
  removeSource: (id: string) => void;
  setSourceEnabled: (id: string, enabled: boolean) => void;
  renameSource: (id: string, name: string) => void;
  resetSources: () => void;
};

export const useSourcesStore = create<SourcesState>()(
  persist(
    (set) => ({
      sources: DEFAULT_SOURCES,
      addMockSource: (kind, name) => {
        const id = `mock-${kind}-${Date.now().toString(36)}`;
        set((state) => ({
          sources: [
            ...state.sources,
            { id, kind, backend: 'mock', name, enabled: true, builtIn: false },
          ],
        }));
        return id;
      },
      addStressSource: (name) => {
        const id = `mock-stress-${Date.now().toString(36)}`;
        set((state) => ({
          sources: [
            ...state.sources,
            { id, kind: 'server', backend: 'mock', name, enabled: true, builtIn: false, stress: true },
          ],
        }));
        return id;
      },
      addServerSource: (name) => {
        const id = `server-${Date.now().toString(36)}`;
        set((state) => ({
          sources: [...state.sources, { id, kind: 'server', backend: 'real', name, enabled: true, builtIn: false }],
        }));
        return id;
      },
      removeSource: (id) => {
        disposeProvider(id);
        set((state) => ({
          sources: state.sources.filter((source) => source.id !== id || source.id === 'local' || source.id === VAULT_SOURCE_ID),
        }));
      },
      setSourceEnabled: (id, enabled) =>
        set((state) => ({
          sources: state.sources.map((source) =>
            source.id === id ? { ...source, enabled } : source,
          ),
        })),
      renameSource: (id, name) =>
        set((state) => ({
          sources: state.sources.map((source) =>
            source.id === id ? { ...source, name: name.trim() || undefined } : source,
          ),
        })),
      resetSources: () => {
        set((state) => {
          state.sources.forEach((source) => disposeProvider(source.id));
          return { sources: DEFAULT_SOURCES };
        });
      },
    }),
    {
      name: 'meyou-sources',
      storage: createJSONStorage(() => AsyncStorage),
      version: 4,
      // v2 (U1): the first Google Drive code was removed: drop its saved sources.
      // v3: Google Drive is back as one built-in source (account kept in `meyou-drive-account`).
      // v4: the private vault is a built-in source.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as { sources?: SourceConfig[] };
        let sources = state.sources ?? DEFAULT_SOURCES;
        if (version < 2) sources = sources.filter((s) => (s.kind as string) !== 'drive');
        if (!sources.some((s) => s.id === DRIVE_SOURCE_ID)) sources = [...sources, DRIVE_SOURCE];
        if (!sources.some((s) => s.id === VAULT_SOURCE_ID)) sources = [...sources, VAULT_SOURCE];
        return { ...state, sources: sources.length ? sources : DEFAULT_SOURCES };
      },
    },
  ),
);
