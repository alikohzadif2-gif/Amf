import { create } from 'zustand';
import type { SourceKind } from '@/src/storage/types';
import type { LibraryEntry } from './merge';

/**
 * Archive "Source": which copy of the library is shown. `phone` (default since stage 7) = only files on this phone, `drive` = only files in the person's Google Drive,
 * `server` = only files on the server, `vault` = only the private vault (files hidden inside the app). A file that exists on both is listed once in each mode, never twice in one view.
 */
export type SourceMode = 'phone' | 'drive' | 'server' | 'vault';
export const SOURCE_MODES: readonly SourceMode[] = ['drive', 'phone', 'server', 'vault'];
export const DEFAULT_SOURCE_MODE: SourceMode = 'phone';

export function sourceKindOf(mode: SourceMode): SourceKind {
  return mode === 'phone' ? 'local' : mode === 'drive' ? 'drive' : mode === 'vault' ? 'vault' : 'server';
}

/** Keeps the files and folders that have at least one copy on the chosen source. */
export function applySourceMode(entries: LibraryEntry[], mode: SourceMode, kinds: Record<string, SourceKind>): LibraryEntry[] {
  const kind = sourceKindOf(mode);
  return entries.filter((entry) => entry.refs.some((ref) => kinds[ref.sourceId] === kind));
}

/** Active source of the open Archive. Reset to the default (this phone) each time the Archive opens. */
export const useSourceMode = create<{ mode: SourceMode; set: (mode: SourceMode) => void }>((set) => ({
  mode: DEFAULT_SOURCE_MODE,
  set: (mode) => set({ mode }),
}));
