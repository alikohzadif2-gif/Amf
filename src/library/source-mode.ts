import { create } from 'zustand';
import type { SourceKind } from '@/src/storage/types';
import type { LibraryEntry } from './merge';

/**
 * Archive/Explore "Source": since stage 2A-3 there is ONE source, Direct (the app's own library = the vault). The gallery source
 * (LocalProvider, MediaLibrary, `meyou-library`) is gone; files picked from the gallery or camera are copied into Direct.
 * The type and the store stay so every screen keeps one code path, and a second source could be added back later.
 */
export type SourceMode = 'vault';
export const SOURCE_MODES: readonly SourceMode[] = ['vault'];
export const DEFAULT_SOURCE_MODE: SourceMode = 'vault';

export function sourceKindOf(_mode: SourceMode): SourceKind {
  return 'vault';
}

/** Keeps the files and folders that have at least one copy in Direct. */
export function applySourceMode(entries: LibraryEntry[], mode: SourceMode, kinds: Record<string, SourceKind>): LibraryEntry[] {
  const kind = sourceKindOf(mode);
  return entries.filter((entry) => entry.refs.some((ref) => kinds[ref.sourceId] === kind));
}

/** Active source of the open Archive (always Direct). */
export const useSourceMode = create<{ mode: SourceMode; set: (mode: SourceMode) => void }>((set) => ({
  mode: DEFAULT_SOURCE_MODE,
  set: (mode) => set({ mode }),
}));
