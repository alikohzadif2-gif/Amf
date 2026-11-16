# meYou — Project Brief (permanent source of truth)

Do not rewrite this file. If a decision must change, append it to the "Decisions log" at the bottom.

## 1. What we are building
An **Android-only** app for exactly two people (a couple), built with **React Native + Expo (TypeScript, expo-router)**.
- Fully bilingual: **Persian (fa, RTL)** and **English (en, LTR)**. Every screen complete in both.
- Server-less first: all logic runs inside the app. Optional external pieces, none written by us from scratch: a **file server** (Contract A) with **rclone** next to it for Drive↔server copying, and **ntfy** (existing open-source push/pub-sub, self-hosted or ntfy.sh) as the partner mailbox. See `docs/API_CONTRACT.md`.
- Final deliverable: an APK built in Phase 10 (EAS Build or GitHub Actions). The project is written by Claude directly in a sandbox (no Replit). Every phase ends with `meyou-src.zip` (source without node_modules). The web preview is blank (Android-only); ignore it.

## 2. Hard rules (apply to every phase)
1. TypeScript strict. Latest stable Expo SDK. No web-only code.
2. **Every user-visible string uses an i18n key with both `fa` and `en` filled at the same time.** No hard-coded text.
3. Layout uses logical properties (start/end, marginStart…) so RTL and LTR both work. Language switch applies immediately (reload only if unavoidable).
4. **Dates are stored as UTC ISO strings (Gregorian) only.** Display goes through `src/lib/calendar` (Jalali / Gregorian / both, week start, Persian or Latin digits). Never store Jalali strings.
5. All file access goes through the `StorageProvider` interface. UI never calls Drive or the server directly.
6. Every network feature sits behind an adapter that has a **Mock** implementation, so the app runs fully with nothing configured.
7. No secrets in code. Tokens go in `expo-secure-store`.
8. Design (amended 2026-10-16, U3): Zeydi-style navy dark palette (light derived), default accent **coral `#FF6B6B`**; a heart icon is allowed. Wording stays **gender-neutral** and no sexual/romantic-cliché content is required. Geometric icons (lucide/Feather). One user-selectable accent colour (coral default, teal, amber, blue, green, violet, slate). Light / dark / auto. Fonts: Vazirmatn (fa) + Inter (en) via `@expo-google-fonts`. Subtle motion, haptics on send actions. Entering the app should feel calm and welcoming.
9. Minimal dependencies. Stay compatible with Expo Go until Phase 10 (Google sign-in already needs a native build). If a native module is needed earlier, hide it behind an interface, load it lazily, and note it in HANDOFF.
10. Everything is shared between the two partners. There is no per-item privacy.
11. Settings is the control centre: for every need offer at least two ways/modes (see section 4).
12. **NO INVENTING.** Before writing any feature, search the web for an existing app, service, or package that already does it. Pick the simplest, smallest, best-maintained option, wire it in with minimal glue code, and name it in the HANDOFF. Writing a custom engine, protocol, or server is forbidden unless no existing option exists; in that case stop and ask the user first.

## 3. Screens
Bottom tabs: **Home, Mood (centre), Dates, Settings** (private chat was removed, see Decisions log). Library is a stack screen opened from Home and Dates.
- **Home**: first run shows a prominent "Add partner" button. After pairing: partner card (profile, latest mood), days-together counter, upcoming events/countdowns, meetups this week / this month, "on this day" memories, quick actions. Cards can be reordered/hidden.
- **Mood**: emoji grid in categories, optional text, intensity, one-tap send (partner gets a notification), history.
- **Dates**: one kind, *Event*: date, title, tags, optional yearly repeat (= countdown), optional Library media. List (timeline) + month grid in the chosen calendar, this-week/this-month filter.
- **Library**: one merged tree of folders from all enabled sources (Local, Google Drive, Server). Badges show where each item exists. Auto categories (Photos, Videos, Files, Texts), auto albums by month/year in the chosen calendar, manual albums, tags, favourites, search.

## 4. Settings map (nine sections)
1. **Sources & sync**: add source (local/Drive/server, several allowed); folder mapping (Drive folder ↔ server folder); "Sync now" + progress + log; integrity check. Sync is **copy-only, never deletes**, and runs on the server with rclone (schedule = server cron).
2. **Server connection**: QR scan, manual URL+token; multiple servers with failover; test connection; certificate fingerprint confirm.
3. **Backup & restore**: one-tap "Back up now" (new media), auto-backup toggle; restore on a new phone = add the same sources again.
4. **Media & cache**: thumbnail cache cap (default 500 MB), preview quality, original on demand, offline albums, free-up-space (with cutoff date), upload quality, stream vs download video, data-saver.
5. **Partner & notifications**: pair/unpair, partner profile, per-type notifications (mood, event), test notification.
6. **Language & calendar**: fa/en, Jalali/Gregorian/both, week start (Sat/Sun/Mon), digits.
7. **Appearance**: theme, accent, font size.
8. **Security**: app lock (biometric / device credential), auto-lock timer, block screenshots + hide in recents, strip GPS/EXIF on upload.
9. **Tools**: duplicate finder, storage analyzer, diagnostics log, reset settings.
Rows for features that were cut (see Decisions log) are deleted, not badged.

## 5. Media loading model (critical)
- Never download everything. Three tiers: **thumbnail** (always cached on disk, LRU with user cap, evicted last), **preview** (on open), **original** (on demand, "make available offline", or download).
- Each item has a state: local-only / backed-up / cloud-only, shown by a small icon.
- "Free up space" deletes local copies ONLY of items verified as backed up (md5 match), only on or before a cutoff date.
- Video is streamed with HTTP Range; poster comes from the thumbnail.
- Lists are virtualised (FlashList) and paged; folders with thousands of items must scroll smoothly.

## 6. Sources & sync
- The user already has 4 top-level folders with many nested subfolders (photos, videos) on Google Drive and on the server. **Index them in place** (metadata + thumbnails). Never require upload first.
- Drive: list existing folders (`drive.readonly`) and write app-created files (`drive.file`). Use `md5Checksum`, size, modifiedTime and `thumbnailLink` for diffs and thumbnails; incremental updates via the changes API. Dedupe key: md5, fallback name+size+mtime.
- Server: "external library" — the server scans existing folders read-only and serves an index, thumbnails, Range streaming.
- Folder mapping pairs a Drive folder with a server folder. Copying runs on the server with **rclone** (`copy`, never `sync`); the app only starts a job, polls it and shows the log.

## 7. Server connection details
Two ways to add a server: QR scan or manual URL+token. Prefer HTTPS with a CA-signed certificate (Let's Encrypt) or plain http over LAN/VPN (Tailscale/WireGuard). Self-signed TLS pinning is not built. Tokens in SecureStore.

## 8. Partner, mood, notifications
- Transport = **ntfy** topics (HTTP publish, WebSocket/SSE subscribe). No custom relay, no FCM, no foreground service.
- Pairing = one partner shows a QR / code containing `{ntfyUrl, topic}` (topic is a long random string = the shared secret). The other scans it. Unpair = generate a new topic.
- Mood and event pings are plain JSON in the topic over HTTPS (no extra encryption layer, no chat).
- Background delivery: the user installs the ntfy Android app subscribed to the same topic; meYou itself listens while open and stores moods in SQLite.

## 9. External accounts (user configures later, in Settings)
Google Drive sign-in, ntfy URL + topic, servers. Each has an in-app bilingual "Setup guide" page and a "Test" button. The app must work with all of them unset.

## 10. From the old Irupload web app (carry the ideas, not the code)
Files and texts manager, gallery, accent themes, bundled Persian fonts, EXIF/GPS stripping, storage bar.

## Decisions log
(append only; format: `YYYY-MM-DD Phase N — decision — reason`)

2026-10-14 Phase 1 — First-run preferences are Persian, automatic theme, teal accent, Jalali calendar, Saturday week start, and Persian digits — keeps setup aligned with the initial Persian-language experience while leaving every choice editable.
2026-10-14 Phase 1 — Preview APK cancelled; APKs are built later via GitHub — the user tests through Expo Go until then.
2026-10-14 Phase 2 — Setting rows carry a badge: `later` (control disabled, backend missing) or `pref` (value is saved now, takes effect in a later phase) — keeps every control visible without pretending it works.
2026-10-14 Phase 2 — Demo (mock) server/Drive sources are added but disabled by default; Local is enabled — real libraries must not mix with fake data unless the user opts in.
2026-10-14 Phase 2 — Local provider exposes an app folder (`meyou-library`) plus gallery albums when media permission is granted; the SQLite/AsyncStorage files are never listed — keeps internal data out of the Library.
2026-10-14 Phase 2 — Sources list persists in AsyncStorage (`meyou-sources`); SQLite stays for media metadata from Phase 3 — sources are tiny config, not queryable data.
2026-10-14 Phase 3 — Item identity is md5, else name+size+mtime; favourites, tags, albums and offline copies use it — they survive moving between sources and show one item that exists on several sources.
2026-10-14 Phase 3 — Folders page and merge as they load; categories, auto albums, favourites, tags and search use an in-memory index of all enabled sources — a 5,000-item library stays smooth without storing a second copy of the metadata.
2026-10-14 Phase 3 — Thumbnail disk cache is LRU under the user's cap; phone files are shown in place — no duplicate copies of local photos.
2026-10-14 Phase 3 — Free up space deletes only app-library files with an md5 match on a remote source plus offline copies, never phone-gallery assets — safe by construction, nothing is deleted without a scan first.
2026-10-14 Phase 3 — Added a "Large demo library (5,000 items)" mock source — needed to verify the scroll requirement without a real server.
2026-10-14 Phase 4 — Server auth for media is the `Authorization` header everywhere (ImageRef.headers; new optional `StorageProvider.getOriginalSource()` returns `{uri, headers}` for streaming and downloads; `getOriginalUrl` stays a bare URL without token) — keeps the token out of URLs, logs and caches; expo-video and downloads accept headers, so the contract needed no token-in-URL variant.
2026-10-14 Phase 4 — One server source = an ordered list of addresses (home Wi-Fi, internet, VPN) of the same library; with "Switch between servers" on, the next address is tried when one is unreachable (never on a wrong token) — failover cannot mix different libraries; several independent servers are several sources.
2026-10-14 Phase 4 — Server item ids encode root, path and server id (`d:<root>:<path>`, `f:<root>:<serverId>:<path>`) — folders are listed by root+path in the contract but files are served by server id, and ids must survive an app restart.
2026-10-14 Phase 4 — Uploads are a persisted one-at-a-time queue; resume = repeat `POST /uploads` and continue from the offset the server returns (no resume state on the phone); "Back up new media" skips items whose name+size or md5 already exist on the server and items already uploaded — duplicates are avoided without an extra index.
2026-10-14 Phase 4 — Backups go to `<first root>/meYou Backup/<UTC yyyy-mm>/` on the real server and to the first root on the demo server — keeps backups out of the user's existing folders.
2026-10-14 Phase 4 — Android cleartext HTTP is enabled (expo-build-properties) — a personal server on a LAN/VPN is often plain http; the wizard warns about it. Self-signed HTTPS is rejected by the OS until Phase 11 adds trust/pinning.
2026-10-14 Phase 4 — Tokens live only in expo-secure-store (key per server entry); AsyncStorage keeps the address list, never the token — brief rule 7.
2026-10-14 Phase 5 — DriveProvider depends only on `DriveAuth.getAccessToken()` with two strategies (Google Sign-In loaded lazily, pasted token in SecureStore); a 401 forces one token refresh and a retry — Expo Go keeps working with a pasted token while the native sign-in waits for a dev build.
2026-10-14 Phase 5 — Drive roots are the folders directly under My Drive; Google-native documents are skipped; nothing is downloaded to index — matches "index existing folders in place" with md5Checksum/size/modifiedTime.
2026-10-14 Phase 5 — Drive thumbnails use `thumbnailLink` with an Authorization header and are re-read after 20 minutes (links expire); originals use `getOriginalSource` (URL + header) — the Phase 3/4 pipeline and token rule stay unchanged.
2026-10-14 Phase 5 — Incremental updates: the first `changes()` call only returns a start cursor, later calls follow `changes.list`; non-deleted changes are `update` — Drive does not distinguish add from update, and the index itself comes from `list()`.
2026-10-14 Phase 5 — Uploads go only into an app-created `meYou Backup` folder (drive.file scope) with a resumable, chunked, md5-verified upload; the app never deletes on Drive — same no-delete stance as the server, safe by construction.
2026-10-14 Phase 5 — "Back up now" falls back to the first enabled real Drive when no server is enabled — reuses the Phase 4 queue without a new screen.
2026-10-15 Phase 5→6 — PRIVATE CHAT REMOVED completely (old Phase 8): tab, Settings section, store keys, i18n strings deleted; relay `chat` payload dropped — the user wants a lighter app; moods/events cover partner contact.
2026-10-15 Phase 6 — Sync = rclone `copy` on the server, triggered/polled from the app; the phone-side diff engine, conflict/deletion policy pickers, background tasks, queue backoff and bandwidth limits are NOT built — rclone already does this and "never delete" is a fixed policy.
2026-10-15 Phase 7 — Partner transport = ntfy (existing software) instead of a custom relay + FCM + foreground service; no tweetnacl layer for moods — the secret topic over HTTPS is enough for emoji pings.
2026-10-15 Phase 8 — Notes and Meetups merged into one Event; Home cards have a fixed order (no layout editor) — fewer screens, same value.
2026-10-15 Phase 9 — App lock uses expo-local-authentication with the device credential as fallback (no custom PIN); `expo-screen-capture` covers both "block screenshots" and "hide in recents"; bulk rename/move, gallery import, encrypted settings export, partial reset dropped.
2026-10-15 Phase 10 — SSH installer, certificate pinning, FCM, dev-client phase and widgets are dropped from the main line (widgets = optional Phase 11 after release); Contract section B is replaced by ntfy usage.
2026-10-15 Phase 6 — Sync talks to `rclone rcd` through `sync/copy` and `operations/check` only (allow-list in the client, tested); mapping stores picked folder names and builds `<remote>:<path>` / `<base>/<path>` at run time; rcd runs with a 24 h job-expire so finished jobs and logs stay readable; the settings rows for engine, direction, schedule, conflict, deletion, dry run and bandwidth were deleted — rclone copy is fixed policy and schedules live in server cron.
2026-10-15 Phase 7 — Partner state = ntfy JSON publish + WebSocket subscribe with `since=<unix time>` replay, deduplicated by ntfy message id; the shared topic (24 random bytes) and the optional access token live in SecureStore, never in AsyncStorage — brief rule 7 and the topic is the secret.
2026-10-15 Phase 7 — Added two message details to Contract B: `profile.hello` (a joining phone asks for the other's profile) and `unpair` (the partner drops the topic too) — without them the first phone never learns the second joined and a silent unpair leaves a dead pairing.
2026-10-15 Phase 7 — Cut Settings rows deleted: backup-result notifications, quiet hours, delivery method (FCM), sound and vibration — not in the ntfy scope; notifications are local (expo-notifications) and only for mood and event.
2026-10-15 Phase 8 — An event stores the calendar it was typed in (`cal`) and a yearly repeat follows THAT calendar (30 Esfand -> last day of a shorter month; 29 Feb -> 28 Feb); the date itself stays a UTC Gregorian ISO string — switching the display calendar later never moves an anniversary.
2026-10-15 Phase 8 — The `event` ntfy message gained `cal` and `deleted`; tags and the Library attachment are local only — the partner needs the date and title, not our private organisation, and a Library key means nothing on another phone.
2026-10-15 Phase 8 — "Days together" uses a start date kept on each phone (Settings > Partner profile), not synced; "On this day" = events and already-indexed Library media with the same month/day in an earlier year in the chosen calendar — Home never starts a Library scan by itself.
2026-10-15 Phase 9 — "Block screenshots" and "Hide in recent apps" are one setting (`blockScreenshots`) — on Android `expo-screen-capture` uses FLAG_SECURE, which does both and cannot be split; the second row was deleted.
2026-10-15 Phase 9 — EXIF/GPS is stripped by re-encoding photos (expo-image-manipulator) in an optional `prepare` step of the upload queue; if the re-encode fails the upload fails (`prepare`) and the original is never sent — privacy must not fail open. Videos are not changed.
2026-10-15 Phase 9 — App lock locks by time spent in the background (not in-app idle time), requires a phone screen lock to be enabled, needs a prompt to turn off or to reset settings, and never locks the person out when the phone has no screen lock any more.
2026-10-15 Phase 9 — Tools are read-only: duplicate finder lists equal-md5 groups from the Library index, storage analyzer sums existing numbers, diagnostics shares a secret-free text report; no bulk rename/move, gallery import or full reset.
2026-10-15 Phase 10 — Release build = EAS Build `preview` profile (apk), free Expo account; the user runs the build. Version 1.0.0, versionCode in app.json (`appVersionSource: local`).
2026-10-15 Phase 10 — Every Settings row that only stored a preference or was badged `later` was deleted before release (upload quality, mobile-data/Wi-Fi rules, backup schedule, text size, density, time zone, holidays, restore/ZIP/settings export-import, Home layout, widgets, server update/uninstall) — shipping dead switches is worse than not having them; they can return as real features.
2026-10-15 Phase 10 — Unused permissions are blocked (location, audio, overlay) and the unused `expo-location` and Replit tooling were removed; the README states that the file-server contract has no real implementation in this project.
2026-10-15 Phase 11 — One "days together" widget with `react-native-android-widget` (existing library, Expo config plugin); it reads the same persisted start date and settings as Home through AsyncStorage and the same date helpers, so the number cannot differ from Home; refreshed on save/app start plus the system's ~30-minute update; no widget settings, no other widgets — the brief's widget list is cut to the one the user asked for.
2026-10-16 U1 — Google Drive removed completely (user decision, UI track): no Drive source, sign-in, guide, tests or package. Library sources are now Local + (dormant) Server. The Drive->server folder mapping UI went with it; the lines above that mention Drive are history. Hard rules are unchanged.
2026-10-16 U3 — Hard rule 8 amended (user decision Q6/Q8): coral accent `#FF6B6B` default, navy dark palette, hearts allowed; neutral wording and no explicit/romantic-cliché content still apply. Existing users keep their saved accent; theme default stays Auto.
2026-10-16 U21 — Diary attachments accept any number of photos/videos; picked source media is copied without app-side editing or re-encoding, preserving its original file data.
