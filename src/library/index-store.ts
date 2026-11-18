import { create } from 'zustand';
import { enabledProviders, enabledSignature } from './providers';
import { indexProviders } from './indexer';
import { worstIssue, type LoadIssue } from './load-issue';
import type { LibraryEntry } from './merge';
import { hiddenKeys, refId } from './hidden-folders';

/**
 * What the Archive may show: files inside Shared/Snaps folders are removed (per copy: a file that also exists in a normal
 * folder stays, listed only with its normal copies). `hidden` = keys whose every copy is hidden.
 */
export function splitHidden(entries: LibraryEntry[], hiddenRefs: ReadonlySet<string>): { visible: LibraryEntry[]; hidden: Set<string> } {
  if (hiddenRefs.size === 0) return { visible: entries, hidden: new Set() };
  const visible: LibraryEntry[] = [];
  const hidden = new Set<string>();
  for (const entry of entries) {
    const shown = entry.refs.filter((ref) => !hiddenRefs.has(refId(ref.sourceId, ref.itemId)));
    if (shown.length === entry.refs.length) visible.push(entry);
    else if (shown.length > 0) visible.push({ ...entry, refs: shown });
    else hidden.add(entry.key);
  }
  return { visible, hidden };
}

type IndexState = {
  /** Every file of every source (diary, events and backup look files up here). */
  entries: LibraryEntry[];
  /** `entries` without what lives only in Shared/Snaps folders: the Archive grids, search, tags, albums use this. */
  visible: LibraryEntry[];
  visibleByKey: Map<string, LibraryEntry>;
  byKey: Map<string, LibraryEntry>;
  status: 'idle' | 'indexing' | 'ready';
  count: number;
  signature: string;
  /** Set when a source could not be listed during the last build (e.g. server offline). */
  issue: LoadIssue | null;
  /** Resolves when the index is ready; skips work if sources did not change. */
  build: (force?: boolean) => Promise<void>;
};

let token = 0;

export const useLibraryIndex = create<IndexState>()((set, get) => ({
  entries: [],
  visible: [],
  visibleByKey: new Map(),
  byKey: new Map(),
  status: 'idle',
  count: 0,
  signature: '',
  issue: null,
  build: async (force = false) => {
    const signature = enabledSignature();
    const state = get();
    if (!force && state.status !== 'idle' && state.signature === signature) return;
    token += 1;
    const mine = token;
    set({ status: 'indexing', count: 0, signature, issue: null });
    const issues = new Map<string, LoadIssue>();
    const hiddenRefs = new Set<string>();
    const entries = await indexProviders(
      enabledProviders(),
      (count) => {
        if (mine === token) set({ count });
      },
      () => mine !== token,
      (sourceId, issue) => issues.set(sourceId, issue),
      hiddenRefs,
    );
    if (mine !== token) return;
    const split = splitHidden(entries, hiddenRefs);
    hiddenKeys.clear();
    for (const key of split.hidden) hiddenKeys.add(key);
    set({
      entries,
      visible: split.visible,
      visibleByKey: new Map(split.visible.map((e) => [e.key, e])),
      byKey: new Map(entries.map((e) => [e.key, e])),
      status: 'ready',
      count: entries.length,
      issue: worstIssue(issues.values()),
    });
  },
}));
