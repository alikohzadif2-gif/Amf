/**
 * Colour tokens (UI_PHASES.md section 5.1, sampled from the Zeydi reference screenshots).
 * Dark = navy (the look of the references); light is derived from the same hues.
 * Both palettes have exactly the same keys (scripts/test-theme.mjs checks it).
 * Screens read them through `useColors()` — never hard-code a hex in a screen or shared component.
 */
export type AccentName = 'coral' | 'teal' | 'amber' | 'blue' | 'green' | 'violet' | 'slate';

export const accentColors: Record<AccentName, string> = {
  coral: '#FF6B6B',
  teal: '#4D887A',
  amber: '#B7772E',
  blue: '#537EAA',
  green: '#5F875F',
  violet: '#7C6E9A',
  slate: '#677983',
};

/** Hover/pressed shade of an accent. Coral is the sampled value; the others are darkened 10%. */
export const accentPressedColors: Partial<Record<AccentName, string>> = { coral: '#FF5353' };

const HEX6 = /^#([0-9a-f]{6})$/i;

/** `#RRGGBB` + alpha 0..1 -> `#RRGGBBAA`. Anything that is not a 6-digit hex is returned unchanged. */
export function withAlpha(hex: string, alpha: number): string {
  if (!HEX6.test(hex)) return hex;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Multiplies the RGB channels by `factor` (0.9 = 10% darker). */
export function darken(hex: string, factor: number): string {
  const m = HEX6.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((n >> shift) & 255) * factor)))
      .toString(16)
      .padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`.toUpperCase();
}

export const defaultAccent: AccentName = 'coral';

const colors = {
  light: {
    text: '#0B1626',
    tint: accentColors.coral,
    background: '#F6F8FB',
    foreground: '#0B1626',
    card: '#FFFFFF',
    cardForeground: '#0B1626',
    primary: accentColors.coral,
    primaryForeground: '#FFFFFF',
    primaryPressed: '#FF5353',
    secondary: '#EDF1F7',
    secondaryForeground: '#1D2B40',
    muted: '#EDF1F7',
    mutedForeground: '#5F6B7D',
    accent: '#FFE9E9',
    accentForeground: '#0B1626',
    destructive: '#D64545',
    destructiveForeground: '#FFFFFF',
    /** Success text / tinted box ("Connected"). Never the accent: coral reads as an error. */
    success: '#1F8A5B',
    border: '#E3E8F0',
    /** Filled input / search field. */
    input: '#EDF1F7',
    /** Bottom sheet surface. */
    sheet: '#FFFFFF',
    /** Floating tab bar. */
    navBar: '#FFFFFF',
    /** Icon tile, segmented-control background. */
    raised: '#EDF1F7',
    /** Progress / switch track. */
    track: '#DDE4EE',
    switchOn: '#2196F3',
    /** Selected emoji tile. */
    moodSelected: '#9A28B1',
    /** Tint of the status card (purple, from the selected mood). */
    statusCardTint: '#F3E9F7',
    /** Selected filter chip (R4): dark fill in the light theme. */
    chipSelected: '#0B1626',
    chipSelectedForeground: '#FFFFFF',
    /** Dim layer behind sheets and dialogs. */
    scrim: '#00000066',
  },
  dark: {
    text: '#F4F7FB',
    tint: accentColors.coral,
    background: '#040B15',
    foreground: '#F4F7FB',
    card: '#112240',
    cardForeground: '#F4F7FB',
    primary: accentColors.coral,
    primaryForeground: '#FFFFFF',
    primaryPressed: '#FF5353',
    secondary: '#1B3156',
    secondaryForeground: '#E6ECF5',
    muted: '#1B3156',
    mutedForeground: '#8B97A8',
    accent: '#3A2230',
    accentForeground: '#F4F7FB',
    destructive: '#FF5C70',
    destructiveForeground: '#FFFFFF',
    success: '#4CC38A',
    border: '#1B3156',
    input: '#112240',
    sheet: '#0A1930',
    navBar: '#0D1C33',
    raised: '#1B3156',
    track: '#223555',
    switchOn: '#2196F3',
    moodSelected: '#9A28B1',
    statusCardTint: '#261C35',
    chipSelected: '#F4F7FB',
    chipSelectedForeground: '#040B15',
    scrim: '#000000AA',
  },
  radius: 18,
};

export default colors;
