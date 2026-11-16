import { isDriveError } from '../drive/errors';
import { isServerError } from '../server/errors';
import { isPhoneKind, type StorageProvider } from '../storage/types';

/** Why a source could not deliver its files (code only; UI text lives in i18n). */
export type LoadIssue = 'unauthorized' | 'busy' | 'unreachable' | 'missing' | 'error';

/** Worst first: when several sources fail, the one the person can act on is shown. */
const PRIORITY: LoadIssue[] = ['unauthorized', 'busy', 'unreachable', 'missing', 'error'];

export function issueFromError(error: unknown): LoadIssue {
  if (isDriveError(error)) {
    if (error.kind === 'unauthorized' || error.kind === 'cancelled' || error.kind === 'forbidden') return 'unauthorized';
    if (error.kind === 'quota') return 'busy';
    if (error.kind === 'network' || error.kind === 'unsupported') return 'unreachable';
    if (error.kind === 'not-found') return 'missing';
    return 'error';
  }
  if (isServerError(error)) {
    if (error.kind === 'unauthorized') return 'unauthorized';
    // 429 (`rate_limited` / `locked_out`): the server is fine and the token is kept; it only asks to wait.
    if (error.kind === 'http' && error.status === 429) return 'busy';
    if (error.isUnreachable) return 'unreachable';
    if (error.kind === 'http' && error.status === 404) return 'missing';
  }
  return 'error';
}

export function worstIssue(issues: Iterable<LoadIssue>): LoadIssue | null {
  const seen = new Set(issues);
  return PRIORITY.find((issue) => seen.has(issue)) ?? null;
}

/** i18n keys for a folder / list notice (literal types, so `t()` accepts them). */
export const ISSUE_TEXT = {
  unauthorized: 'libIssueUnauthorized',
  busy: 'connBusy',
  unreachable: 'libIssueUnreachable',
  missing: 'libIssueMissing',
  error: 'libIssueError',
} as const;

/** i18n keys for one item that failed to open (a missing file has its own wording). */
export const ITEM_ISSUE_TEXT = {
  unauthorized: 'libIssueUnauthorized',
  busy: 'connBusy',
  unreachable: 'libIssueUnreachable',
  missing: 'viewerIssueMissing',
  error: 'viewerLoadFailed',
} as const;

/**
 * An image or video failed to load and the player/image view gave no reason (they do not
 * expose the HTTP status). Ask the server itself: wrong token, unreachable, or the server
 * is fine, so the file is gone or not displayable. Phone files keep the generic message.
 */
export async function diagnoseSource(provider: StorageProvider | null): Promise<LoadIssue> {
  if (!provider || isPhoneKind(provider.kind)) return 'error';
  try {
    const result = await provider.test();
    if (result.code === 'unauthorized') return 'unauthorized';
    if (result.busy) return 'busy';
    if (result.code === 'unavailable') return 'unreachable';
    if (result.ok) return 'missing';
  } catch {
    // fall through
  }
  return 'error';
}
