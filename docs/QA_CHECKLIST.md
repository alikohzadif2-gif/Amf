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
- [ ] Gallery selection accepts photos and videos without an app-imposed item-count cap; the selected source files are not cropped, resized, re-encoded or stripped of metadata by the Diary import path.
- [ ] The keyboard does not cover Save or prevent editing in Persian or English.

## 4. Archive, camera and permissions

- [ ] Archive opens and handles the phone-media permission being granted or refused without crashing.
- [ ] Import media from Gallery and Files. Camera capture works from Home, profile, Events and Diary where offered.
- [ ] A Home camera capture appears in Archive > `Snaps`; gallery imports and screen attachments appear under the expected Archive keys.
- [ ] Denying camera access produces a localized, actionable message. Camera capture does not request microphone permission.
- [ ] Add the large demo archive in a test build if available; verify virtualized browsing, paging, search, viewer, selection, tags, albums, favourites and offline actions.
- [ ] Browse photos/videos by Diary category, sort an album by date/name, and verify a folder displays its date and category.
- [ ] Long-press 20 photos/videos, set a date and Diary category in bulk, add them to an album, then verify the album filters/sorts them correctly in fa and en.
- [ ] Deleting a selected local copy asks for confirmation; the original in the phone gallery and any server copy remain. Cloud-only media cannot be deleted from the Archive.
- [ ] Airplane mode does not prevent local profile, Status, Events, Diary or Archive screens from opening.

## 5. Server, partner and data boundaries

- [ ] `src/constants/features.ts` has `server`, `serverLibrary`, `serverBackup` and `partner` all `true` (there is no `sync` flag any more) for the shipped build.
- [ ] Settings shows Server connection, the server as an Archive source, Backup & restore, Uploads and Partner & notifications. Settings > Google Drive (sign in with Google) is the only login; there is no meYou account.
- [ ] With no server saved, every screen works and nothing is sent anywhere (airplane-mode check, section 4).
- [ ] With a server saved, traffic goes only to that server. Status, events and profile go to the partner only while paired; Diary entries are never sent to the partner.
- [ ] Do not treat old ntfy/rclone/sync instructions in historical phase notes as current: ntfy, the foreground service and rclone sync were removed (S10/S11).

## 6. Settings, security and widget

- [ ] Settings opens the profile editor, Archive, widget help/refresh, language/calendar, appearance, media/cache, security, tools and legal screens that are currently enabled.
- [ ] App lock enable/disable and Reset settings use the Android device credential/biometric flow; leaving and returning respects the selected lock delay.
- [ ] Block screenshots behaves as intended in screenshots and the Android recents view.
- [ ] Duplicate finder, Storage analyzer and Diagnostics open. Sharing a diagnostics report is explicitly user-triggered.
- [ ] The days-together widget can be added and resized. Its count and hint match Home, and its language, calendar, digits, accent and light/dark appearance update after refresh.
- [ ] The widget opens meYou when tapped. The widget is not expected to work in Expo Go.
- [ ] Settings > Legal > Privacy policy and Terms of use (S11): in Persian and in English every section is present, scrolls fully, is aligned for the language and is not clipped at 320 dp or a large font. The text says: data goes only to the own server; photos/videos only when backup is on; partner messages kept 30 days / 1000 messages; HTTPS and tokens in Android SecureStore; push through Google FCM with a generic text and no message content; no analytics and no ads; the app never deletes on the server; how a phone is revoked (`sudo ./setup.sh devices`, `sudo ./setup.sh revoke <id>`); wrong-token lockout and logs without content. It no longer says that data stays only on the phone, that partner sync is off, or that there is no backup.
- [ ] The revoke commands named in the Privacy policy work on the VPS as written (see `docs/SERVER_QA.md`, S11).
- [ ] Notification-type switches (S11): on phone B turn "Mood updates" off; with B's app closed, send a status from A: no system notification on B, the status is there when B is opened. Turn it on again: the next status notifies. Repeat for "Events". Messages of both types still arrive in the app either way.

## 6b. Google Drive (phone only, real Google account)

- [ ] Settings > Google Drive > Sign in with Google: the account picker opens, the consent screen lists Drive access, and afterwards the account e-mail, the `meYou` folder and the storage use are shown. Airplane mode then "Test connection" shows an error, not a crash.
- [ ] Archive > Source > Google Drive lists the `meYou` folder's sub-folders and files; thumbnails load; a photo opens full size; a video plays and can be seeked.
- [ ] In the Drive view, + > Gallery uploads photos into the open folder (also a large video, and with the network switched off half-way: it fails with a message, no half file stays); + > New folder makes a folder; the new items appear after the refresh.
- [ ] Select an item and a folder > Move to bin: the confirmation says Drive bin and 30 days; the items are in the bin of drive.google.com and can be restored there. Nothing is ever deleted for good.
- [ ] Explore starts on Google Drive; signed out it shows "Connect Google Drive"; the Source tool still offers Phone and Server.
- [ ] Settings > Google Drive > Choose another folder: pick a folder, make a new one, "Use this folder" changes what the Archive and Explore show. Sign out: Drive disappears from Archive/Explore and nothing in Drive is deleted.
- [ ] A photo that is on the phone and in Drive shows once, with both source icons and the "backed up" mark.

## 6c. Chat, story, period, diary and refresh

- [ ] Chat: tap the text box; the box rises above the keyboard and the typed text stays visible; closing the keyboard drops it back.
- [ ] Explore > open a photo > Send to Direct (also a Drive-only photo and a video): the chat shows it without a coloured frame, in its own proportions (a portrait stays portrait); a tap opens it full screen.
- [ ] Reply to the partner's story with text: the chat shows the story's photo/video with the reply text under it (both phones).
- [ ] Period: the trash icon works on every entry; "Delete all history" asks first and clears only this phone.
- [ ] Diary > new memory: "Where to store" defaults to Google Drive; + Gallery uploads into the chosen folder (default `Diary`), the folder row lets you pick or make another; with Phone selected the files stay on the phone; signed out shows the hint.
- [ ] Pull down on Home, Status, Events, Diary, Period, the Archive and Explore: a spinner shows and the screen updates; in the chat the list is upside down, so check where the spinner appears.

## 6d. Backup to Google Drive

- [ ] Signed in to Drive: Settings > Backup > Back up now (camera folder): photos land in `meYou/Photos/<year>/<month>` and videos in `meYou/Videos/<year>/<month>` in Drive; nothing new appears on the personal server.
- [ ] Run it again: nothing is sent twice and no second month folder appears. Pause in the middle of a big video, then continue: it finishes (it may restart that file).
- [ ] Automatic backup of new memories/events/Archive files: files appear in `meYou/Backup/<year>/<month>/<day>` with their info files.
- [ ] Fill Drive (or use a tiny account): the upload shows "Google Drive is full" and is not retried forever. Sign out of Google: uploads show the sign-in message.

## 7. Build and permission hygiene

- [x] `pnpm typecheck`, `pnpm test`, `npx expo export --platform android --max-workers 1 --no-bytecode` and `CI=1 npx expo prebuild --platform android --no-install` pass.
- [x] Inspect the generated manifest: `CAMERA`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO` and `READ_MEDIA_VISUAL_USER_SELECTED` are present; legacy `READ/WRITE_EXTERNAL_STORAGE` are limited to API 32. `RECORD_AUDIO`, `READ_MEDIA_AUDIO`, location and `SYSTEM_ALERT_WINDOW` are marked for removal.
- [x] Generated `android/` was removed after the prebuild check; no native directory is retained in the source archive.
- [x] App version `1.2.0` / `android.versionCode` `3` are set in `app.json` (R11, set in source; not seen on a phone yet). The server reports version `1.2.0` once the VPS is updated.
- [ ] Before releasing, check the version shown in Android's app info on the installed APK. The GitHub workflow signs with the key of the generated Android project (the Expo template's debug key, the same on every run), so updates over an earlier GitHub APK install; an APK from another source (EAS, local keystore) has a different signature and must be uninstalled first. Keep the keystore of any release you publish elsewhere.
- [ ] The final two-phone scenario is `docs/SERVER_QA.md` > "FINAL — release QA (S12)"; run it once before releasing.
