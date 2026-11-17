import type { SQLiteDatabase } from 'expo-sqlite';
import { formatDate } from '@/src/lib/calendar';
import type { CalendarMode, DigitMode, Language } from '@/src/state/settings-store';
import { DIARY_NO_CATEGORY } from './categories';
import { isKnownCategory } from './category-db';
import { dayKey, type DayRange } from './date-range';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

export type DiaryRow = {
  id: string;
  title: string;
  /** Built-in id, `none` or a custom category id. */
  category: string;
  mood: string | null;
  body: string;
  /** JSON array in SQLite; local media keys on my memories, `Shared/<id>/...` paths on received copies. */
  mediaKeys: string[];
  saved: boolean;
  /** R8a: false = a copy received from the partner (it is never sent back). Missing = mine. */
  fromMe?: boolean;
  /** R8a compatibility: attachment count from an older partner message that has no shared media paths. */
  sharedMedia?: number;
  /** UTC ISO timestamp. */
  createdAt: string;
  /** UTC ISO timestamp. */
  updatedAt: string;
};

type RawDiaryRow = {
  id: string;
  title: string;
  category: string;
  mood: string | null;
  body: string;
  media_keys: string;
  saved: number;
  from_me?: number | null;
  shared_media?: number | null;
  created_at: string;
  updated_at: string;
};

export type DiaryListOptions = {
  query?: string;
  sort?: 'newest' | 'oldest';
  category?: string;
  /** Inclusive UTC day range of the memory's date (see date-range.ts). */
  range?: DayRange | null;
  saved?: boolean;
  calendar?: CalendarMode;
  language?: Language;
  digits?: DigitMode;
};

function normalizeSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064B-\u065F\u0670\u200C-\u200F\uFEFF]/g, '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();
}

function toDiaryRow(row: RawDiaryRow): DiaryRow {
  let mediaKeys: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.media_keys || '[]');
    if (Array.isArray(parsed)) mediaKeys = parsed.filter((key): key is string => typeof key === 'string');
  } catch {
    mediaKeys = [];
  }
  return {
    id: row.id,
    title: row.title,
    category: row.category || DIARY_NO_CATEGORY,
    mood: row.mood || null,
    body: row.body,
    mediaKeys,
    saved: row.saved === 1,
    fromMe: row.from_me !== 0,
    sharedMedia: row.shared_media && row.shared_media > 0 ? row.shared_media : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function validateDiary(db: Db, entry: DiaryRow): Promise<void> {
  if (!entry.id.trim()) throw new TypeError('Diary id is required.');
  if (!entry.title.trim()) throw new TypeError('Diary title is required.');
  if (typeof entry.category !== 'string' || !(await isKnownCategory(db, entry.category))) throw new TypeError('Unknown diary category.');
  if (!Array.isArray(entry.mediaKeys) || entry.mediaKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Diary media keys must be an array of strings.');
  }
  if (!Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))) {
    throw new TypeError('Diary timestamps must be valid ISO dates.');
  }
}

/** Create or update a local diary entry. Timestamps are supplied by the caller and stored as UTC ISO strings. */
export async function saveDiaryEntry(db: Db, entry: DiaryRow): Promise<void> {
  await validateDiary(db, entry);
  await db.runAsync(
    `INSERT INTO diary (id, title, category, mood, body, media_keys, saved, created_at, updated_at, from_me, shared_media)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, title = excluded.title, category = excluded.category, mood = excluded.mood,
       body = excluded.body, media_keys = excluded.media_keys, saved = excluded.saved, updated_at = excluded.updated_at`,
     entry.id, entry.title.trim(), entry.category, entry.mood?.trim() || null, entry.body, JSON.stringify(entry.mediaKeys),
    entry.saved ? 1 : 0, new Date(entry.createdAt).toISOString(), new Date(entry.updatedAt).toISOString(),
    entry.fromMe === false ? 0 : 1, entry.sharedMedia && entry.sharedMedia > 0 ? entry.sharedMedia : 0,
  );
}

export async function getDiaryEntry(db: Db, id: string): Promise<DiaryRow | null> {
  const row = await db.getFirstAsync<RawDiaryRow>('SELECT * FROM diary WHERE id = ?', id);
  return row ? toDiaryRow(row) : null;
}

export async function deleteDiaryEntry(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM diary WHERE id = ?', id);
  await db.runAsync('DELETE FROM diary_replies WHERE memory_id = ?', id); // replies live and die with their memory
}

/** List local entries with text/date search, sort, category and Saved filters. */
export async function listDiaryEntries(db: Db, options: DiaryListOptions = {}): Promise<DiaryRow[]> {
  const sort = options.sort === 'oldest' ? 'ASC' : 'DESC';
  const rows = await db.getAllAsync<RawDiaryRow>(`SELECT * FROM diary ORDER BY created_at ${sort}, id ${sort}`);
  const entries = rows.map(toDiaryRow);
  const query = normalizeSearch(options.query ?? '');
  const calendar = options.calendar ?? 'jalali';
  const language = options.language ?? 'fa';
  const digits = options.digits ?? 'persian';
  return entries.filter((entry) => {
    if (options.category && options.category !== 'all' && entry.category !== options.category) return false;
    if (options.range) {
      const day = dayKey(entry.createdAt);
      if (day < options.range.from || day > options.range.to) return false;
    }
    if (options.saved === true && !entry.saved) return false;
    if (options.saved === false && entry.saved) return false;
    if (!query) return true;
    const dateText = formatDate(entry.createdAt, calendar, language, digits);
    return [entry.title, entry.body, dateText].some((text) => normalizeSearch(text).includes(query));
  });
}
