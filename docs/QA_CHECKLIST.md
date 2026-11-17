# meYou — final Android QA checklist

Run sections 0–6 on a real Android phone with the preview APK; leave those boxes unticked until verified on-device. Section 7 records host-side checks and may be checked when actually run. Source tests and Expo bundling are not device QA.

## 0. Install and first run

- [ ] The APK installs; launcher, adaptive and themed icons render correctly.
- [ ] The splash screen appears, then the app opens without a crash.
- [ ] On a fresh install, the four welcome slides appear in order (Status, Events, Diary, Archive); the only action opens onboarding, with no account or sign-in controls.
- [ ] Onboarding accepts a name, a Gregorian or Jalali birthday, and an optional photo; Finish opens Home.
- [ ] Relaunching after onboarding opens the app, not the welcome flow. Existing installs upgraded from an older settings version also skip first-run.
- [ ] The four tabs are Home, Status, Events and Diary. Settings opens from the Home avatar and returns to the app.
- [ ] With no data and no network, each active screen opens and shows a useful empty state.

## 1. Language, RTL and accessibility

- [ ] Persian (fa): all active screens are translated, right-aligned where appropriate, and mirrored once; back arrows, tab order and horizontal lists point in the expected direction.
- [ ] English (en): all active screens are translated and left-to-right. Switching language applies immediately.
- [ ] Jalali/Gregorian calendar and Persian/Latin digits follow the selected settings in dates, status history, Diary and the widget.
- [ ] Auto, Light and Dark themes plus each accent remain readable; controls, selected states, empty states and sheets use the selected palette.
- [ ] At 320 dp width and a large system font scale, text wraps or scrolls without hiding actions or clipping important labels.
- [ ] Keyboard appearance and dismissal work on name, profile and Diary inputs; sheets and pinned actions remain reachable.

## 2. Home, status and events

- [ ] Home shows This week, My status, Days together, On this day, the Archive shortcut and the camera action; the Connect card opens invite/join (partner, since S8).
- [ ] Home’s status and days-together cards update after saving data; Home does not trigger an Archive scan just by opening.
- [ ] Status search and category chips filter both moods and activities; selecting and saving a status updates the history and Home. A saved status is sent to the partner only while paired.
- [ ] Create, edit and delete events. Check one-time and yearly events, Jalali and Gregorian dates, Upcoming/Past, optional month grid and the surprise toggle.
- [ ] Event camera/gallery attachments open and save locally; event changes are sent to the partner only while paired.

## 3. Diary

- [ ] Create a Diary entry with a title, category, optional mood, body and photos/videos; Save returns to the list.
- [ ] Search, newest/oldest sorting, category filtering and Saved filtering work in both languages.
- [ ] Open an entry; photos/videos, bookmark, edit and delete actions work. Removing an entry does not delete its Archive media.
- [ ] Gallery selection accepts photos and videos without an app-imposed item-count cap; the files copied into Direct are not cropped, resized, re-encoded or stripped of metadata.
- [ ] The keyboard does not cover Save or prevent editing in Persian or English.

## 4. Direct, camera and permissions

Direct (the app's own library, the vault) is the only source of Archive, Explore, memories and events. There is no gallery source and no server library.

- [ ] Archive/Explore open and show only Direct files. Adding from the gallery, the camera or Files **copies** the file into Direct; the original stays in the gallery. Thumbnails exist right after the copy and grids scroll without decoding full-size files.
- [ ] Camera capture works from Home, profile, Events and Diary where offered, lands in Direct > `Camera`; denying camera access shows a localized, actionable message; no microphone permission is requested.
- [ ] Browse by Diary category, sort an album by date/name; long-press 20 files, set a date and category in bulk, add them to an album.
- [ ] Deleting a Direct file asks for confirmation; the original in the phone gallery is untouched.
- [ ] Update from the previous version on the same package id: old library files, favourites, tags, albums, memories and events still show (one-time `legacy-migrate` copied them into Direct; nothing was deleted). Open Storage analyzer: no "Gallery" row.
- [ ] Airplane mode does not prevent local profile, Status, Events, Diary or Archive screens from opening.

## 5. Server, partner and data boundaries

- [ ] With no server saved, every screen works and nothing is sent anywhere (airplane-mode check).
- [ ] Before secure pairing, sending to the partner shows "pair securely first" (fa/en); local work is unaffected. No plain-text or old-path fallback exists.
- [ ] After secure pairing, everything shared (status, events with photo/note, memories with photos/videos, chat, Direct files, stories, profile photo) travels only as encrypted queue messages. `GET /ping` on the server lists no `media`, `upload` or `mailbox`; `/roots`, `/tree`, `/mailbox` answer `404`.
- [ ] A new picture reaches the partner as a thumbnail at once; the sharper preview arrives only when it is on the partner's screen; the original only after "Full quality". The original is byte-identical to the sender's file (metadata kept on purpose).
- [ ] Do not treat old ntfy/rclone/Drive/backup instructions in historical phase notes as current: they were removed.

## 6. Settings, security and widget

- [ ] Settings opens the profile editor, Archive, widget help/refresh, language/calendar, appearance, media/cache, security, tools and legal screens that are currently enabled.
- [ ] App lock enable/disable and Reset settings use the Android device credential/biometric flow; leaving and returning respects the selected lock delay.
- [ ] Block screenshots behaves as intended in screenshots and the Android recents view.
- [ ] Duplicate finder, Storage analyzer and Diagnostics open. Sharing a diagnostics report is explicitly user-triggered.
- [ ] The days-together widget can be added and resized. Its count and hint match Home, and its language, calendar, digits, accent and light/dark appearance update after refresh.
- [ ] The widget opens meYou when tapped. The widget is not expected to work in Expo Go.
- [ ] Settings > Legal > Privacy policy and Terms of use: in Persian and in English every section is present, scrolls fully, is aligned for the language and is not clipped at 320 dp or a large font. The text says: shared data is end-to-end encrypted and goes only through the own server's queue (the server sees who/when/size and the online state, never content; deleted when the partner confirms, or after 30 days); nothing is backed up to the server; thumbnails/previews/profile photos carry no metadata while the original file is sent unchanged; HTTPS and tokens in Android SecureStore, encryption keys stay on the two phones; push through Google FCM with a generic text; no analytics and no ads; how a phone is revoked; wrong-token lockout and logs without content.
- [ ] The revoke commands named in the Privacy policy work on the VPS as written (see `docs/SERVER_QA.md`, S11).
- [ ] Notification-type switches (S11): on phone B turn "Mood updates" off; with B's app closed, send a status from A: no system notification on B, the status is there when B is opened. Turn it on again: the next status notifies. Repeat for "Events". Messages of both types still arrive in the app either way.

## 6b. Chat, story, period, diary and refresh

- [ ] Chat: tap the text box; the box rises above the keyboard and the typed text stays visible; closing the keyboard drops it back.
- [ ] Explore > open a photo > Send to Direct (a photo and a video): the chat shows it without a coloured frame, in its own proportions (a portrait stays portrait); a tap opens it full screen.
- [ ] Reply to the partner's story with text: the chat shows the story's photo/video with the reply text under it (both phones).
- [ ] Period: the trash icon works on every entry; "Delete all history" asks first and clears only this phone.
- [ ] Diary > new memory with photos/videos from the gallery: they are copied into Direct and the memory shows them from local thumbnails.
- [ ] Pull down on Home, Status, Events, Diary, Period, the Archive and Explore: a spinner shows and the screen updates; in the chat the list is upside down, so check where the spinner appears.

## 7. Build and permission hygiene

- [x] `pnpm typecheck`, `pnpm test`, `npx expo export --platform android --max-workers 1 --no-bytecode` and `CI=1 npx expo prebuild --platform android --no-install` pass.
- [x] Inspect the generated manifest: `CAMERA`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO` and `READ_MEDIA_VISUAL_USER_SELECTED` are present; legacy `READ/WRITE_EXTERNAL_STORAGE` are limited to API 32. `RECORD_AUDIO`, `READ_MEDIA_AUDIO`, location and `SYSTEM_ALERT_WINDOW` are marked for removal.
- [x] Generated `android/` was removed after the prebuild check; no native directory is retained in the source archive.
- [x] App version `2.0.0` / `android.versionCode` `4` are set in `app.json` (stage 2E part 3; set in source, not seen on a phone yet). The server reports version `2.0.0` (`features` `["e2e"]`, plus `"push"` with the Firebase key) once the VPS is updated. `versionCode` must always go up for an update over the installed app (same package id, same signing key).
- [ ] Before releasing, check the version shown in Android's app info on the installed APK. The GitHub workflow signs with the key of the generated Android project (the Expo template's debug key, the same on every run), so updates over an earlier GitHub APK install; an APK from another source (EAS, local keystore) has a different signature and must be uninstalled first. Keep the keystore of any release you publish elsewhere.
- [ ] The final two-phone scenario is `docs/SERVER_QA.md` > "FINAL — release QA (S12)"; run it once before releasing.
