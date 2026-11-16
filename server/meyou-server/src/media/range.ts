// HTTP Range parsing (RFC 9110): a single byte range. Returns:
//   { kind: 'none' }                      no Range header, or one we ignore (multi-range, other unit)
//   { kind: 'range', start, end }         inclusive byte positions, already clamped to the file
//   { kind: 'invalid' }                   malformed or not satisfiable -> 416
export type RangeResult = { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'invalid' };

export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'none' };
  const h = header.trim();
  const eq = h.indexOf('=');
  if (eq < 0) return { kind: 'invalid' };
  if (h.slice(0, eq).trim().toLowerCase() !== 'bytes') return { kind: 'none' };
  const spec = h.slice(eq + 1).trim();
  if (spec.includes(',')) return { kind: 'none' }; // multi-range: answer with the whole file
  const m = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'invalid' };
  if (size === 0) return { kind: 'invalid' };
  if (m[1] === '') {
    // suffix: the last N bytes
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n === 0) return { kind: 'invalid' };
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  let end = m[2] === '' ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'invalid' };
  if (start >= size || end < start) return { kind: 'invalid' };
  if (end >= size) end = size - 1;
  return { kind: 'range', start, end };
}
