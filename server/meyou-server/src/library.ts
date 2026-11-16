// Library roots (Q5): every real directory directly under $DATA_DIR/library is a
// root. Dot-entries, files and symlinks are ignored. The root id is its name.
import fs from 'node:fs';
import { libraryDir, type Config } from './config.js';

export const DEFAULT_ROOTS = ['Photos', 'Videos'] as const;

export interface Root {
  id: string;
  name: string;
}

export function ensureLibrary(cfg: Config): void {
  const lib = libraryDir(cfg);
  fs.mkdirSync(lib, { recursive: true });
  for (const name of DEFAULT_ROOTS) fs.mkdirSync(`${lib}/${name}`, { recursive: true });
}

export function listRoots(cfg: Config): Root[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(libraryDir(cfg), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.'))
    .map((d) => ({ id: d.name, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
