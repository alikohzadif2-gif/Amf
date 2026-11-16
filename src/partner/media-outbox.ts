import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { PARTNER_MEDIA_FOLDER } from './media-store';
import type { Outbox, OutboxEntry } from './media-send';

/**
 * Previews that wait for Wi-Fi (stage 4). One JSON file per shared photo in the app's private `meyou-partner-media/outbox/`
 * (excluded from backup, deleted on unpairing together with the folder). The index is AsyncStorage: a list of ref -> file name.
 */
const INDEX_KEY = 'meyou-media-outbox-v1';

function directory(): Directory {
  const dir = new Directory(Paths.document, `${PARTNER_MEDIA_FOLDER}/outbox`);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

async function readIndex(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(INDEX_KEY)) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const writeIndex = (index: Record<string, string>) => AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index));
const nameFor = (ref: string) => `${Array.from(ref).reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7).toString(16)}-${ref.length.toString(16)}.json`;

export const fileOutbox: Outbox = {
  async put(entry: OutboxEntry) {
    const name = nameFor(entry.ref);
    const file = new File(directory(), name);
    file.create({ overwrite: true });
    file.write(JSON.stringify(entry));
    const index = await readIndex();
    index[entry.ref] = name;
    await writeIndex(index);
  },
  async list() {
    const index = await readIndex();
    const out: OutboxEntry[] = [];
    for (const [ref, name] of Object.entries(index)) {
      try {
        const file = new File(directory(), name);
        if (!file.exists) continue;
        out.push(JSON.parse(file.textSync()) as OutboxEntry);
      } catch {
        // an unreadable entry is skipped (it is replaced when the same photo is shared again)
      }
    }
    return out;
  },
  async remove(ref: string) {
    const index = await readIndex();
    const name = index[ref];
    if (name) {
      try {
        new File(directory(), name).delete();
      } catch {
        // already gone
      }
      delete index[ref];
      await writeIndex(index);
    }
  },
};

/** After unpairing the folder is gone; forget the index too. */
export const resetOutboxIndex = () => AsyncStorage.removeItem(INDEX_KEY);
