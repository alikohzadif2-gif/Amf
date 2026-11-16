# meYou — Phases (v3, simplified 2026-10-15)

Legend: `[x]` done · `[ ]` not started.
Rules for every phase:
- **Reuse existing software and libraries. Do not invent new engines.** At the start of a phase, check the official docs of the named tool (web search), then wire it in with the least code.
- Extend finished code, do not restructure. No unrequested features. Delete Settings rows for cut features (no badges).
- Verify cheaply: `pnpm typecheck`, `pnpm test`, `npx expo export --platform android`. No long test loops.
- Every string in fa + en. Dates stored as UTC Gregorian only.
- End: update HANDOFF, tick the phase, append to the Decisions log, create `meyou-src.zip`.

## [x] Phase 1 — Foundation
## [x] Phase 2 — Settings framework + provider layer
## [x] Phase 3 — Library & media loading
## [x] Phase 4 — File server client
## [x] Phase 5 — Google Drive provider
(Private chat is removed: no phase, no tab, no settings.)

## [x] Phase 6 — Sync (rclone does the work)
**Ready-made**: rclone (`copy` mode, rc API). **Scope**: Folder-mapping screen (pick a Drive folder + a server folder, save mapping). "Sync now" starts an rclone `sync/copy` job (`_async`), polls `job/status`, shows progress + log. "Integrity check" = rclone `check` job. Ship `server/rclone/` with a ready compose/systemd file and a cron example (schedule lives on the server). Fixed policy: copy-only, never delete.
**NOT built**: phone diff engine, SQLite sync tables, conflict/deletion pickers, background tasks, queue backoff, bandwidth limit, engine selector.
**Done when**: against a local `rclone rcd` (or fake) a job starts, finishes and its log shows in the app; no delete anywhere.

## [x] Phase 7 — Partner & mood (ntfy does the transport)
**Ready-made**: ntfy (self-hosted or ntfy.sh), `expo-notifications` (local only). **Scope**: pairing screen (show/scan QR `{ntfyUrl, topic}`), publish/subscribe client (~100 lines: fetch + WebSocket), Mood tab (emoji grid, optional text, intensity, history in SQLite), partner profile (name, avatar, birthday), notification toggles (mood, event) + test button. Setup guide page explains installing the ntfy Android app for background alerts.
**NOT built**: custom relay, tweetnacl, FCM, foreground service, quiet hours, sound/vibration prefs.
**Done when**: two instances on one ntfy topic exchange moods; unpair rotates the topic.

## [x] Phase 8 — Dates & Home
**Ready-made**: our existing `src/lib/calendar` (month grids, Jalali). **Scope**: one Event type (date, title, tags, optional yearly repeat, optional Library media) in SQLite; list + month grid; this-week/this-month filter; repeat on the chosen calendar (30 Esfand → last day of month). Home: fixed cards (partner + latest mood, days-together, next 3 events, "on this day"). Events are sent to the partner as ntfy `event` messages.
**NOT built**: Note vs Meetup split, Home layout editor, widgets.
**Done when**: a Jalali and a Gregorian anniversary each show the right countdown.

## [x] Phase 9 — Security & tools
**Ready-made**: `expo-local-authentication`, `expo-screen-capture`, `expo-image-manipulator` (re-encode strips EXIF), `expo-sharing`. **Scope**: app lock (biometric / device credential) + auto-lock timer; block screenshots + hide in recents (one lib); strip GPS/EXIF on upload; Tools: duplicate finder (list of equal-md5 groups from the existing index), storage analyzer (numbers we already compute), diagnostics log (share as text), reset settings.
**NOT built**: custom PIN, bulk rename/move, gallery import, encrypted settings export, partial reset.
**Done when**: each tool runs on mock data; lock engages after the timer.

## [x] Phase 10 — Release
**Ready-made**: EAS Build (cloud) with a `preview` profile `buildType: apk`; GitHub Actions as the alternative. **Scope**: icon + splash, version, `eas.json`, README (build, Google Cloud setup for sign-in, server setup with rclone + file server + ntfy), final QA checklist (fa/en, RTL, both calendars, nothing configured = no crash).
**NOT built**: SSH installer, certificate pinning, dev-client phase.
**Done when**: an installable APK exists, or exact commands are in README.

## [x] Phase 11 — Optional, only after release
**Ready-made**: `react-native-android-widget` (Expo config plugin). **Scope**: one 2x2 (resizable) home-screen widget, "days together" (same number as the Home card), light/dark, tap opens the app. **NOT built**: more widgets, widget settings screen, partner/mood/event widgets.
**Done when**: `pnpm typecheck`, `pnpm test`, `expo export` and `expo prebuild` are green; the widget receiver is in the manifest. Needs a new APK (not Expo Go).
