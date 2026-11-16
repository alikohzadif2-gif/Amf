import { Directory, File, Paths } from 'expo-file-system';
import { TRASH_FOLDER, VAULT_FOLDER } from './logic';

/** The vault folder: app-private (`files/meyou-vault/`), created on first use. Excluded from Android backup (plugins/with-backup-exclude.js). */
export function vaultDirectory(): Directory {
  const dir = new Directory(Paths.document, VAULT_FOLDER);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export function trashDirectory(): Directory {
  const dir = new Directory(vaultDirectory(), TRASH_FOLDER);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** The file for a vault-relative path (`Holiday/a.jpg`). */
export const vaultFile = (rel: string): File => new File(vaultDirectory(), ...rel.split('/'));

/** Creates the folders above `rel` inside the vault. */
export function ensureParents(rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  let dir = vaultDirectory();
  for (const part of parts) {
    dir = new Directory(dir, part);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  }
}

/** Removes empty folders from `rel`'s parent upwards, never the vault root and never a folder that still holds anything. */
export function pruneEmptyParents(rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  for (let depth = parts.length; depth > 0; depth -= 1) {
    try {
      const dir = new Directory(vaultDirectory(), ...parts.slice(0, depth));
      if (!dir.exists || dir.list().length > 0) return;
      dir.delete();
    } catch {
      return;
    }
  }
}

/** Free internal storage in bytes (null when the phone does not say). */
export function freeDiskBytes(): number | null {
  try {
    const free = Paths.availableDiskSpace;
    return typeof free === 'number' && Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/** Size and MD5 of a file (a `file://` or a document-provider `content://` file). Missing values are undefined, never guessed. */
export function statOf(file: File): { size?: number; md5?: string } {
  try {
    const info = file.info({ md5: true });
    return { size: typeof info.size === 'number' ? info.size : undefined, md5: info.md5 ?? undefined };
  } catch {
    try {
      return { size: typeof file.size === 'number' ? file.size : undefined };
    } catch {
      return {};
    }
  }
}
