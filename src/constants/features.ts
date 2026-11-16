/**
 * Feature flags (UI_PHASES.md section 4, SERVER_PHASES.md).
 * false = the feature's UI is unreachable and nothing of it runs; the code stays compiled and tested.
 * Re-enable later: flip the flag, then re-test (see the re-enable guide in docs/HANDOFF.md).
 *
 * Server track:
 *  - server        S2  Settings > Server connection (add by QR / link / URL+token, test, remove). ON.
 *  - serverLibrary S4  the server as a Library source (Sources screen, Library lists it). ON.
 *  - serverBackup  S6  Backup & restore settings, the Uploads screen, automatic backup watcher. ON.
 *  - partner       S8  server mailbox pairing and sync. ON.
 */
export const FEATURES = {
  server: true,
  serverLibrary: true,
  serverBackup: true,
  partner: true,
} as const;
