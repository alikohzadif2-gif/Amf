import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * The app's one open database, handed over by `app/_layout.tsx` once SQLite is ready. Code that has no React context
 * (the pick kit, `copyIntoLibrary`) reads it here instead of opening a second connection.
 */
let current: SQLiteDatabase | null = null;
export const setSharedDb = (db: SQLiteDatabase | null): void => {
  current = db;
};
export const getSharedDb = (): SQLiteDatabase | null => current;
