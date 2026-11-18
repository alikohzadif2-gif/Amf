/**
 * Pure text helpers for the shared UI kit (components/ui). Kept free of React so scripts/test-theme.mjs can test them.
 */

/** Section labels are UPPERCASE with letter spacing for Latin text only — never for Persian (it has no case and spacing breaks joining). */
export function sectionLabelText(label: string, language: string): string {
  return language === 'fa' ? label : label.toUpperCase();
}

export function sectionLabelSpacing(language: string, spacing: number): number {
  return language === 'fa' ? 0 : spacing;
}

/** Progress value for ProgressBar: clamps to 0..1 and treats NaN as 0. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Bottom sheet: a drag down closes it when it went far enough (30% of its height) or fast enough. */
export function shouldDismissSheet(dragY: number, velocityY: number, sheetHeight: number): boolean {
  if (dragY <= 0) return false;
  return dragY > sheetHeight * 0.3 || velocityY > 0.9;
}
