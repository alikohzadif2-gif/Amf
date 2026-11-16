import type { SQLiteDatabase } from 'expo-sqlite';

export async function initializeDatabase(database: SQLiteDatabase) {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (
      1,
      'phase-1-bootstrap',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
  `);
  await migrateLibrary(database);
  await migrateMood(database);
  await migrateEvents(database);
  await migrateStatus(database);
  await migrateEventDetails(database);
  await migrateDiary(database);
  await migrateEventShare(database);
  await migratePeriod(database);
  await migrateDiaryCategories(database);
  await migrateDiaryShare(database);
  await migrateDiaryReplies(database);
  await migrateStories(database);
  await migrateChat(database);
  await migrateReactions(database);
  await migratePartnerMedia(database);
  await migrateVault(database);
  await migrateOriginals(database);
  await migrateSync(database);
}

/** Phase 3: library tables (favourites, tags, manual albums, offline copies). */
export async function migrateLibrary(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS media_items (
      key TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime TEXT NOT NULL,
      md5 TEXT,
      mime TEXT,
      width INTEGER,
      height INTEGER,
      duration REAL,
      refs TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      key TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS item_tags (
      key TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (key, tag_id)
    );
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      offline INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS album_items (
      album_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (album_id, key)
    );
    CREATE TABLE IF NOT EXISTS offline_items (
      key TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      uri TEXT NOT NULL,
      size INTEGER NOT NULL,
      simulated INTEGER NOT NULL DEFAULT 0,
      saved_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (2, 'phase-3-library', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/** Phase 7: mood history (mine and my partner's). `msg_id` is the mailbox message id (`seq`) or a local id, used to drop duplicates. */
export async function migrateMood(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS moods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT UNIQUE,
      from_me INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      text TEXT,
      intensity INTEGER NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_moods_ts ON moods (ts);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (3, 'phase-7-mood', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/** Phase 8: shared events (dates, anniversaries). `date` is a UTC ISO date; `cal` is the calendar a yearly repeat follows. */
export async function migrateEvents(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      repeat TEXT,
      cal TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      media_key TEXT,
      from_me INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events (date);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (4, 'phase-8-events', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * U13: a status can carry an activity (id from `src/partner/activities.ts`). Old rows keep NULL.
 * `ALTER TABLE ... ADD COLUMN` is not idempotent, so the column is checked first.
 */
export async function migrateStatus(database: SQLiteDatabase) {
  const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(moods)');
  if (!cols.some((c) => c.name === 'activity')) await database.execAsync('ALTER TABLE moods ADD COLUMN activity TEXT;');
  await database.execAsync(`
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (5, 'u13-status', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * U16: events get a description, an icon id (see `src/events/icons.ts`) and a surprise flag (never published to the partner).
 * Old rows keep NULL / NULL / 0. Columns are checked first because `ADD COLUMN` is not idempotent.
 */
export async function migrateEventDetails(database: SQLiteDatabase) {
  const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(events)');
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has('description')) await database.execAsync('ALTER TABLE events ADD COLUMN description TEXT;');
  if (!has('icon')) await database.execAsync('ALTER TABLE events ADD COLUMN icon TEXT;');
  if (!has('surprise')) await database.execAsync('ALTER TABLE events ADD COLUMN surprise INTEGER NOT NULL DEFAULT 0;');
  await database.execAsync(`
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (6, 'u16-events', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}


/** U19: local diary entries. Media references stay as JSON keys; originals remain in their existing storage source. */
export async function migrateDiary(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS diary (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      mood TEXT,
      body TEXT NOT NULL DEFAULT '',
      media_keys TEXT NOT NULL DEFAULT '[]',
      saved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diary_created_at ON diary (created_at);
    CREATE INDEX IF NOT EXISTS idx_diary_category ON diary (category);
    CREATE INDEX IF NOT EXISTS idx_diary_saved ON diary (saved);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (7, 'u19-diary', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * R2: an event photo no longer goes through the Library. `photo_uri` = this phone's private copy (app documents folder),
 * `photo` = the server path `Shared/<id>/<name>` the partner reads (contract D.13). Old rows keep NULL / NULL.
 */
export async function migrateEventShare(database: SQLiteDatabase) {
  const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(events)');
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has('photo_uri')) await database.execAsync('ALTER TABLE events ADD COLUMN photo_uri TEXT;');
  if (!has('photo')) await database.execAsync('ALTER TABLE events ADD COLUMN photo TEXT;');
  await database.execAsync(`
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (8, 'r2-event-share', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * R5a: period log (mine and my partner's). `kind` = started | pain | better (the `period` message kinds), `day` = UTC day
 * ("YYYY-MM-DD") it refers to. One row per (owner, kind, day); `msg_id` = mailbox `seq` or a local id.
 */
export async function migratePeriod(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS period_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT UNIQUE,
      from_me INTEGER NOT NULL,
      kind TEXT NOT NULL,
      day TEXT NOT NULL,
      ts TEXT NOT NULL,
      UNIQUE (from_me, kind, day)
    );
    CREATE INDEX IF NOT EXISTS idx_period_day ON period_events (day);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (9, 'r5a-period', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/** R6: custom diary categories (created and deleted by the user). Built-in ids and "none" live in code, not in this table. */
export async function migrateDiaryCategories(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS diary_categories (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (10, 'r6-diary-categories', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * R8a: a memory can come from the partner. `from_me` = 0 for a received copy (never sent back, never deleted by a later
 * message of ours); `shared_media` = how many photos/videos the sender's memory has (shown as "N attachments" until R8b).
 */
export async function migrateDiaryShare(database: SQLiteDatabase) {
  const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(diary)');
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has('from_me')) await database.execAsync('ALTER TABLE diary ADD COLUMN from_me INTEGER NOT NULL DEFAULT 1;');
  if (!has('shared_media')) await database.execAsync('ALTER TABLE diary ADD COLUMN shared_media INTEGER NOT NULL DEFAULT 0;');
  await database.execAsync(`
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (11, 'r8a-diary-share', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * Replies under a memory (both partners can write; `from_me` = 0 for the partner's). A reply is removed with its memory.
 * They travel as `diary` messages with `replyTo` (no new server message type, so no VPS update).
 */
export async function migrateDiaryReplies(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS diary_replies (
      id TEXT PRIMARY KEY NOT NULL,
      memory_id TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 1,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diary_replies_memory ON diary_replies (memory_id, created_at);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (12, 'diary-replies', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/** Phase 4: 24-hour stories (mine and, later, the partner's). Media lives in the app's documents folder; rows are purged after `expires_at`. */
export async function migrateStories(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL,
      media_uri TEXT NOT NULL,
      overlay_text TEXT,
      overlay_y REAL NOT NULL DEFAULT 0.5,
      caption TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      viewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories (from_me, expires_at);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (13, 'stories', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * Direct chat (text only). `from_me` = 0 for the partner's messages. `state` is `sent` or `failed` (mine that did not reach the
 * server yet: the chat shows a retry). A message travels as a `chat` mailbox message with the same `id`.
 */
export async function migrateChat(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 1,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'sent'
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages (created_at, id);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (14, 'chat-messages', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
  // Read marks: `read` = I have opened the chat since this partner message arrived (rows from before this change count as read);
  // `seen` = the partner has read this message of mine. `ADD COLUMN` is not idempotent, so the columns are checked first.
  const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(chat_messages)');
  if (!cols.some((c) => c.name === 'read')) await database.execAsync('ALTER TABLE chat_messages ADD COLUMN read INTEGER NOT NULL DEFAULT 1;');
  if (!cols.some((c) => c.name === 'seen')) await database.execAsync('ALTER TABLE chat_messages ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;');
}

/** Direct chat can carry one photo/video (a library item or a shared upload); likes and comments under a library item, mine and the partner's. */
export async function migrateReactions(database: SQLiteDatabase) {
  const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(chat_messages)');
  if (!cols.some((c) => c.name === 'item')) await database.execAsync('ALTER TABLE chat_messages ADD COLUMN item TEXT;');
  if (!cols.some((c) => c.name === 'media')) await database.execAsync('ALTER TABLE chat_messages ADD COLUMN media TEXT;');
  if (!cols.some((c) => c.name === 'media_type')) await database.execAsync('ALTER TABLE chat_messages ADD COLUMN media_type TEXT;');
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS media_likes (
      item TEXT NOT NULL,
      from_me INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item, from_me)
    );
    CREATE TABLE IF NOT EXISTS media_comments (
      id TEXT PRIMARY KEY NOT NULL,
      item TEXT NOT NULL,
      from_me INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_comments_item ON media_comments (item, created_at);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (15, 'media-reactions', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/** Sharing track, stage 4: index of the encrypted pictures received from the partner (the files are in `meyou-partner-media/`). */
export async function migratePartnerMedia(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS partner_media (
      ref TEXT NOT NULL,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      w INTEGER NOT NULL,
      h INTEGER NOT NULL,
      used INTEGER NOT NULL,
      PRIMARY KEY (ref, kind)
    );
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (16, 'partner-media', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/** Sharing track, stage 5: the private vault (files + the resumable transfer journal). */
export async function migrateVault(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS vault_items (
      id TEXT PRIMARY KEY NOT NULL,
      rel_path TEXT NOT NULL,
      top TEXT NOT NULL,
      size INTEGER NOT NULL,
      md5 TEXT,
      state TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      state_at INTEGER NOT NULL,
      export_uri TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vault_items_live ON vault_items (rel_path) WHERE state = 'hidden';
    CREATE INDEX IF NOT EXISTS vault_items_top ON vault_items (top, state);
    CREATE TABLE IF NOT EXISTS vault_jobs (
      job TEXT PRIMARY KEY NOT NULL,
      mode TEXT NOT NULL,
      roots TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      src_uri TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS vault_queue_job ON vault_queue (job, status);
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (17, 'vault', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * Sharing track, stage 6: originals on request.
 * - `shared_originals`: on the SENDER's phone, where the file behind a shared `ref` is (so the partner can ask for it later).
 * - `partner_orig_transfers`: on the RECEIVER's phone, one row per request that is waiting or arriving (resumes nothing; cleaned when stale).
 */
export async function migrateOriginals(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS shared_originals (
      ref TEXT PRIMARY KEY NOT NULL,
      uri TEXT NOT NULL,
      name TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partner_orig_transfers (
      rid TEXT PRIMARY KEY NOT NULL,
      ref TEXT NOT NULL,
      state TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      chunks INTEGER NOT NULL,
      next INTEGER NOT NULL,
      until INTEGER NOT NULL DEFAULT 0,
      file TEXT NOT NULL,
      updated INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (18, 'partner-originals', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

/**
 * Sharing track, stage 7: the sync state (items by id with hash and field versions, tombstones, hidden hashes, pending edits, clock)
 * as one JSON document. It is small (a few hundred bytes per item) and always read and written whole, so one row is enough.
 */
export async function migrateSync(database: SQLiteDatabase) {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO migrations (version, name, applied_at)
    VALUES (19, 'sync-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}
