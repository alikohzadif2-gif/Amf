/** Explore: random photos/videos in the Instagram mosaic. Pure helpers (no React) so they run in the test suite. */

/** Photos and videos only, no folders or other files. */
export const isMedia = <T extends { item: { type: string } }>(entries: T[]): T[] =>
  entries.filter((e) => e.item.type === 'image' || e.item.type === 'video');

/** A new random order every time (Fisher-Yates); `rand` is injectable for tests. */
export function shuffle<T>(list: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * One mosaic block = 6 items over 3 rows of a 3-column grid: a big tile (2x2) with two small ones stacked beside it,
 * then a row of three small ones. The big tile alternates left/right from block to block.
 */
export type Block<T> = { key: string; bigRight: boolean; big: T; side: T[]; row: T[] };

export function toBlocks<T>(items: readonly T[], keyOf: (item: T) => string): Block<T>[] {
  const blocks: Block<T>[] = [];
  for (let i = 0; i < items.length; i += 6) {
    const part = items.slice(i, i + 6);
    blocks.push({
      key: `${blocks.length}-${keyOf(part[0]!)}`,
      bigRight: blocks.length % 2 === 1,
      big: part[0]!,
      side: part.slice(1, 3),
      row: part.slice(3, 6),
    });
  }
  return blocks;
}
