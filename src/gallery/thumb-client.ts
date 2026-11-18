import { create } from 'zustand';
import { idOfGalleryRef, galleryRef } from './gallery-ref';
import { createThumbScheduler } from './thumb-scheduler';

/**
 * Shared gallery, stage 3 (receiver): the glue between the screen and the scheduler. `manage.ts` registers how a request is posted and how
 * a stored picture is found. A tile re-reads its picture only when ITS file arrived (`stamp[id]`), not on every picture of the partner.
 */
type Hooks = { send: (ids: string[]) => Promise<void>; hasLocal: (ref: string) => Promise<boolean> };
let hooks: Hooks | null = null;
export const registerGalleryThumbHooks = (h: Hooks): void => {
  hooks = h;
};

const known = new Set<string>();
const scheduler = createThumbScheduler({
  send: (ids) => (hooks ? hooks.send(ids) : Promise.reject(new Error('not ready'))),
  has: (id) => known.has(id),
});

export const useGalleryThumbs = create<{ stamp: Record<string, number>; bump: (id: string) => void }>((set) => ({
  stamp: {},
  bump: (id) => set((s) => ({ stamp: { ...s.stamp, [id]: (s.stamp[id] ?? 0) + 1 } })),
}));

let wantSeq = 0;
/** The files on screen now (top to bottom). Files whose picture is already on this phone are skipped before anything is asked. */
export async function galleryWant(items: readonly { id: string; path: string }[]): Promise<void> {
  const mine = (wantSeq += 1);
  for (const item of items) {
    if (known.has(item.id) || !hooks) continue;
    if (await hooks.hasLocal(galleryRef(item.id, item.path)).catch(() => false)) known.add(item.id);
  }
  if (mine !== wantSeq) return; // a newer list replaced this one while the phone was checking
  scheduler.setWanted(items.map((i) => i.id));
}

/** A picture of the partner was stored (`manage.ts` onMedia). Ignores everything that is not a gallery ref. */
export function galleryThumbArrived(ref: string): void {
  const id = idOfGalleryRef(ref);
  if (!id) return;
  known.add(id);
  scheduler.arrived(id);
  useGalleryThumbs.getState().bump(id);
}

export const galleryThumbTick = (): void => scheduler.tick();
export const galleryRetryThumb = (id: string): void => scheduler.retry(id);
export const galleryThumbState = (id: string) => scheduler.state(id);
/** Screen closed, or unpairing: nothing is wanted and nothing is remembered. */
export function galleryThumbReset(): void {
  wantSeq += 1;
  scheduler.reset();
  known.clear();
}
