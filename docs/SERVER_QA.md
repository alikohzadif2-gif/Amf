# meYou — Server QA checklist (`docs/SERVER_QA.md`)

**Start with "FINAL — release QA (S12)" below.** It is the one scenario to run before a release (two phones, one VPS, the APK built by GitHub). The per-phase sections after it (S1 … S11) are the detailed lines it points to; use them when a step fails or when you only changed that part.
Mark a line `[x]` only after you ran it. Device/VPS lines are marked by the user, the host lines by whoever ran them. The AI has marked only the F0 host lines it actually ran (R11 chat, sandbox with network, 2026-10-19); no phone, no VPS, no Docker and no GitHub Actions were available to it.

## FINAL — release QA (S12)

**You need:** the VPS with the domain (S1), phone A (will be the owner) and phone B (the partner), both Android with the APK from the GitHub workflow "Build APK" (version 1.2.0, versionCode 3), a Firebase project whose key is on the server (`sudo ./setup.sh push-key <key.json>`) and whose `google-services.json` is the GitHub secret `GOOGLE_SERVICES_JSON`, a computer for `curl`, a handful of test photos and one short video on phone A.

### F0. Host checks (before any phone; run on a computer with network, in a fresh clone or the exported zip)
- [x] `pnpm install --frozen-lockfile` passes (the lockfile and `package.json` agree; after any local `expo prebuild` remove the three lines it adds to `package.json`).
- [x] `pnpm typecheck` passes.
- [x] `cd server/meyou-server && npm ci && npm run typecheck && npm test` passes (R11: 147/147; schema 6).
- [x] `pnpm test` passes **with** `npm ci` done in `server/meyou-server`; the output must NOT contain `live server test skipped`.
- [x] `npx expo export --platform android --max-workers 1 --no-bytecode` passes.
- [x] `CI=1 npx expo prebuild --platform android --no-install` (with a fake `google-services.json`, reverted afterwards): `versionCode 3`, `versionName "1.2.0"`, `meyou` scheme, FCM default channel `meyou-partner-v2`, no foreground-service entries.
- [x] `grep -ri ntfy . --exclude-dir=docs --exclude-dir=node_modules` prints nothing.
- [ ] The GitHub workflow "Build APK" (Actions > Run workflow) is green and the artifact `meyou-apk` holds one `.apk`; the new step "Install server packages" ran. Install that APK on both phones.
- [ ] GitHub workflow "Server tests" is green (typecheck, tests, Docker build).

### F1. Server up
- [ ] Fresh VPS or `sudo ./setup.sh update` on the existing one finishes (the VPS may still run 1.0.0: this also applies schema 6; `PUSH_PERIOD_DETAIL=true` in the server `.env` if you want the three distinct period notifications); `sudo ./setup.sh status` shows `meyou-server` healthy and Caddy up; after `reboot` both return by themselves (S1, S11).
- [ ] `curl https://YOUR-DOMAIN/api/v1/ping` answers `name`, `version` **1.2.0** and `features` `["media","upload","mailbox","push"]` (`push` only with the Firebase key); `sudo ./setup.sh push-test --check` prints the Firebase project id.
- [ ] `sudo ./setup.sh devices` lists the owner; no token or hash is printed anywhere.

### F2. Connect (phone A) — details S2
- [ ] Scan the owner link/QR (or paste it): Settings > Server connection shows name, version, speed, role `owner` and the features; Test is green.
- [ ] Wrong token (edit one character) → the "token not accepted" text, nothing saved by accident. Wrong address → "no connection" text. Both in Persian and English.

### F3. Backup and browse (phone A) — details S4, S6
- [ ] Settings > Backup & restore: photos + video, Wi-Fi only, **Back up now**. The Uploads screen counts up; on the server the files are under `Photos/<year>/<MM>` and `Videos/<year>/<MM>` with the original date, and the same count again afterwards uploads nothing new.
- [ ] Airplane mode in the middle of the video, then on again: the upload resumes by itself; the server file is complete (compare size, or `md5sum`).
- [ ] Archive > server source: folders, thumbnails, previews and paging work; open a photo; **play the video** (seek works); nothing in the Archive can delete a server file.
- [ ] On the server nothing was ever deleted or overwritten by the app (a second file with the same name became `name (1).ext`).

### F4. Pair (phones A and B) — details S7, S8
- [ ] Phone A: Settings > Partner > invite: link/QR with a 30-minute single-use code. Phone B: scan/paste it. Both show "paired"; `sudo ./setup.sh devices` lists two phones; a third invite is refused ("household full").
- [ ] The same code used a second time or after 30 minutes is refused with the "invalid code" text.

### F5. Status, event, diary (both phones, app open) — details S8
- [ ] A sends a status: B shows it within seconds; B sends one back. Both histories match.
- [ ] A creates, edits and deletes an event (also a yearly one on a Jalali date): B follows each change.
- [ ] A edits the profile (name, photo, birthday): B shows it.
- [ ] **Diary memories (R8a/R8b):** A writes a memory (title, text, category, mood) and saves: B gets it in the Diary within seconds (with a notification when B has "Memories" on; a closed B shows the generic push text). A edits it: B shows the change. A with a custom category: B gets a category of the same name. A adds a photo/video: B can view it from the memory; media-only changes sync silently. A deletes it: it disappears on B. B deleting its copy does not delete A's memory. Shared media is stored under `Shared/`, not in the mailbox payload.

### F6. Push with the app closed — details S9, S10, S11
- [ ] Close B completely (swipe away). A sends a status: B gets a system notification with the **generic** text (Persian text when B's app language is Persian) that contains no emoji, note or title; tapping it opens meYou and the status is already there. Same for an event.
- [ ] No permanent notification exists on either phone (pull down the shade while the app is open and closed).
- [ ] **Opt-out (S11):** on B switch "Mood updates" off (Settings > Partner & notifications), close the app, A sends a status: no system notification, the status is there when B is opened. Switch it on: the next one notifies. Same for "Events".
- [ ] `sudo ./setup.sh logs meyou-server` shows push lines with device id and type only: no token, no message text.

### F7. Reconnect and offline — details S8, S10
- [ ] In `server/meyou-server` on the VPS run `docker compose restart meyou-server`: within a minute both phones reconnect without any action; a status sent right after arrives.
- [ ] Airplane mode on B for a few minutes, A sends two statuses and an event; B back online: all three arrive once each (no duplicates).
- [ ] Airplane mode on A: Home, Status, Events, Diary and Archive (local part) still open; server sources show the "no connection" notice, nothing is deleted or logged out.

### F8. Wrong token, lockout, revoke — details S11
- [ ] From a computer: 12 requests with different bad tokens → 401 ×10, then `429 locked_out`; `/ping` still answers; after 15 minutes the address is free. A phone on the same network meanwhile shows the "busy" text with "Try again in N seconds" and keeps its saved server.
- [ ] `sudo ./setup.sh rotate-token` (owner): phone A gets "token not accepted" within about 30 seconds; its pairing is not wiped; add the new link in Server connection and reopen meYou: everything works again.
- [ ] `sudo ./setup.sh revoke <B's id>`: B shows the "token not accepted" notice with the link to Server connection; A is unaffected; the server accepts a new invite for a new phone.
- [ ] Unpair from A (normal path): B learns it ("unpaired" state), the household has room for a new partner.

### F9. Texts, languages, look — details S11 part 2
- [ ] Settings > Legal > Privacy policy and Terms of use, in Persian and English: all sections present, correct RTL, readable at a large font and at 320 dp, and every sentence is true for this setup (30 days / 1000 messages, FCM generic text, the revoke commands, lockout, logs, no analytics/ads, the app never deletes on the server).
- [ ] `docs/QA_CHECKLIST.md` sections 0–6 (device lines) are run on at least one phone.

### F10. Maintenance — details S11 part 1
- [ ] `sudo ./setup.sh backup` creates a DB copy; restore it on a spare folder following `server/meyou-server/README.md` > Backup and restore: both phones' tokens work on the restored server.
- [ ] `sudo ./setup.sh update` twice in a row: data, tokens and the library unchanged, no migration error in the log.

### F11. Refinement features (R1–R10) — two phones unless stated; details in `docs/REFINE_PHASES.md` (each phase's Result and Limits)
- [ ] **Push heads-up (R1b, N-B3):** with the app closed on B, A's status gives a pop-up with sound (channel `meyou-partner-v2`). If not: `sudo ./setup.sh push-test --check`, `push-test`, `logs` (steps in the R1b Result).
- [ ] **Events (R2):** an event with a photo, a note and an icon, then edit and delete, arrives on B each time; the together date set on A shows on B and Home shows the slim days-together card.
- [ ] **Status (R3, R4):** clear mood on A → B shows "no mood"; 😈, recents first, delete from history, hide a mood and an activity in Settings. The sticky "My mood" card and dark filled chips look right in fa/en, light/dark, and scrolling is smooth.
- [ ] **Period (R5a/R5b):** log "period started" on A: B sees the ring with the day number and the PMS mark, and gets the notification; "in pain" and "feeling better" give their own notifications (needs `PUSH_PERIOD_DETAIL=true` for the distinct text of a closed app); the "Period updates" switch turns them off.
- [ ] **Diary (R6, R7, R8a/b):** categories (none, custom add/delete), date filter, add/remove media on the detail screen; tile grid first, then the swipe viewer; one tap hides the top icons. A memory with text and a photo/video reaches B (see F5).
- [ ] **Archive (R9):** the Library is called Archive; per-item dates drive album/category views; deleting a local copy never touches the server or phone original.
- [ ] **Text size (R10a):** the four sizes change text and cards app-wide in fa and en; Android system font scaling still applies; nothing is cut off at the largest size on a 320 dp phone.
- [ ] **Data backup (R10b):** Settings > Backup > "Events and memories": a new event/memory appears as JSON under `Backup/Data` on the server (also the private event photo); surprise events are not included.
- [ ] **Profile photo (R10c):** A picks a new profile photo and saves: B shows the tiny photo at once, then the sharper one; a name change reaches B; with the server unreachable B keeps the tiny photo.

### Result
- [ ] Every line above is marked, every failure is fixed and re-run, then tag the release (the APK from F0 is the release candidate): `git tag -a v1.2.0 -m "meYou 1.2.0" && git push origin v1.2.0`.

## S1 — Server skeleton (run on the VPS)
- [ ] DNS A record for the sub-domain points at the VPS (`dig +short YOUR-DOMAIN` shows its IP).
- [ ] Docker + Docker Compose installed; port 80 and the HTTPS port (443, or `HTTPS_PORT` such as 8443 with `PUBLIC_URL` set in `.env`) open, also in the provider firewall.
- [ ] `sudo mkdir -p /srv/meyou && sudo chown -R 1000:1000 /srv/meyou`
- [ ] `cd server/meyou-server && cp .env.example .env`, `DOMAIN` set, then `docker compose up -d --build` finishes without errors.
- [ ] `docker compose ps` shows `meyou-server` and `caddy` running (no restart loop).
- [ ] `docker compose exec meyou-server meyou-server init` prints the link, the QR and the JSON. Save the link somewhere private.
- [ ] `curl https://YOUR-DOMAIN/api/v1/ping` answers `{"name":"…","version":"0.1.0","features":[]}` over a valid HTTPS certificate.
- [ ] `curl -i https://YOUR-DOMAIN/api/v1/me` answers `401`.
- [ ] `curl -H "Authorization: Bearer <token from the link>" https://YOUR-DOMAIN/api/v1/me` answers the owner device (`role: owner`, `partner: null`).
- [ ] `curl -H "Authorization: Bearer <token>" https://YOUR-DOMAIN/api/v1/roots` lists `Photos` and `Videos`.
- [ ] Running `init` again prints `Already initialized` and no link.
- [ ] `docker compose restart meyou-server`, then the token still works (data is kept in `/srv/meyou`).
- [ ] `docker compose logs meyou-server` shows no token.

## S1 (alternative) — own certificate, custom HTTPS port
- [ ] `./scripts/copy-cert.sh <fullchain> <key>` prints the certificate subject (the domain) and its end date.
- [ ] `docker compose -f docker-compose.own-cert.yml up -d --build` works; `ping` answers over `https://DOMAIN:HTTPS_PORT`.
- [ ] After the certificate is renewed, running `copy-cert.sh` again keeps the server working.

## S2 — App connects to the server (on a real Android phone, S1 deployed)
- [ ] Settings > Server connection is visible; "Backup & restore" and "Partner & notifications" are NOT in Settings (since S4 "Sources" is shown, see S4). There is no SSH row and no fingerprint switch.
- [ ] The "Connected" result box is green (not coral/red); a failed test is red.
- [ ] Add a server with **Scan a QR code**: scan the QR from `meyou-server init`. The form fills in and the test shows "Connected", the server name and version, the speed, "2 folders", "Owner" and the note that the server only handles the connection for now. Save works.
- [ ] Add a server by **pasting the link**: paste the `meyou://server?...` link into "Connection link". The form fills in, the field empties, the test runs by itself.
- [ ] Add a server by typing **URL + token** (copy the token from the link). Same result.
- [ ] Open the `meyou://server?...` link from another app (Notes, Telegram "Saved messages"): meYou opens the add screen with the values filled in and tested. Nothing is saved until Save is pressed.
- [ ] Wrong token (change one character): "The token is wrong..." and Save does not proceed.
- [ ] Airplane mode: "Could not reach the server..." message; switch it off and the same screen works again.
- [ ] Wrong address (a domain that exists but is not your server): "...not a meYou server".
- [ ] Settings > My servers > Test shows the same status lines for the saved server; add a second address, reorder it, remove it.
- [ ] Switch the app language fa <-> en: every message above is translated and reads correctly in RTL.
- [ ] (S2 build only; superseded by S4) Archive does not list the server; nothing about uploads/backup is reachable.
- [ ] Restart the app: the saved server is still there and its test still passes (token is in secure storage).
- [ ] Privacy policy text mentions that an added personal server is contacted only to test the connection.

## S3 — Media read API (on the VPS, after `sudo ./setup.sh update`; token = the one from `init`)
Use your own address and token. `B=https://maryafox.ir:18443/api/v1` and `H="Authorization: Bearer <token>"`. Copy one photo and one video into `/srv/meyou/library/Photos` and `/srv/meyou/library/Videos` first (the server rescans every 5 minutes; `sudo ./setup.sh update` scans at once).
- [ ] The update finishes on the VPS without `apt` (ffmpeg and sharp come from npm). Note how long the build took and if it timed out: it now downloads about 110 MB of npm packages.
- [ ] `curl $B/ping` shows `"features":["media"]`. The old token still works (`curl -H "$H" $B/me`).
- [ ] `docker compose logs meyou-server` shows `library scan finished` with the number of added files and no token.
- [ ] `curl -H "$H" "$B/tree?root=Photos"` lists your photo with `width` and `height`; the video in `Videos` has `duration`, `width`, `height`.
- [ ] `curl -H "$H" -o t.jpg "$B/items/<id>/thumb?size=256"` gives a small picture (open it); the same for the video id gives a frame of the video.
- [ ] `curl -H "$H" -H "Range: bytes=0-99" -D - -o /dev/null "$B/items/<video id>/file"` answers `206` with `Content-Range: bytes 0-99/<size>`.
- [ ] Without the header every one of these answers `401`.
- [ ] A phone photo in HEIC format: the thumbnail either works or answers `415` (HEVC-encoded HEIC is not supported; JPEG, PNG, WebP, MP4, MOV, WebM are).
- [ ] After `sudo ./setup.sh update` the data and token are kept: the app still connects without adding the server again.
- [ ] S2 line after this update: the app's connection test now lists the feature "Media" instead of the note "only the connection for now" (nothing else changes in the app until S4).

## S4 — Server in the Archive (on a real Android phone, with the new APK; the server needs NO update)
Put a few test files on the VPS first: 3+ photos (one portrait JPEG, one PNG), one short MP4, one MOV if you have it, one folder inside `Photos` with a few pictures. Wait up to 5 minutes (or `sudo ./setup.sh update`/restart) so the server rescans.
- [ ] Settings now shows "Sources". Open it: your saved server is listed as "Personal server" with a switch (on). "Test" shows the connected line. "Backup & restore" and "Partner & notifications" are still not in Settings.
- [ ] Archive > Folders shows `Photos` and `Videos` from the server next to the phone's folders. Open `Photos`: sub-folders first, then thumbnails; scrolling is smooth and thumbnails appear.
- [ ] Open a photo: the preview appears; pinch-zoom and swipe to the next photo work. The portrait photo is the right way up.
- [ ] Open the video, tap play: it starts quickly (does not download the whole file first), the picture and sound work, and **seeking** (drag the bar to the middle and near the end) works.
- [ ] Settings > Media & cache > video mode "download first" plays the video from the phone copy; "stream" streams it. Data saver on gives smaller previews.
- [ ] Select a server photo > "Make available offline"; turn on airplane mode: the photo still opens. Remove the offline copy; with airplane mode on it now shows a message instead of a picture.
- [ ] Airplane mode on, Archive > refresh: a notice says the server could not be reached; phone folders still list normally and the notice is not shown for phone-only problems.
- [ ] Wrong token (edit the server's token in My servers, or revoke it later in S11): Archive shows "The server did not accept the token..." in red; fix the token and refresh: files return.
- [ ] Delete a file on the VPS (`rm` in `/srv/meyou/library/...`), wait for the rescan and open its old thumbnail from a stale list: the viewer says "This file is no longer on the server."
- [ ] A server-only item shows the cloud badge. (A file that is on the phone AND the server is shown once with the "backed up" badge only when name, size and date are identical; otherwise it appears twice. Uploads in S5/S6 keep the date.)
- [ ] Switch language fa <-> en: the new notices read correctly and are right-to-left in Persian.
- [ ] Favourites, tags and albums on a server photo still work after restarting the app.
- [ ] Nothing about upload or backup is reachable yet (S5/S6).

## S5 — Resumable upload (on the VPS, after `sudo ./setup.sh update`; the app needs no new APK to test the server)
Use your own address and token. `B=https://maryafox.ir:18443/api/v1` and `H="Authorization: Bearer <token>"`. Make a small test file (`head -c 3000000 /dev/urandom > t.bin`, and `md5sum t.bin`).
- [ ] `sudo ./setup.sh update` finishes (no new packages are downloaded in S5, so it should be fast) and the app still connects without adding the server again. `curl $B/ping` shows `"features":["media","upload"]`. The app's connection test now lists "Upload".
- [ ] Create: `curl -H "$H" -H "Content-Type: application/json" -d '{"name":"t.bin","size":3000000,"rootId":"Photos","path":"qa/test","md5":"<md5 of t.bin>"}' $B/uploads` answers `{"uploadId":"...","offset":0}`. Running the same command again returns the same `uploadId`.
- [ ] First chunk: `head -c 1048576 t.bin | curl -X PATCH -H "$H" -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" --data-binary @- $B/uploads/<id>` answers `{"offset":1048576}`. Repeating it with the same `Upload-Offset: 0` answers `409` with `"offset":1048576`.
- [ ] Rest: send the remaining bytes with `Upload-Offset: 1048576` (`tail -c +1048577 t.bin | curl ... --data-binary @-`), then `curl -X POST -H "$H" $B/uploads/<id>/complete` answers an item named `t.bin`. `md5sum /srv/meyou/library/Photos/qa/test/t.bin` equals the md5 above; `ls /srv/meyou/uploads` is empty.
- [ ] `curl -H "$H" "$B/tree?root=Photos&path=qa/test"` lists `t.bin` immediately (no 5-minute wait). The file's owner on disk is uid 1000.
- [ ] Upload the same name again: the second file is `t (1).bin`, the first is untouched.
- [ ] Wrong md5 at create (change one digit) and send all bytes: `complete` answers `422` and no file appears.
- [ ] Without the header every one of these answers `401`; `curl -X DELETE -H "$H" $B/uploads/<id>` answers `404` (there is no delete).
- [ ] Interrupt a big upload: `head -c 300000000 /dev/urandom > big.bin`, start it with a small script or `curl` and press Ctrl-C in the middle; the POST from step 2 (with the new name/size) returns the offset that the server really has; sending from there and completing gives a file with the same md5.
- [ ] `docker compose logs meyou-server` shows `upload completed` lines (no token, no file names) and `df -h /srv/meyou` shows the space used as expected.
- [ ] Restart (`sudo ./setup.sh update` or `docker compose restart meyou-server`) in the middle of an unfinished upload: after the restart the same POST returns the same `uploadId` and offset.
- [ ] Optional: stop the test by pushing a file bigger than the free space (or set `UPLOAD_MIN_FREE_MB` very high in `.env`): create answers `507` and nothing is left in `/srv/meyou/uploads`.
- [ ] The Archive in the app (S4) shows the new folder `qa/test` and its file (thumbnail only for pictures; `t.bin` is a plain file) after a pull-to-refresh; the existing photos still open.

## S6 — Backup in the app (needs a NEW APK from GitHub: two new native modules; server unchanged, must be on S5 or later)
Prepare: a phone with the Camera folder holding some photos and videos, the server connected (S2), Wi-Fi on. Use a spare folder or a copy first; backup never deletes anything, but test on a small set first.
- [ ] Settings now shows "Backup & restore". It has: Back up now, Upload queue, switches for Photos and Videos, "Where from" (Camera / All albums / Chosen albums), and When: Automatic backup (off), Wi-Fi only (on), Only while charging (off). The text says nothing is ever deleted.
- [ ] Tap "Back up now": the gallery permission is asked (allow). A message says how many new items were queued and the Upload queue screen opens with a progress bar per file. The summary card shows checked / already on the server / uploaded / waiting / failed.
- [ ] On the VPS: photos are in `/srv/meyou/library/Photos/<year>/<month>/` and videos in `/srv/meyou/library/Videos/<year>/<month>/` (month as 01..12, by the photo's date); `md5sum` of a few files equals the phone's copies; the files' dates (`ls -l`) are the photos' dates, not today.
- [ ] Archive (S4) now shows those folders; a backed-up photo that is also on the phone appears once with the "backed up" badge (if your "remove location and EXIF" setting is on, photos are re-encoded first and show twice; that is expected).
- [ ] Tap "Back up now" again: "Everything on this phone is already on the server" (nothing queued, no duplicates like `IMG (1).jpg` on the VPS).
- [ ] Take a new photo, tap "Back up now": only that one is uploaded.
- [ ] Photos off, Videos on: only videos are queued (and the reverse). Both off: a message asks to turn one on.
- [ ] "Chosen albums": the "Choose albums" row appears; tick one album (for example WhatsApp Images); only its files are queued. With no album ticked the message says no folder matches.
- [ ] **Big backup:** copy a ~300 MB video and ~200 photos into the Camera folder (or pick a folder that has them), keep the app open and tap "Back up now" on Wi-Fi. All are uploaded; the screen shows progress; the summary ends with 0 failed. `md5sum` on the VPS equals the phone's for the video and a sample of photos.
- [ ] **Airplane mode:** while the big video is at about 30%, turn airplane mode on for ~20 seconds, then off (Wi-Fi back). The card says "Waiting for an internet connection…", nothing is marked failed, and when the network is back the upload continues by itself and the final file's md5 is correct (check `/srv/meyou/uploads` is empty at the end).
- [ ] **Wi-Fi only:** turn Wi-Fi off but keep mobile data on, start a backup: files are queued but the card says "Waiting for Wi-Fi (mobile data is not used)…" and your mobile data counter does not move. Turn Wi-Fi on: it continues. Turn the "Wi-Fi only" switch off: it uploads over mobile data.
- [ ] **Pause / Resume:** in the middle of the big video tap "Pause": the bar stops within a second or two, the file is not marked failed. "Resume" continues (the server keeps what it had; upload does not restart from 0).
- [ ] Kill the app (swipe it away) in the middle of an upload, open it again: the queue still lists the files; tapping Resume (or "Back up now") continues and finishes.
- [ ] Charging rules: turn on "Only while charging", unplug: the card says "Waiting for the charger…"; plug in: it continues. With the switch off and the battery under 20% (not charging) it says the battery is low (hard to test; optional).
- [ ] **Automatic backup:** turn it on, take a photo, leave the app and come back (or reopen it) after a minute: the photo is queued and uploaded by itself on Wi-Fi (at most one automatic scan every 30 minutes, so wait for it or use "Back up now"). With it off nothing is scanned by itself. Closing the app stops uploads until it is opened again (there is no background service by design).
- [ ] Stop the server container in the middle of an upload (`docker compose stop meyou-server`): the app keeps trying (retries with growing waits) and does not crash; start it again: the upload finishes. If it stays down longer than about 15 minutes the file shows "Failed"; "Retry failed" or the next "Back up now" resumes it.
- [ ] Wrong token (edit it in My servers): files fail with the "did not accept the token" text and are not retried by themselves; fix the token and tap "Retry failed".
- [ ] An older server without `upload` (not likely now) shows "This server does not accept uploads yet. Update the server".
- [ ] Persian: switch the language to fa: all the new rows, the album screen, the summary card and the waiting messages are in Persian with Persian digits and the layout is right-to-left.
- [ ] Nothing on the phone or the server is ever deleted by backup (check a few originals are still in the phone's gallery and the VPS).

## S7 — Partner API (server only; NO new APK; update the VPS with `sudo ./setup.sh update`; the app uses it from S8)
Prepare: `B=https://maryafox.ir:18443/api/v1`, `OWNER=<the owner token from setup.sh init>`. Everything below is run with `curl` on any machine (the app has no screen for it yet). Nothing was run on your VPS or in Docker by the AI.
- [ ] `sudo ./setup.sh update` finishes; your owner token still works (`curl -H "Authorization: Bearer $OWNER" $B/me`) and your photos, uploads and library are still there (the database got one new table, nothing was reset).
- [ ] `curl $B/ping` shows `"features":["media","upload","mailbox"]`.
- [ ] `curl -X POST -H "Authorization: Bearer $OWNER" $B/invites` returns `code`, `expiresAt` (30 minutes ahead) and a link `meyou://join?url=https%3A%2F%2Fmaryafox.ir%3A18443&code=...` (the url must carry port 18443).
- [ ] `curl -X POST -H 'content-type: application/json' -d '{"code":"<CODE>","deviceName":"Test phone"}' $B/join` returns `deviceId` and `token` (save it as `MEMBER`). Running the same command again answers `{"error":"invalid_code"}`. `/me` with `$OWNER` now lists the partner "Test phone".
- [ ] `POST $B/invites` again answers `{"error":"household_full"}` (a third device is refused).
- [ ] Send: `curl -X POST -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' -d '{"t":"mood","from":"a","ts":"2026-10-17T10:00:00Z","emoji":"😊","intensity":3}' $B/mailbox` -> `{seq,time}`. `GET $B/mailbox?since=0` with `$MEMBER` shows it; with `$OWNER` shows nothing (no echo). Send one back with `$MEMBER`; only `$OWNER` sees it.
- [ ] Live: with `websocat` or any WebSocket tool, connect to `wss://maryafox.ir:18443/api/v1/mailbox/ws` with the header `Authorization: Bearer $MEMBER`: you get `{"type":"ready",...}`; a message sent from the owner arrives at once. Without the header (or with `?token=` in the URL) the answer is 401. Behind Caddy it stays open for minutes (the server pings every 30 s).
- [ ] Unpair: `curl -X DELETE -H "Authorization: Bearer $OWNER" $B/devices/<MEMBER deviceId>` -> `{"revoked":true}`; the open WebSocket closes and `$MEMBER` now gets 401 everywhere. An invite can be created again.
- [ ] `docker compose logs meyou-server` (or `./setup.sh logs`) contains no token and no invite code.
- [ ] Optional: send 3 messages, restart the server (`sudo ./setup.sh update`), and `GET /mailbox?since=0` still returns them (they live in the database).

## S8 — Partner in the app (install a new Android APK; S7 mailbox API required)
Prepare: the S7 server API must be available at `https://maryafox.ir:18443`. If S7 has not been deployed yet, update with `sudo ./setup.sh update`; S8 itself makes no server or database changes. Install the new app build on two Android phones.
- [x] Local integration: two app-side `MailboxClient`/`MailboxListener` instances paired against a real local server; invite/join, live status/event/profile delivery in both directions, no echo, offline replay after reconnect, unpair/revoke, revoked token rejected, and third-device refusal passed.
- [x] Local checks: app `pnpm exec tsc --noEmit`, complete `pnpm test`, and `pnpm exec expo export --platform android` passed.
- [ ] On the user's VPS, `sudo ./setup.sh update` (if needed) preserves the existing owner token, library files and mailbox data; `GET /api/v1/ping` still reports `mailbox`. This was not run by the AI.
- [ ] On phone A, Settings > My servers > Test succeeds over HTTPS port 18443; Home > Connect Partner opens the invite flow; choose the saved server and create an invite. QR and link show the server's `:18443` address, expire as shown, and contain no bearer token.
- [ ] On phone B, scan phone A's QR, then repeat using the paste-link path. Enter a device name; a successful join pairs the phones and shows each partner name.
- [ ] With both apps open, save a status on A and verify it appears on B; send a normal event each way and verify it appears on the other phone; send/update profile and verify the greeting/profile reaches the other phone. Surprise events must never be sent.
- [ ] Close/reopen either app and confirm mailbox replay does not duplicate previously handled messages. With the server unavailable, local Status still saves; when reconnected, the app recovers.
- [ ] Unpair from the owner phone: the partner loses access and returns to the unpaired state; the owner's personal-server token and server files remain. Unpair from the member phone: that member token is revoked and the owner remains connected.
- [ ] Switch to fa and verify invite/join/error text and layout are Persian and RTL. Confirm the old ntfy guide/pairing flow is not reachable from normal navigation.
- Not run by the AI: Docker build, the user's VPS/own certificate, or physical Android phones. The app-only local integration tests do not replace these manual checks.

## S9 — Push (server only; NO new APK; the app registers its token in S10)
Prepare: the Firebase service-account JSON on the VPS (not in the repo, not in chat). Nothing below was run on your VPS or in Docker; the AI could only test with a fake FCM and a fake key.
- [ ] Copy the key to the VPS and run `sudo ./setup.sh push-key ~/key.json`: it restarts the server and prints `Credentials OK. Firebase project: <your project id>` (the id must be the project of `google-services.json`).
- [ ] `curl https://maryafox.ir:18443/api/v1/ping` now shows `"features":["media","upload","mailbox","push"]`.
- [ ] Your owner token and the library still work after the update (`GET /me`); `ls -l secrets/` shows `service-account.json` owned by uid 1000, mode 640.
- [ ] `sudo ./setup.sh logs meyou-server` shows `push enabled (FCM)` with the project id, and no key text anywhere.
- [ ] Wrong cases (optional): rename the key file and restart: the server still runs, `/ping` has no `push`, the log says `push disabled` with a reason.
- [ ] Manual token check (needs a real FCM token, e.g. from S10): `PUT $B/push/token` `{"fcmToken":"...","lang":"fa"}` returns `{"registered":true}`; `sudo ./setup.sh push-test` shows `sent to ...`; a phone with the app closed shows the notification. **This one needs S10.**
- [ ] After S10: send a status from phone A; phone B (app closed) shows a generic notification (no emoji/text of the status) in Persian when B's app language is Persian. Profile and unpair arrive silently.
- [ ] Uninstall the app on B, send a status from A, check the log: the token is rejected once and removed (`push token rejected by FCM and removed`); the next message sends nothing to B.
- Not run by the AI: Docker build, the VPS, Google FCM, phones.

## S10 — Push in the app: token, notification, tap, no foreground service (use the APK built after S10 part 2; nothing below was run on a device)
Prepare: GitHub secret `GOOGLE_SERVICES_JSON` = `base64 -w0 google-services.json` (the Firebase Android app must have package `ir.maryafox.meyou`). The server must have the key (S9 QA) so `/ping` shows `push`.
- [ ] The workflow step "Write google-services.json from the secret" is green; with the secret missing or from another package it stops with a clear `::error::` line.
- [ ] After pairing, Android 13+ asks for the notification permission once (not twice). Allow it.
- [ ] On the VPS: `sudo ./setup.sh push-test` prints `sent to "<phone name>"` for each paired phone and the phone shows the test notification (this proves token + channel + Firebase project all match).
- [ ] Change the app language and restart the app: the next push text is in the new language.
- [ ] Unpair: `sudo ./setup.sh push-test` no longer lists that phone.

**Added in part 2** (tap, foreground, no double notification, no foreground service, Settings):
- [ ] **Two phones (A and B), both paired, both with notifications allowed.** Close B completely (swipe it away from recents). From A send a status: B shows **one** generic notification (title `meYou`, no emoji and no text of the status). Send an event from A: same, one notification.
- [ ] While B is closed, pull down the notification shade on B: **no persistent notification exists** (nothing like "Listening for your partner's messages"). Settings > Apps > meYou > Notifications lists only the channel "Partner messages" (no "Background connection").
- [ ] Tap that notification on B: meYou opens and the new status/event is already there (a mailbox sync ran). Repeat from a cold start (B closed) and from the background (B open in recents).
- [ ] Open B by its icon (no tap on the notification) after A sent something: the status is there and **no second notification** appears for it.
- [ ] B open in the foreground, A sends a status: B shows **one** notification (the app's own), not two; the status appears in the app.
- [ ] A changes the profile (name/avatar) while B is open: B updates and shows nothing. A unpairs while B is open: B returns to the unpaired state and shows the one "partner unpaired" notice.
- [ ] Phone without notification permission (deny it): Settings > Partner & notifications shows "Blocked: allow notifications"; allow it in Android settings, return to meYou, tap "Check again": the state becomes "On". A server without the Firebase key shows "Your server has no push set up".
- [ ] Settings has no background-notification switch and no battery-optimization button; only the optional hint text under the push state. There is no "send test push" action (the server has none; use `sudo ./setup.sh push-test`). The local "Send test notification" row still works.
- [ ] Known limits to confirm, not bugs: turning off "Status"/"Events" notifications in Settings does not stop the system notification of a closed app (the server does not know the setting; planned for S11); a `profile`/`unpair` push does nothing while the app is closed (it is synced when the app opens).
- Not run by the AI: Gradle build, any device or emulator, real FCM delivery, the GitHub workflow.

## S11 part 1 — Hardening (server)
Run on the VPS after `sudo ./setup.sh update` (the app needs no new APK for this part).
- [ ] `sudo ./setup.sh status` shows `meyou-server` as **healthy** after about 30 seconds; `docker compose ps` lists both containers `Up`. Reboot the VPS: both come back by themselves.
- [ ] `sudo ./setup.sh devices` lists both phones (owner + member) with a recent "seen" time and `push:yes` for a phone that registered; no token or hash is printed.
- [ ] Wrong token: from a computer (not the phones' network) run `for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " -H "Authorization: Bearer badtoken-number-$i-xxxxxxxx" https://YOUR-DOMAIN/api/v1/me; done`: the first 10 answer 401, then **429** (`locked_out`). `https://YOUR-DOMAIN/api/v1/ping` still answers. After 15 minutes (or `docker compose restart meyou-server`) the address is free again; a phone on the *same* network meanwhile sees the "busy" message in Settings > Server connection. `sudo ./setup.sh logs meyou-server` shows `address locked after repeated bad tokens` and **no token text**.
- [ ] Logs hold only routes like `/api/v1/items/:id/thumb`, never file names, ids, queries or tokens (look at a minute of `sudo ./setup.sh logs meyou-server` while browsing the Archive).
- [ ] Rotate: `sudo ./setup.sh rotate-token` prints a new link and QR for the owner. The old owner phone gets "The server did not accept the token" (within 30 seconds its live partner connection also drops). Remove that server entry in the app, add the new link: Archive, backup and partner messages work again. The member phone is unaffected.
- [ ] Revoke: `sudo ./setup.sh revoke <member id>` (id from `devices`): that phone gets the token message; the owner stays; `sudo ./setup.sh revoke <owner id>` while only one device is left is refused ("only active device").
- [ ] Backup: `sudo ./setup.sh backup` creates `/srv/meyou/backups/meyou-*.sqlite`; running it 16 times keeps 14. Restore on a spare folder or VPS with the commands in `README.md` > Backup and restore: the restored server knows both phones (their old tokens work).
- [ ] Update twice in a row (`sudo ./setup.sh update`; again): data, tokens and the library are unchanged and the second run changes nothing in the database.
- Not run by the AI: Docker (no daemon in the sandbox: the compose `healthcheck`, `depends_on: service_healthy` and log options were checked only as valid YAML; the health command itself was run against the built server), the VPS, a phone.

## S11 part 2 (steps 1–3) — App cleanup and revocation texts
Needs a new APK (app code changed). Server unchanged.
- [ ] Settings > Server connection > Test on a server that is locked out (from another computer send 12 requests with bad tokens, see S11 part 1, then press Test on the phone within the lockout time): the red line is the "server is limiting requests" text, followed by "Try again in N seconds" (Persian digits in fa). After the time passes, Test works again **without** adding the server again (address and token are still saved).
- [ ] Same state in the Archive: a notice with the busy text appears, not "token not accepted"; Refresh works after the wait.
- [ ] Remove a server (Settings > Server connection > remove, and Settings > Sources > remove on the server row): the question says photos on the server stay, that removing does not revoke the token and that a revoked token needs a new link. Read it in fa (RTL) and en. Check on the server that no file disappeared.
- [ ] Partner phone whose token was revoked (`sudo ./setup.sh revoke <id>` while its app is open, or `rotate-token` for the owner): within about 30 seconds the Status tab shows the "token not accepted" notice with "Open Server connection"; the link opens Settings > Server connection; the pairing is **not** wiped; Unpair still works and then clears it. After adding the new link (owner) and reopening meYou the partner connection is back.
- [ ] Settings > Partner: no ntfy text anywhere (no "ntfy server", no setup guide row); pairing is only by invite link/QR.
- Not run by the AI: a phone, the VPS, Docker. Automated: asserts in `scripts/test-server-connect.mjs`, `test-library.mjs`, `test-mailbox-client.mjs`; the live test runs the real server.

## S11 part 2, steps 4–6 — Privacy/Terms screens and the push opt-out
Needs the **new APK** and the VPS updated with `sudo ./setup.sh update` (database migration 5 runs at start). Nothing below was run on a phone or the VPS; the server tests of this part were also not run (no network in that chat), so first run `npm ci && npm test` in `server/meyou-server` (expect the new `push.test.ts` cases to pass) and the root checks.
- [ ] After the update `sudo ./setup.sh logs meyou-server` shows no migration error, `sudo ./setup.sh devices` still lists both phones, and both phones keep working with their old tokens.
- [ ] Settings > Legal > Privacy policy and Terms of use, in Persian and in English: every section appears and scrolls to the end, RTL is right in fa, nothing is cut at a large font; the text matches this server (30 days / 1000 messages, FCM generic text, the revoke commands, lockout, logs).
- [ ] Run `sudo ./setup.sh devices` and `sudo ./setup.sh revoke <id>` exactly as the Privacy policy names them (use a spare device id): the commands exist and do what the text says.
- [ ] Opt-out, status: on phone B (app closed) switch "Mood updates" off in Settings > Partner & notifications (open the app, switch, then close it); from phone A send a status: B shows no system notification; opening B shows the status. Switch it on again: the next status notifies. `sudo ./setup.sh logs meyou-server` shows no token text.
- [ ] Opt-out, events: the same for "Events" with an event from A. Status and events still arrive in the app in both states.
- [ ] Opt-out survives: switch a type off, restart the phone and open the app once: the switch is still off and a new message still sends no push. Switch both off, then send an `unpair` (A unpairs): B still processes it when opened.
- [ ] Old APK with the updated server: the old app registers without `notify` and still gets both pushes (default on).
- Not run by the AI: a phone, the VPS, Docker, the server test suite and the root test chain of this part (see the S11 log entry in `docs/SERVER_PHASES.md`).
