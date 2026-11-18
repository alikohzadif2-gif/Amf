import type { SourceConfig } from './types';

/** A source the Archive may use: only the enabled ones. */
export function isSourceActive(source: SourceConfig): boolean {
  return source.enabled;
}
