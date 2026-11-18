import { create } from 'zustand';
import type { SourceKind } from '@/src/storage/types';
import type { LibraryEntry } from './merge';

/**
 * Archive/Explore "Source": since stage 2A-3 there is ONE mode, the Shared gallery. It is made of two sources (stage 5): the vault (what this
 * phone added) and the partner's gallery (what the partner added and this phone loaded or downloaded). The gallery source
 * (LocalProvider, MediaLibrary, `meyou-library`) is gone; files picked from the gallery or camera are copied into the vault.
 * The type and the store stay so every screen keeps one code path.
 */
export type SourceMode = 'vault';
export const SOURCE_MODES: readonly SourceMode[] = ['vault'];
export const DEFAULT_SOURCE_MODE: SourceMode = 'vault';

export function sourceKindsOf(_mode: SourceMode): readonly SourceKind[] {
  return ['vault', 'partner'];
}

/** Keeps the files and folders that have at least one copy in the Shared gallery (the vault or the partner's side). */
export function applySourceMode(entries: LibraryEntry[], mode: SourceMode, kinds: Record<string, SourceKind>): LibraryEntry[] {
  const wanted = sourceKindsOf(mode);
  return entries.filter((entry) => entry.refs.some((ref) => wanted.includes(kinds[ref.sourceId])));
}

/** Active source of the open Archive (always Direct). */
export const useSourceMode = create<{ mode: SourceMode; set: (mode: SourceMode) => void }>((set) => ({
  mode: DEFAULT_SOURCE_MODE,
  set: (mode) => set({ mode }),
}));
