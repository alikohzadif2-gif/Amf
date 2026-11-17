/**
 * Central place for direction helpers used by the UI.
 * Screen and overlay roots set `direction`; children use `row` so Yoga mirrors each row exactly once.
 */
export function rowOf(_isRTL: boolean): 'row' {
  return 'row';
}

export function alignOf(isRTL: boolean): 'left' | 'right' {
  return isRTL ? 'right' : 'left';
}

/** Keep wheel rows tall enough for scaled text while showing fewer rows at large accessibility sizes. */
export function wheelLayout(fontScale: number): { itemHeight: number; visibleRows: number } {
  const scale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
  const targetRows = Math.floor(7 / scale);
  const visibleRows = Math.max(3, targetRows % 2 === 0 ? targetRows - 1 : targetRows);
  return {
    itemHeight: Math.ceil(40 * scale + 28 * (scale - 1)),
    visibleRows,
  };
}
