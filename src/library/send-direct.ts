import { getRandomBytes } from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { resolveMediaFile } from '@/src/diary/diary-media';
import { sendChatMedia, shareFileResult } from '@/src/partner/manage';
import type { LibraryEntry } from './merge';

export type DirectResult = 'sent' | 'not-paired' | 'failed' | 'unsupported' | 'no-keys';

/**
 * "Send to Direct": puts one photo/video of the library into the chat with the partner. The file is made readable on the
 * phone, shared as an encrypted picture (thumbnail now, preview on Wi-Fi, original only on request: nothing goes to a server)
 * and the chat message carries its reference. Needs the secure (E2E) pairing.
 */
export async function sendEntryToDirect(db: SQLiteDatabase, entry: LibraryEntry): Promise<DirectResult> {
  const type = entry.item.type;
  if (type !== 'image' && type !== 'video') return 'unsupported';
  const mediaType = type === 'video' ? 'video' : 'photo';
  const file = await resolveMediaFile(entry.key);
  if (!file) return 'failed';
  try {
    const id = `d${Array.from(getRandomBytes(6), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const shared = await shareFileResult(id, entry.item.name, file.uri);
    if (!shared.ok) return shared.reason === 'connection' ? 'not-paired' : shared.reason === 'no-keys' ? 'no-keys' : 'failed';
    return sendChatMedia(db, { media: shared.path, mediaType }) as Promise<DirectResult>;
  } finally {
    file.release();
  }
}
