/** Private copies of story media in the app's documents folder (not added to the Library). */
import { Directory, File, Paths } from 'expo-file-system';
import { STORY_FOLDER, type StoryType } from './story-logic';

export const STORY_PHOTO_MAX_WIDTH = 1440;

/** Copies the picked / captured media into the stories folder (photos are re-encoded once: smaller, no EXIF/GPS). Returns the stored uri. */
export async function saveStoryMedia(sourceUri: string, type: StoryType, id: string, width?: number): Promise<string> {
  const dir = new Directory(Paths.document, STORY_FOLDER);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  if (type === 'photo') {
    const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
    let context = ImageManipulator.manipulate(sourceUri);
    if ((width ?? STORY_PHOTO_MAX_WIDTH + 1) > STORY_PHOTO_MAX_WIDTH) context = context.resize({ width: STORY_PHOTO_MAX_WIDTH });
    const saved = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    const target = new File(dir, `${id}.jpg`);
    new File(saved.uri).copy(target);
    return target.uri;
  }
  const ext = (sourceUri.split('?')[0].split('.').pop() ?? 'mp4').toLowerCase();
  const target = new File(dir, `${id}.${/^[a-z0-9]{2,4}$/.test(ext) ? ext : 'mp4'}`);
  new File(sourceUri).copy(target);
  return target.uri;
}

/** Deletes story files that are no longer needed. Never throws. */
export function discardStoryFiles(uris: string[]): void {
  for (const uri of uris) {
    if (!uri.startsWith('file:')) continue; // a partner story is a server path: nothing on this phone to delete
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // a leftover file is harmless
    }
  }
}
