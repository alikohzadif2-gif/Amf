# Hash and sync (sharing track, stage 7)

## Done so far
- **Rules:** `src/sync/sync-logic.ts` (pure; `scripts/test-sync-logic.mjs`).
- **SHA-256:** `src/sync/sha256.ts`, incremental plain TypeScript (no native module), checked against Node crypto; `hashSource` reads a file in 256 KB pieces and releases the JS thread between them (`scripts/test-sync-hash.mjs`).
- **Storage:** table `sync_state` (migration 19), the whole state as one JSON row (`src/sync/sync-store.ts`); cleared when unpairing.
- **Messages:** `sync-ev` (up to 50 validated events) and `sync-digest` (one page of the full list, 400 ids, split by sorted id range), both silent, decoded and validated in `src/sync/sync-messages.ts`. One invalid event rejects the whole message. A digest is answered with events only, never with a digest, so two phones cannot loop.
- **Wiring (`manage.ts`):** after a photo or video is shared (encrypted path), it is hashed in the background, added to the sync state under a random id (`folder: Shared`) and an `add` event goes to the partner. At start `syncNow()` sends my digest; the partner answers with what I lack. State changes are serialized. Exports for the next part: `syncItems()` (the badge: an item with both device ids in `holders`), `syncDeleteForMe(id)`, `syncDeleteForBoth(id)`.

## Viewer, integrity and delete (third part)
- **Refs:** an `add` event carries the shared path (`ref`, validated: `Shared/...`, no `..`, no backslash); the item keeps all its paths, so a viewer finds its item and a delete knows what to purge.
- **Whole-file SHA-256 check:** after an original is downloaded and cached, it is hashed and compared with the hash the sender registered. A mismatch deletes the cached file and shows "did not match" (`hash`). A match sends a `have` event; two different devices in `holders` = the badge **"On both phones"** in the viewer. A path with no registered hash is accepted without the check (nothing to compare).
- **Two deletes in the viewer (trash button):** "Delete for me" (local only: my cached pictures go, the hash is hidden so a sync never brings it back, nothing is sent) and "Delete for both" (separate confirmation that says the sender's own file is not deleted; tombstone + event; both phones remove the cached pictures and the sender stops serving the path). If the event cannot be sent now, the item is removed here and the digest repairs the other phone later.
- **Not the user's file:** deleting for both removes the *shared copy*, never the original in the sender's library or gallery. The 30-day trash applies to the vault, not to these shared copies (they are copies; the original still exists). Tell me if you want the receiver's cached copy to go to a trash too.

## Not wired yet
Only files shared through the new path are in the sync state. **Library rename/move events were checked and are moot:** the app has no feature that renames or moves a library file (the library lists files from sources; the only moves are the vault's hide/unhide and trash, which are local by design). When such a feature is added, it should emit `rename`/`move` events; the rules and messages already exist. The two delete actions exist only in the shared viewer; the library lists have no delete.

## Rules

**Conflict rule (decided):** delete for both is final; everything else is last-writer-wins.
1. Each change is an event with a Lamport counter; order = (counter, device id).
2. Name and folder are separate fields, each last-writer-wins.
3. "Delete for both" = tombstone. It beats every edit (even a later one) and blocks the same SHA-256 from returning as a new item for 30 days (the trash period). After the purge the content can be added again.
4. "Delete for me" is local only, never sent; the hash goes on a local hidden list so sync never adds it back.
5. Same SHA-256 under two ids = one file: smaller id kept, the other is an alias; "on both phones" once both sides reported the hash.
6. Events can arrive in any order: an edit before its add waits (last 20 per id) and is replayed. Two phones that saw the same events end identical (tested in both orders).
7. A periodic full-list comparison (id, hash, field versions, tombstones) only produces events; missing ids are asked for through the normal flow.

**Still to do:** a measured run on two real phones (nothing was run on a device), and disabling the old `Shared/` path, which waits for your approval.
