# Original file and video on request (sharing track, stage 6)

**What.** A shared photo reaches the partner as thumbnail + preview (stage 4). "Full quality" in the full-screen viewer (`SharedViewer`) asks the sender's phone for the original. Nothing is stored on the server: the file travels as encrypted queue messages (`orig-*`, `src/partner/orig-logic.ts`), 256 KB per chunk, each deleted at the receiver's ACK. Files are sent only through the encrypted queue; there is no plain fallback.

**Flow.** `orig-req {rid, ref}` -> `orig-meta {size, chunks, ext}` (or `orig-nack missing|too-big`) -> `orig-chunk {i, data}` in order. `orig-cancel` stops the sender (no space, gap, person pressed cancel).
- Sender must be online. No answer in 30 s = "the other phone is not online" (`origOffline`). A request older than 3 min is ignored by the sender, so an old tap never starts a transfer later.
- Receiver accepts only transfers it asked for (row in `partner_orig_transfers`); chunks must be in order and of exact length; replays are ignored; free space (file + 50 MB) is checked before the first chunk. Idle 60 s = failed. Unfinished records are cleaned after 24 h.
- Limit: 40 MB per original (`too-big` otherwise). One original is served at a time; a second tap on the same photo joins the first.
- Sender remembers where the file is in `shared_originals` (written when the photo is shared). If the file moved or was deleted: `missing`.

**Cache.** The finished original is a `partner_media` row of kind `original` in `meyou-partner-media/` (private, backup-excluded). It counts towards the cache cap and is evicted by age like previews; thumbnails never. "Clear partner previews" now also removes originals. The viewer shows a cached original instead of the preview.

## Video (second half)
- **Share:** with E2E keys a video is not uploaded. The sender registers the file (`shared_originals`) and sends a poster frame as the thumbnail when the phone can make one (`makeVideoPoster`, expo-video thumbnails); otherwise no poster. A video ref (by extension) always offers "Download video" on the partner's phone, even with no poster.
- **Pull in windows:** the receiver asks for 16 chunks (4 MB) at a time (`orig-req {start, count}`) and asks for the next window when one is applied. The queue never holds more than one window of a transfer, whatever the file size. Limit 1 GiB per video, and the video must fit the partner cache cap (`origCache` message otherwise, checked before the first chunk).
- **Pause / resume:** "Pause" (or a dropped connection, a closed app) keeps the received part file. The next tap continues from the first missing chunk with a fresh request id (so an old `orig-cancel` cannot stop it). The part is kept 24 h.
- **Play:** from the finished file in the private cache (`expo-video`, system controls). The cache cap and "Clear partner previews" apply to videos too.

## Limits (said plainly)
- **No live streaming (decided):** playback starts after the download completes; a progress bar shows how much arrived.
- **No short preview clip:** needs a video transcoder (native library); only the poster frame goes along.
- **Stories and chat use the new path too:** a video sent from a story or the direct chat is not uploaded (`shareFile` -> `shareVideoEncrypted`). The partner's story auto-downloads the video when opened (progress bar `DownloadBar`; leaving the story pauses it, retry button on failure) and plays from the cache; a story an older version uploaded to the server still streams from there. A partner's photo/video in the chat opens in `SharedViewer`. Without confirmed E2E keys the old server upload stays (unchanged).
- Whole-file SHA-256 comes in stage 7 (now: chunk AEAD + order + exact sizes). Not run on a device.
