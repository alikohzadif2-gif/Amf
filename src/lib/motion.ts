/**
 * Shared motion tokens for the soft, springy feel of the Status screen (tiles, chips, card, FAB, toast).
 * Springs are damped enough to settle without a visible wobble; durations are short so taps never feel slow.
 */
export const TILE_SPRING = { damping: 18, stiffness: 420, mass: 0.6 } as const;
export const SOFT_SPRING = { damping: 11, stiffness: 260, mass: 0.7 } as const;
export const GENTLE_SPRING = { damping: 20, stiffness: 180, mass: 0.9 } as const;
export const FADE_MS = 260;
export const CARD_COLOR_MS = 520;
/** Floating mood emoji on Home: how far it drifts up (px) and how long one way takes (ms). */
export const FLOAT_DISTANCE = 6;
export const FLOAT_HALF_MS = 1700;
