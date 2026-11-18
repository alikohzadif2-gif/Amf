import { useColorScheme } from 'react-native';
import colors, {
  accentColors,
  accentPressedColors,
  darken,
  defaultAccent,
  withAlpha,
  type AccentName,
} from '@/constants/colors';
import { useSettingsStore } from '@/src/state/settings-store';

/**
 * Returns the design tokens for the active scheme (light / dark / auto = system) and accent.
 *
 * The palette keys are listed in constants/colors.ts. On top of them this hook adds the
 * accent-dependent tokens: `primary` (= `accent` = `tint`), `primaryPressed`, `fabGlow`,
 * `inputFocusBorder`, plus `isDark` and the scheme-independent `radius`.
 */
export function useColors() {
  const systemScheme = useColorScheme();
  const selectedTheme = useSettingsStore((state) => state.theme);
  const selectedAccent = useSettingsStore((state) => state.accent);
  const scheme = selectedTheme === 'auto' ? systemScheme : selectedTheme;
  const isDark = scheme === 'dark';
  const palette = isDark ? colors.dark : colors.light;
  const name: AccentName = selectedAccent in accentColors ? selectedAccent : defaultAccent;
  const primary = accentColors[name];

  return {
    ...palette,
    accent: primary,
    primary,
    tint: primary,
    primaryPressed: accentPressedColors[name] ?? darken(primary, 0.9),
    /** Soft glow colour (35%) for the FAB and similar. */
    fabGlow: withAlpha(primary, 0.35),
    /** Border of a focused input (40%). */
    inputFocusBorder: withAlpha(primary, 0.4),
    isDark,
    radius: colors.radius,
  };
}

export type AppColors = ReturnType<typeof useColors>;
