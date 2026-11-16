import type { SQLiteDatabase } from 'expo-sqlite';
import {
  CUSTOM_CATEGORY_MAX,
  CUSTOM_CATEGORY_NAME_MAX,
  DIARY_NO_CATEGORY,
  isDiaryCategory,
  type CustomCategory,
} from './categories';

type Db = Pick<SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

export type AddCategoryResult =
  | { ok: true; category: CustomCategory }
  | { ok: false; reason: 'empty' | 'exists' | 'limit' };

const nameKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export function cleanCategoryName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, CUSTOM_CATEGORY_NAME_MAX);
}

export function newCategoryId(randomHex: string): string {
  return `c${randomHex}`;
}

export async function listCustomCategories(db: Db): Promise<CustomCategory[]> {
  const rows = await db.getAllAsync<CustomCategory>('SELECT id, name FROM diary_categories ORDER BY created_at ASC, id ASC');
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/** Adds a custom category. Names must be new (also against the built-in names, whose text the caller passes in `reserved`). */
export async function addCustomCategory(
  db: Db,
  rawName: string,
  id: string,
  reserved: readonly string[] = [],
  now: string = new Date().toISOString(),
): Promise<AddCategoryResult> {
  const name = cleanCategoryName(rawName);
  if (!name) return { ok: false, reason: 'empty' };
  const existing = await listCustomCategories(db);
  if (existing.length >= CUSTOM_CATEGORY_MAX) return { ok: false, reason: 'limit' };
  const key = nameKey(name);
  if (existing.some((c) => nameKey(c.name) === key) || reserved.some((r) => nameKey(r) === key)) return { ok: false, reason: 'exists' };
  await db.runAsync('INSERT INTO diary_categories (id, name, created_at) VALUES (?, ?, ?)', id, name, now);
  return { ok: true, category: { id, name } };
}

/** Deletes a custom category; its memories become "No category" (nothing else is touched). */
export async function deleteCustomCategory(db: Db, id: string): Promise<void> {
  await db.runAsync('UPDATE diary SET category = ? WHERE category = ?', DIARY_NO_CATEGORY, id);
  await db.runAsync('DELETE FROM diary_categories WHERE id = ?', id);
}

export async function isKnownCategory(db: Db, id: string): Promise<boolean> {
  if (id === DIARY_NO_CATEGORY || isDiaryCategory(id)) return true;
  return !!(await db.getFirstAsync('SELECT id FROM diary_categories WHERE id = ?', id));
}
