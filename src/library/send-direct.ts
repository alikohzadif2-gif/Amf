import { getRandomBytes } from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { resolveMediaFile } from '@/src/diary/diary-media';
import { sendChatMedia, shareFileResult } from '@/src/partner/manage';
import { serverIdOf } from './entry-link';
import type { LibraryEntry } from './merge';

export type DirectResult = 'sent' | 'not-paired' | 'failed' | 'unsupported';

/**
 * "Send to Direct": puts one photo/video of the library into the chat with the partner.
 * A file that is on the server is sent as a pointer (both phones read the same server, nothing is uploaded again);
 * any other file (on the phone, or only in Google Drive) is first made readable on the phone (a Drive file is downloaded to a
 * temporary copy that is deleted afterwards) and uploaded to `Shared/<id>/` like a story photo.
 */
export async function sendEntryToDirect(db: SQLiteDatabase, entry: LibraryEntry): Promise<DirectResult> {
  const type = entry.item.type;
  if (type !== 'image' && type !== 'video') return 'unsupported';
  const mediaType = type === 'video' ? 'video' : 'photo';
  const serverId = serverIdOf(entry);
  if (serverId) return sendChatMedia(db, { item: serverId, mediaType }) as Promise<DirectResult>;

  const file = await resolveMediaFile(entry.key);
  if (!file) return 'failed';
  try {
    const id = `d${Array.from(getRandomBytes(6), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const shared = await shareFileResult(id, entry.item.name, file.uri);
    if (!shared.ok) return shared.reason === 'connection' ? 'not-paired' : 'failed';
    return sendChatMedia(db, { media: shared.path, mediaType }) as Promise<DirectResult>;
  } finally {
    file.release();
  }
}
