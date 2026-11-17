# meYou

An Android-only, bilingual (Persian RTL / English) local-first app for moods/status, events, a diary, a media archive and privacy tools. Built with React Native, Expo SDK 57, TypeScript and expo-router.

The current app works without an account or a server: then status, events, diary entries, profile and settings stay on the phone and nothing is sent anywhere. Since phase S2 you can optionally connect your own server (`server/meyou-server/`, Settings > Server connection), and since S4 its folders, photos and videos appear in the Archive; backup (S6) and the partner mailbox with push notifications (S8–S10) are on as well; see the [re-enable guide](docs/HANDOFF.md#re-enable-guide) before changing any flag. Google Drive and account sign-in are not part of this project.

- Project rules and decisions: `docs/PROJECT_BRIEF.md`.
- Current code map, flags and handoff notes: `docs/HANDOFF.md`.
- UI phases and Zeydi reference images: `docs/UI_PHASES.md` and `docs/zeydi-ui/`.
- Manual checks for a real Android device: `docs/QA_CHECKLIST.md`.

## 1. Run it on your computer

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

Open the Expo QR code in Expo Go on an Android phone. The web preview is blank by design; this app targets Android only.

## 2. Build an APK

The `preview` profile in `eas.json` produces an installable APK. Create or connect an Expo project once, then build:

```sh
npm install -g eas-cli
eas login
eas init
eas build --platform android --profile preview
```

- Keep the EAS keystore safe; updates must use the same signing key.
- Before a later build for the same installation, increase `android.versionCode` in `app.json`.
- `package.json` pins pnpm 10. For build failures, inspect the EAS log before changing the lockfile or package policy.
- **Push needs Firebase.** Add the GitHub secret `GOOGLE_SERVICES_JSON` (Settings > Secrets and variables > Actions) with the value of `base64 -w0 google-services.json` (the Firebase Android app must have package `ir.maryafox.meyou`). The workflow `.github/workflows/build-apk.yml` writes the file with `scripts/write-google-services.mjs` before `expo prebuild` and stops with a clear message if the secret is missing or for another package. Never commit `google-services.json`. `app.json` expects the file at `./google-services.json`; for a prebuild check only, a fake file made by that script from a fake base64 is enough (delete it and `android/` afterwards).
- The app has no foreground service and no permanent notification: when meYou is closed the partner's messages arrive through push (FCM), which needs the server's Firebase key (`sudo ./setup.sh push-key`, see the server README).
- Local builds are also possible with `npx expo prebuild --platform android` and Android Studio/Gradle; they require a signing key of your own.

## 3. Current feature state

- No meYou account or registration. Since the Drive phase you can optionally sign in with your own Google account (Settings > Google Drive) so the Archive and Explore read and write your Google Drive directly from the phone; the personal server is not involved in that.
- The `FEATURES` values in `src/constants/features.ts` are all `true`: `server` (S2), `serverLibrary` (S4), `serverBackup` (S6) and `partner` (S8).
- Status, events and diary are saved on the phone. When the phone is paired, status, event and profile messages go to the partner through the own server's mailbox (S7/S8); a closed app is woken by push through Google FCM (S9/S10).
- **Privacy Policy and Terms** (Settings > Legal, `app/settings/privacy.tsx` / `terms.tsx`, strings `privacy*` / `terms*` in both languages) describe exactly this: data goes only to the user's own server (photos/videos only with backup on; partner messages kept 30 days / 1000 messages), HTTPS server setup and tokens in Android SecureStore, push through Google FCM with a generic text and no message content, no analytics and no ads, the app never deletes anything on the server, how a phone is revoked (`sudo ./setup.sh devices` / `revoke <id>`), wrong-token lockout and logs without content. **Change these texts in the same phase whenever a data flow changes** (`scripts/test-theme.mjs` checks the key facts in fa and en).
- Settings > Partner & notifications > Notification types (status, events) are also sent to the server (`PUT /push/token`, field `notify`, S11), so a switched-off type sends no push to a closed app; the message still arrives in the app.
- There is no file-sync feature, and the old third-party notification relay is gone: both were removed in S11 (see `docs/HANDOFF.md`).

Historical phase notes in `docs/` may describe removed parts (Google Drive, file sync, the old notification relay); they are not instructions for the current app. The current steps are in `docs/HANDOFF.md`.

## 4. Archive and media

The Archive can read phone media and the app’s own media folder. Gallery choices use the Android system picker; camera photos are copied into the app Archive’s `Snaps` folder. The photo/video picker is reused by Home, profile, events and diary. Diary attachments have no app-imposed item-count limit and are copied without app-side editing or re-encoding. Profile avatars follow the existing 64 px avatar path.

Camera and media access are requested only when the relevant action needs them. The app does not request microphone access for photo capture.

## 5. Days-together widget

After installing an APK, long-press the Home screen > Widgets > meYou > **Days together** (2×2, resizable). It uses the same date/count helpers as Home and follows the saved language, calendar, digits and accent. Android receives light and dark color variants; opening meYou or saving the together-date requests a refresh, and Android may refresh it periodically. The native widget does not run in Expo Go.

## 6. Checks

```sh
pnpm typecheck
pnpm test
npx expo export --platform android
npx expo prebuild --platform android
```

The test command includes calendar, translation parity, storage, library, server, backup and partner adapters, events, security, widget, theme, media, welcome, onboarding, Home, Status and Diary tests. The live-server suite starts the real `server/meyou-server/` when its dependencies are installed (`npm ci` there) and is skipped with a message otherwise.
