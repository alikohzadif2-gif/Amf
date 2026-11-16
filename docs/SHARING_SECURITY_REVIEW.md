# Security review, stage 6-7 code (first pass)

Scope: the original-file transfer (`orig-*`), the sync (`sync-*`), the hash check and the delete actions (pass 1); then a read-through of the encryption code of stages 1-3 (`src/e2e/*`: envelope, key derivation, key store, queue receive) (pass 2). Pass 3 read the server's encrypted queue (`server/meyou-server/src/e2e`). Pass 4 read the vault code (`src/vault/*`). The pairing screens were **not** reviewed.

## Found and fixed
1. **Plain mailbox could feed sync and file messages.** Anyone holding the household token can write to the old plain mailbox. `handleIncoming` now accepts `orig-*` and `sync-*` only from the encrypted queue (id `e:<envelope id>`); from the plain mailbox they are `invalid` and reach no handler (tested).
2. **State floods.** A partner phone (or a bug) could grow the sync state without limit. Caps: 20,000 items, 200 ids with waiting edits, 20 waiting edits per id, 50 events per message, 400 ids per digest page.
3. **Default source** is now "phone" (was Google Drive), as decided.
4. **Pictures (`media`) from the plain mailbox** are now refused like files and sync (same guard; tested both ways: plain id refused, `e:` id accepted).
5. **The seen list and big transfers.** The replay list keeps 1000 ids and is rewritten in full on every message; thousands of chunks of a video would have pushed real ids out (a replay window for the server) and caused thousands of large writes. `orig-chunk` is no longer recorded (`isTransientMessage`); a replayed chunk is harmless because `receiveOrig` ignores chunks it has and those of finished or unknown transfers.

6. **Push storm from big transfers (server).** Every posted blob sent its own silent wake-up push, so a video would be thousands of pushes (push services throttle senders). `src/e2e/coalesce.ts`: the first silent push goes at once; others within 10 s are merged into ONE trailing push naming the newest blob; visible ("wake") pushes are never merged. Tested (`server/meyou-server/test/coalesce.test.ts`, 2 tests, pass); the full server suite needs its dependencies and was not run.

7. **Vault "move" now compares SHA-256 before an original is deleted.** Until now the original was deleted on equal size plus MD5 (and kept when no checksum existed). In move mode both files are now also compared byte for byte with SHA-256 (`compareSources`): `different` discards the copy and keeps the original (`hash-mismatch`); `unknown` (a file could not be read completely, or a short read) keeps the original (`unverified`). Copy mode is unchanged and never deletes. Tested for one flipped bit in the last byte, different sizes, read errors and short reads. The move itself is slower for big files (both are read once more); not measured on a device.

## Vault read-through (no other change needed)
- An original is deleted only on a `delete` verdict (size and checksum equal); no checksum means the original stays; a failed delete (e.g. a picked file the app cannot delete) is reported as kept.
- Paths are safe by construction: no empty, `.`, `..` or dot-prefixed segment, no leading slash; a copy with a wrong size or checksum is removed; a half-written copy from an interrupted run is replaced.
- Deleting inside the app moves a file to `.trash/` for 30 days (restore possible, name conflicts resolved with a unique path), purges only trashed items the vault knows, and only after the 30 days.

## Server queue read-through (no change needed)
- Input checks before any decoding: id and base64url shape, size on the text first (413), a recipient queue cap (256 MB, 507) and a 30-day TTL pruned on post and hourly.
- A repeated id from the same device returns the first row (idempotent post); ACK deletes only the caller's own rows, at most 200 per call; list answers at most 50 blobs / 4 MB per call.
- The server stores only opaque bytes plus sender, recipient, time and size; blobs and ids are not logged.
- Rate limit is 300 requests a minute on queue routes, so a transfer tops out near 75 MB a minute (256 KB chunks); a 1 GiB video takes about 15 minutes at best, and a 429 in the middle ends that window (the receiver then resumes). Not measured on a real server.

## Read-through of stages 1-3 (no change needed)
- Primitives are libsodium only: XChaCha20-Poly1305 with a fresh random 24-byte nonce per message (safe without a counter), one key per direction (KDF from the master key), sealed-box for the pairing key with a request nonce check, constant-time compare for the nonce.
- The envelope id sits inside the encrypted part (the server cannot swap ids); padding to 256 bytes hides exact lengths; a changed, truncated or foreign blob returns null and is acknowledged and dropped so it cannot block the queue; an `apply` error is not acknowledged and is retried.
- Keys live only in `expo-secure-store`, never in AsyncStorage, the server or a backup.
- A stale replayed `orig-req` is stopped by the 3-minute freshness check on the timestamp inside the encrypted message.

## Checked and fine (by reading and by tests)
- Files and sync are *sent* only with `sendEncrypted` (`postOrig`, `postSync`): there is no plain fallback for a file or a sync event.
- A receiver accepts a transfer only if it asked for it (record with a random 64-bit request id that travels only encrypted); unasked meta/chunks are ignored; chunks must be in order and of exact length; replays are ignored; free space and cache cap are checked before the first chunk; a resume meta that disagrees with the record fails.
- Names on disk come from the phone's own random ids; the extension is whitelisted (`[a-z0-9]{1,5}`); a partner-supplied path must be `Shared/<folder>/<file>` with no `..` or backslash.
- Whole-file SHA-256 is checked after a download; a mismatch deletes the cached file.
- A stale request (older than 3 minutes) is never served; one transfer is served at a time; the sender checks a cancel between chunks.
- "Delete for both" never deletes the sender's own library or gallery file.
- Logs (`traceEvent`) carry no paths, hashes or names.

## Open risks (not fixed, decide or test)
- **No forward secrecy:** one static master key per pairing (no ratchet). If a phone is lost and the master key leaks, messages still in the server queue (until delivered, at most 30 days) could be read. Re-pairing replaces the key. Keys are also not zeroed from memory after use.
- **The replay list is only 1000 ids,** and a malicious server could replay an old message once it has left the list; sync and file messages are idempotent or timestamp-checked, but chat/mood replays older than that window are not blocked.
- **A partner can abuse tombstones:** a `del-both` with any hash blocks that content from being added for 30 days, also on my phone. Acceptable only because the partner is trusted (paired in person).
- **A partner can spam `orig-req`** to make this phone upload; each is capped by size and served one at a time, but there is no per-hour limit.
- **Abandoned transfers:** undelivered encrypted chunks stay in the server queue up to the 30-day TTL (a window is 4 MB per transfer, so little).
- **Deleted files are not wiped** (normal file delete), and the cache folder is excluded from Android backup but is not encrypted at rest beyond the phone's own storage encryption.
- **Hashing a very large video** in plain JS is slow (seconds per 100 MB, JS thread released between pieces); nothing was measured on a device.
- **Nothing here was run on a device.** Only the pure logic has tests; the screens, file handle writes and video poster are unverified.

## Final re-review (pass 5): fixes and facts
- **Sender retries.** Each chunk post is retried after 2 s, 8 s and 20 s (`withRetry`, tested); a rate limit (429) or a network blip no longer ends a long transfer. The connection is read once per transfer instead of once per chunk (4096 reads for a 1 GiB video).
- **Explicit write mode** for the part file (`FileMode.ReadWrite`) instead of the library default.
- **Syntax check** of every changed TypeScript/TSX file with esbuild: 0 errors. **No type check** (`tsc`, project dependencies missing here), **no lint**, so type errors can still exist; the first `tsc` / Metro run on your machine is the real check. A static scan found no identifier used without an import in the large changed files.
- **Cache size matters for video:** the partner cache default is 300 MB. A video larger than the cap is refused before download (`origCache`), and a big video evicts older cached pictures. Raise "partner cache" in settings for large videos.
- **A fallback that can be slow:** if a file handle cannot be opened (some content:// sources), the reader falls back to reading the whole file per chunk (existing behaviour of `openFileReader`). On a big video that source would be very slow or run out of memory; shared videos should come from real files. Untested.
- **Tombstone side effect:** after "delete for both", sharing the same content again within 30 days still works, but it has no sync record (no hash check, no "on both phones", no delete for both) until the tombstone expires.

## Rules checked against the brief
- No user file is deleted without confirmation and a way back: vault delete goes to a 30-day trash; a move deletes the original only after the SHA-256 check; "delete for both" removes shared copies only after its own confirmation and never the sender's original; "delete for me" removes only this phone's cached pictures.
- Files are never sent through the plain mailbox.

## Still waiting for your approval
Disabling the old `Shared/` server path (it stays active for phones without confirmed keys and for old stories).
