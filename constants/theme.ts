/**
 * Non-colour design tokens (UI_PHASES.md section 5.1). Colours live in constants/colors.ts.
 * Use `rowOf(isRTL)` and logical margins (marginStart/End) for direction — never left/right.
 */
export const radii = {
  /** Fully round (pills, FAB, avatars). */
  pill: 999,
  /** Big cards and hero cards (24-32). */
  card: 24,
  cardLarge: 32,
  /** Icon / emoji tiles (18-20). */
  tile: 18,
  /** Top corners of a bottom sheet. */
  sheetTop: 28,
  /** Floating tab bar. */
  navBar: 28,
  /** Glass card on the welcome slides. */
  glass: 28,
  /** Small controls (inputs, small buttons). */
  control: 14,
} as const;

/** 4-pt scale. */
export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, huge: 32 } as const;

/** Layout constants shared by the shell screens. */
export const layout = {
  /** Side gutter of screens. */
  screenPadding: 20,
  /** Floating tab bar: distance from the screen edges and above the system bar. */
  navBarMargin: 16,
  /** Gap between the floating tab bar and the system navigation bar (added to the bottom inset). */
  navBarBottomGap: 10,
  navBarHeight: 72,
  fabSize: 56,
} as const;

/** App-wide display-size presets. Android's native font scaling remains enabled on top of these values. */
export type DisplaySize = 'small' | 'normal' | 'large' | 'extraLarge';

const displayScales: Record<DisplaySize, { text: number; card: number }> = {
  small: { text: 0.88, card: 0.9 },
  normal: { text: 1, card: 1 },
  large: { text: 1.12, card: 1.1 },
  extraLarge: { text: 1.24, card: 1.2 },
};

export function textScaleForDisplay(size: DisplaySize): number {
  return displayScales[size]?.text ?? displayScales.normal.text;
}

export function cardScaleForDisplay(size: DisplaySize): number {
  return displayScales[size]?.card ?? displayScales.normal.card;
}

/** Scale only the named numeric style properties, leaving colors and layout relationships intact. */
export function scaleNumericStyleValues<T extends Record<string, unknown>>(
  style: T,
  keys: readonly string[],
  scale: number,
): T {
  if (scale === 1) return style;
  const result: Record<string, unknown> = { ...style };
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'number' && value !== 0) {
      result[key] = Math.round(value * scale * 100) / 100;
    }
  }
  return result as T;
}

/** Allow wrapped tab labels to grow the floating bar without covering screen content at large font scales. */
export function navBarHeightForFontScale(fontScale: number): number {
  const scale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
  return Math.max(layout.navBarHeight, Math.ceil(28 + 44 * scale));
}

/** Font sizes and weights (family comes from `fontFamilyFor(language, weight)`). */
export const typography = {
  title: { fontSize: 32, weight: 'bold' },
  screenTitle: { fontSize: 22, weight: 'semibold' },
  cardTitle: { fontSize: 20, weight: 'bold' },
  body: { fontSize: 16, weight: 'regular' },
  bodySmall: { fontSize: 14, weight: 'regular' },
  button: { fontSize: 16, weight: 'semibold' },
  /** Section label: 12-13, uppercase + letter spacing for Latin text only (never for Persian). */
  sectionLabel: { fontSize: 12.5, weight: 'semibold', letterSpacing: 1.1 },
  caption: { fontSize: 12, weight: 'regular' },
} as const;

/** Glow behind the camera FAB and selected mood tiles. */
export const glow = { radius: 18, opacity: 0.35 } as const;
