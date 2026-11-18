import { logEvent } from './log';

/**
 * Thumbnail diagnostics: `ensureThumb`, the thumbnail cache and the tiles used to swallow every failure, so a grey tile said nothing. Each
 * failure is now one line in Settings > Diagnostics: `thumb <step> [<extension>] <ErrorName>: <message>`. Never a file name or path.
 * The same failure is written 3 times, then at counts 10, 100, 1000 (a screen of 30 broken tiles must not flood the log).
 */
const counts = new Map<string, number>();

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'none';
};

export function describeFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.replace(/(file|content|https?):\/\/\S+/g, '<uri>').slice(0, 140);
  return typeof error === 'string' ? error.replace(/(file|content|https?):\/\/\S+/g, '<uri>').slice(0, 140) : 'unknown error';
}

/** Steps: `exists`, `decode`, `video-frame`, `resize`, `save`, `copy`, `cache`, `display`, `image-error`, `serve`. */
export function thumbFailure(step: string, ext: string, error: unknown): void {
  const detail = describeFailure(error);
  const key = `${step}|${ext}|${detail.slice(0, 60)}`;
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  if (counts.size > 200) counts.clear();
  if (n <= 3 || n === 10 || n === 100 || n === 1000) logEvent('warn', `thumb ${step} [${ext}] ${detail}${n > 3 ? ` (x${n})` : ''}`);
}

let okLines = 0;
/** The first few successes, so a log with failures also shows what works (sizes only). */
export function thumbOk(ext: string, bytes: number, ms: number): void {
  if (okLines >= 5) return;
  okLines += 1;
  logEvent('info', `thumb ok [${ext}] ${Math.round(bytes / 1024)} KB in ${ms} ms`);
}
