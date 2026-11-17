# Private vault (sharing track, stage 5)

**What it is.** A folder in the app's private storage (`files/meyou-vault/`). Not in the gallery, not in the file manager, outside Android cloud backup / device transfer (`plugins/with-backup-exclude.js`), deletable only from inside the app. Archive "Source" value: **Vault / گاوصندوق** (name still open, one i18n key: `libSrcVault`). Everything in it is indexed as *hidden*: it stays out of Explore, search, tags and albums and shows only under Archive > Source > Vault (Folders).

**Adding (shared by Archive and the sharing settings):** `app/vault-add.tsx`. Folder chooser (Storage Access Framework) and multi-file chooser; the person picks **Move** or **Copy** before Start.
- Copy: originals stay.
- Move: copy first; the original is deleted only when size AND MD5 match. No checksum on either side, a mismatch, or a failed delete = the original is KEPT and counted ("kept"). Emptied source folders are removed only if truly empty.
- Free-space check before start (copy: total + 200 MB; move: largest file + 200 MB).
- Journal in SQLite (`vault_jobs`, `vault_queue`): pause, or close the app, and continue from the vault screen. Runs only while the app is open.

**Unhide / hide again (`app/vault.tsx`).** Unhide copies a top-level folder/file to a public folder the person picks, verifies size + MD5, then removes the vault copy; the row stays as `exported` (same id). Hide again moves it back and reuses the same id.
Sync behaviour (for stage 7): an `exported` item is *outside* the vault but NOT deleted: no tombstone/delete event goes to the partner, and re-hiding links to the same file id. "Delete for both" is a stage 7 feature.

**Deleting inside the app** (Archive > Vault > select > trash): moves to `.trash/` for 30 days (restore or delete for good on the vault screen; expired items are purged when that screen opens). Only files with a `vault_items` row are touched.

**Warnings shown:** uninstall / clear data deletes the vault; free-space shortage; interrupted transfers are resumable; originals never deleted unverified.

**Not in this stage:** SHA-256 for sync (stage 7; MD5 is used for verification now), default source change (stage 7), gallery (MediaStore) moving with Android 11+ delete prompt (SAF deletes use the folder grant, no prompt).
