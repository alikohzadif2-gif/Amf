/** Why a Google Drive request failed (code only; UI text lives in i18n). */
export type DriveErrorKind =
  | 'unauthorized' // no account, expired/revoked token, or Google answered 401
  | 'forbidden' // 403 without a quota/rate reason (scope or sharing)
  | 'quota' // Drive storage full or API rate limit
  | 'not-found'
  | 'network'
  | 'unsupported' // the sign-in module is not part of this build (Expo Go)
  | 'cancelled' // the person closed the Google sign-in window
  | 'http'
  | 'protocol';

export class DriveError extends Error {
  constructor(
    readonly kind: DriveErrorKind,
    readonly status = 0,
    message?: string,
  ) {
    super(message ?? `${kind}${status ? ` (${status})` : ''}`);
    this.name = 'DriveError';
  }

  get isUnreachable(): boolean {
    return this.kind === 'network';
  }
}

/** `name` is checked too, so a copy of this module loaded twice (tests, fast refresh) still matches. */
export function isDriveError(error: unknown): error is DriveError {
  return error instanceof DriveError || (error instanceof Error && error.name === 'DriveError');
}
