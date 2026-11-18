// Expo config plugin: asks Android for the highest refresh rate the screen offers (90/120 Hz) instead of the default 60 Hz.
// Many phones keep ordinary apps at 60 Hz unless the app picks a display mode itself. Same resolution only, so nothing changes visually.
// It only edits MainActivity.kt during `expo prebuild`; if the template ever differs, it prints a warning and leaves the file alone.
const { withMainActivity } = require('expo/config-plugins');

const MARKER = 'meyouRequestHighRefreshRate';

const METHOD = `
  /** meYou: pick the display mode with the highest refresh rate at the current resolution (no-op on 60 Hz screens). */
  private fun ${MARKER}() {
    try {
      @Suppress("DEPRECATION")
      val display = windowManager.defaultDisplay
      val current = display.mode
      val best = display.supportedModes
        .filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
        .maxByOrNull { it.refreshRate }
      if (best != null && best.refreshRate > current.refreshRate) {
        val params = window.attributes
        params.preferredDisplayModeId = best.modeId
        window.attributes = params
      }
    } catch (_: Throwable) {
      // never block the app start because of the refresh rate
    }
  }
`;

function patch(src) {
  if (src.includes(MARKER)) return src;
  const call = /(super\.onCreate\([^)]*\)[ \t]*;?)/;
  const end = src.lastIndexOf('}');
  if (!call.test(src) || end < 0) return null;
  const withCall = src.replace(call, `$1\n    ${MARKER}()`);
  const close = withCall.lastIndexOf('}');
  return `${withCall.slice(0, close)}${METHOD}${withCall.slice(close)}`;
}

module.exports = function withHighRefreshRate(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      console.warn('[with-high-refresh-rate] MainActivity is not Kotlin; skipped.');
      return cfg;
    }
    const next = patch(cfg.modResults.contents);
    if (next === null) console.warn('[with-high-refresh-rate] could not find onCreate in MainActivity.kt; skipped.');
    else cfg.modResults.contents = next;
    return cfg;
  });
};
module.exports.patch = patch;
