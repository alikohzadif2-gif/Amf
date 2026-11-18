/**
 * Shared gallery, stage 2: the bridge between the add engine (`src/vault/import.ts`) and the sender (`src/partner/manage.ts`), so the
 * engine does not import the partner code. `manage.ts` registers the real flusher; until then (and in tests) a request does nothing.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { createFlushGate } from './gallery-logic';

type Flusher = (db: SQLiteDatabase) => Promise<unknown>;
let flusher: Flusher | null = null;
const gate = createFlushGate();

export const registerGalleryFlusher = (fn: Flusher): void => {
  flusher = fn;
};

/** One more file landed: pushes the manifest when the gate says so (first file, every 50 files or 3 s). Never throws, never waits. */
export function galleryFileAdded(db: SQLiteDatabase): void {
  if (gate.note()) void flusher?.(db).catch(() => undefined);
}

/** A job ended or the app started: pushes what is left now. Never throws. */
export async function galleryFlushNow(db: SQLiteDatabase): Promise<void> {
  gate.reset();
  try {
    await flusher?.(db);
  } catch {
    // retried at the next push; the journal still has the rows
  }
}
