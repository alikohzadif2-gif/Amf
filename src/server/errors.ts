export type ServerErrorKind = 'network' | 'timeout' | 'unauthorized' | 'http' | 'protocol';

/** Failure talking to the file server. `kind` is a code, never UI text. */
export class ServerError extends Error {
  constructor(
    readonly kind: ServerErrorKind,
    readonly status = 0,
    message?: string,
    /** Seconds to wait, only for `429` (from `Retry-After` or the body's `retryAfter`, contract D.7/D.12). */
    readonly retryAfter?: number,
  ) {
    super(message ?? `${kind}${status ? ` ${status}` : ''}`);
    this.name = 'ServerError';
  }
  /** Network-type failures are the ones failover is allowed to skip over. */
  get isUnreachable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || (this.kind === 'http' && this.status >= 502);
  }
}

/** Safe across duplicate module instances (bundlers, test loaders): checks the name, not the class identity. */
export function isServerError(error: unknown): error is ServerError {
  return error instanceof ServerError || (error instanceof Error && error.name === 'ServerError' && 'kind' in error);
}
