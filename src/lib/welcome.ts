/** Pure helpers of the welcome carousel (no React Native imports; tested in scripts/test-welcome.mjs). */

export type WelcomeSlideId = 'status' | 'events' | 'diary' | 'gallery';

/** Order and top colour of the four slides (UI_PHASES 5.1 welcome gradients: coral, teal, yellow, violet). */
export const WELCOME_SLIDES: { id: WelcomeSlideId; color: string }[] = [
  { id: 'status', color: '#FEA4A4' },
  { id: 'events', color: '#93F2EC' },
  { id: 'diary', color: '#FFD84F' },
  { id: 'gallery', color: '#7163EE' },
];

/**
 * A horizontal list always scrolls from the left. In RTL the first slide must sit at the right,
 * so the list data is reversed: visual index <-> logical index is its own inverse.
 */
export function slideIndex(i: number, count: number, isRTL: boolean): number {
  return isRTL ? count - 1 - i : i;
}

/** Logical slide (0-based) for a scroll offset, clamped. */
export function logicalIndexAt(offsetX: number, width: number, count: number, isRTL: boolean): number {
  if (width <= 0 || count <= 0) return 0;
  const visual = Math.min(count - 1, Math.max(0, Math.round(offsetX / width)));
  return slideIndex(visual, count, isRTL);
}

/** First-run gate: wait for the saved settings, then decide where to go. */
export function welcomeTarget(hydrated: boolean, onboarded: boolean): 'wait' | 'welcome' | 'app' {
  if (!hydrated) return 'wait';
  return onboarded ? 'app' : 'welcome';
}
