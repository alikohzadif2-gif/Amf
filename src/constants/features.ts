/**
 * Feature flags (UI_PHASES.md section 4, SERVER_PHASES.md).
 * false = the feature's UI is unreachable and nothing of it runs; the code stays compiled and tested.
 *
 *  - server   Settings > Server connection (add by QR / link / URL+token, test, remove). ON.
 *  - partner  server mailbox pairing and sync. ON.
 */
export const FEATURES = {
  server: true,
  partner: true,
} as const;
