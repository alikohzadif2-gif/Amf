import { create } from 'zustand';
import type { LibraryEntry } from './merge';

/**
 * The list the viewer swipes through (kept here so routes need no big params).
 * `grid: true` (memory media) opens a tile grid first; a tap on a tile opens the swipe viewer.
 * A single item never needs a grid, so it opens straight into the swipe viewer.
 * `vertical: true` (Explore) swipes up/down one item per screen like a reel, and starts videos by itself.
 */
export const useViewerStore = create<{
  entries: LibraryEntry[];
  index: number;
  grid: boolean;
  vertical: boolean;
  open: (entries: LibraryEntry[], index: number, options?: { grid?: boolean; vertical?: boolean }) => void;
}>()((set) => ({
  entries: [],
  index: 0,
  grid: false,
  vertical: false,
  open: (entries, index, options) => set({ entries, index, grid: !!options?.grid && entries.length > 1, vertical: !!options?.vertical }),
}));
