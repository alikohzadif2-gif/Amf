import { isPhoneKind, type StorageItem, type StorageProvider } from '../storage/types';
import { issueFromError, type LoadIssue } from './load-issue';
import { dedupeKey, mergeInto, type LibraryEntry } from './merge';
import { isHiddenFolderName, refId } from './hidden-folders';

/** Keys located in any folder named `share`; used to suppress stale album/tag snapshots too. */
export const shareExcludedKeys = new Set<string>();

const PAGE = 500;

/**
 * Walks every folder of the given providers (metadata only, nothing is
 * downloaded) and returns one merged list of all files. Used by categories,
 * auto albums, favourites, tags and search.
 */
export async function indexProviders(
  providers: StorageProvider[],
  onProgress: (count: number) => void,
  isCancelled: () => boolean = () => false,
  onIssue: (sourceId: string, issue: LoadIssue) => void = () => {},
  /** Filled with the `refId` of every file found inside a Shared/Snaps folder (those files stay in the result). */
  hiddenRefs: Set<string> = new Set(),
): Promise<LibraryEntry[]> {
  const map = new Map<string, LibraryEntry>();
  shareExcludedKeys.clear();
  const counts = new Map<string, number>();
  const report = () => {
    let sum = 0;
    for (const n of counts.values()) sum += n;
    onProgress(sum);
  };

  await Promise.all(
    providers.map(async (provider) => {
      // Direct (the vault) is the main library now: its files show in Explore, search, tags and albums like any other. Only folders named Shared/Snaps stay hidden.
      const queue: { parent: string | null; excluded: boolean; hidden: boolean }[] = [{ parent: null, excluded: false, hidden: false }];
      while (queue.length > 0 && !isCancelled()) {
        const { parent, excluded, hidden } = queue.shift()!;
        let cursor: string | undefined;
        do {
          let items: StorageItem[] = [];
          try {
            const page = await provider.list(parent, { cursor, limit: PAGE });
            items = page.items;
            cursor = page.nextCursor;
          } catch (error) {
            cursor = undefined;
            if (!isPhoneKind(provider.kind)) onIssue(provider.id, issueFromError(error));
          }
          const files: StorageItem[] = [];
          for (const item of items) {
            if (item.type === 'dir') {
              // Traverse share only to learn its keys; never merge its contents into the archive index.
              queue.push({
                parent: item.id,
                excluded: excluded || item.name.trim().toLocaleLowerCase() === 'share',
                hidden: hidden || isHiddenFolderName(item.name),
              });
            } else if (excluded) {
              shareExcludedKeys.add(dedupeKey(item));
            } else {
              if (hidden) hiddenRefs.add(refId(provider.id, item.id));
              files.push(item);
            }
          }
          mergeInto(map, provider.id, files);
          counts.set(provider.id, (counts.get(provider.id) ?? 0) + files.length + (excluded ? items.length : 0));
          report();
        } while (cursor && !isCancelled());
      }
    }),
  );
  return [...map.values()];
}
