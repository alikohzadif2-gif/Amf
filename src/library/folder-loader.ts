import { isPhoneKind, type ListResult, type StorageProvider } from '../storage/types';
import {
  compareEntries,
  mergeInto,
  type LibraryEntry,
  type SortMode,
  type SourceRef,
} from './merge';
import { issueFromError, worstIssue, type LoadIssue } from './load-issue';

const PAGE = 120;

type Cursor = { provider: StorageProvider; parentId: string | null; next?: string; done: boolean };

/**
 * Pages through one merged folder: every source that has the folder is listed
 * page by page, and the pages are merged as they arrive (the grid stays light
 * even when a folder holds thousands of files).
 */
export class FolderLoader {
  private map = new Map<string, LibraryEntry>();
  private cursors: Cursor[];
  private busy: Promise<boolean> | null = null;
  failed = 0;
  private readonly issues = new Map<string, LoadIssue>();

  /** The most useful reason a source failed (null when every page loaded). */
  get issue(): LoadIssue | null {
    return worstIssue(this.issues.values());
  }

  /** refs = null loads the roots of every provider. */
  constructor(providers: StorageProvider[], refs: SourceRef[] | null) {
    this.cursors = providers.flatMap((provider): Cursor[] => {
      if (refs === null) return [{ provider, parentId: null, done: false }];
      const mine = refs.filter((ref) => ref.sourceId === provider.id);
      return mine.map((ref) => ({ provider, parentId: ref.itemId, done: false }));
    });
  }

  get hasMore(): boolean {
    return this.cursors.some((cursor) => !cursor.done);
  }

  /** Loads the next page of every unfinished source. Resolves to hasMore. */
  loadMore(): Promise<boolean> {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      await Promise.all(
        this.cursors
          .filter((cursor) => !cursor.done)
          .map(async (cursor) => {
            try {
              const page: ListResult = await cursor.provider.list(cursor.parentId, {
                cursor: cursor.next,
                limit: PAGE,
              });
              mergeInto(this.map, cursor.provider.id, page.items);
              cursor.next = page.nextCursor;
              if (!page.nextCursor) cursor.done = true;
            } catch (error) {
              cursor.done = true;
              this.failed += 1;
              // phone folders never fail like this; a remote source (server or Google Drive) reports why
              if (!isPhoneKind(cursor.provider.kind)) this.issues.set(cursor.provider.id, issueFromError(error));
            }
          }),
      );
      this.busy = null;
      return this.hasMore;
    })();
    return this.busy;
  }

  entries(sort: SortMode = 'name'): LibraryEntry[] {
    return [...this.map.values()].sort((a, b) => compareEntries(a, b, sort));
  }
}
