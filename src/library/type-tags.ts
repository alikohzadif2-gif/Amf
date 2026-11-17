import { create } from 'zustand';
import type { TranslationKey } from '@/src/i18n';
import type { LibraryEntry } from './merge';

/** Q8b: Archive "Type" = tags. Built-in types are stored under a stable id (`@birthday`), custom types under their typed name. */
export const BUILTIN_TYPES: readonly { tag: string; label: TranslationKey }[] = [
  { tag: '@name', label: 'typeName' },
  { tag: '@birthday', label: 'typeBirthday' },
  { tag: '@valentine', label: 'typeValentine' },
  { tag: '@anniversary', label: 'typeAnniversary' },
  { tag: '@date', label: 'typeDate' },
  { tag: '@university', label: 'typeUniversity' },
  { tag: '@cafe', label: 'typeCafe' },
  { tag: '@cinema', label: 'typeCinema' },
  { tag: '@military', label: 'typeMilitary' },
];

type Translator = (key: TranslationKey) => string;
export type TypeOption = { tag: string; label: string; builtin: boolean };

export function typeLabel(tag: string, t: Translator): string {
  return BUILTIN_TYPES.find((b) => b.tag === tag) ? t(BUILTIN_TYPES.find((b) => b.tag === tag)!.label) : tag;
}

/** Built-ins first (always listed), then every custom tag in use (auto-added when first typed). */
export function typeOptions(allTags: readonly string[], t: Translator): TypeOption[] {
  const builtin = new Set(BUILTIN_TYPES.map((b) => b.tag));
  return [
    ...BUILTIN_TYPES.map((b) => ({ tag: b.tag, label: t(b.label), builtin: true })),
    ...allTags.filter((tag) => !builtin.has(tag)).map((tag) => ({ tag, label: tag, builtin: false })),
  ];
}

/** A typed name equal to a built-in label (current language) or id resolves to the built-in tag, so "Café" is never duplicated. */
export function resolveTypeTag(name: string, t: Translator): string {
  const n = name.trim();
  const hit = BUILTIN_TYPES.find((b) => b.tag === n || t(b.label).trim().toLowerCase() === n.toLowerCase());
  return hit ? hit.tag : n;
}

/** Tag key of an entry: files use their library key; a folder uses its source path(s), so equal folder names elsewhere stay apart. */
export function tagKeyOf(entry: LibraryEntry): string {
  if (entry.item.type !== 'dir') return entry.key;
  return `dirpath:${entry.refs.map((r) => `${r.sourceId}:${r.itemId}`).sort().join('|')}`;
}

/** Keeps the files and folders carrying the tag; no tag = unchanged. */
export function applyTypeFilter(entries: LibraryEntry[], tag: string | null, tagsByKey: Record<string, string[]>): LibraryEntry[] {
  if (!tag) return entries;
  return entries.filter((e) => tagsByKey[tagKeyOf(e)]?.includes(tag));
}

/** Active Type filter of the open Archive (null = all). Reset each time the Archive opens. */
export const useTypeFilter = create<{ tag: string | null; set: (tag: string | null) => void }>((set) => ({ tag: null, set: (tag) => set({ tag }) }));
