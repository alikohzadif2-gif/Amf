import type { DiaryRow } from '@/src/diary/diary-db';
import type { EventRow } from '@/src/events/events-db';
import { dayFolderLocal, dayFolderUtc, versionStamp } from './day-folder';

/**
 * Automatic backup of NEW entries (not the phone gallery). Pure planning: no network, no files here.
 *
 * Server layout (under the first server root): `Backup/<Jalali year>/<MM>/<DD>/`, for example `Backup/1405/07/29/`.
 * Everything that belongs to a day goes into that day's folder:
 *   - a memory: `memory-<id>-<version>.json` (title, text, category, mood, tags ...) + its photos/videos;
 *   - an event: `event-<id>-<version>.json` + its photo;
 *   - a file added straight to the Archive: the file + `<name>.info.json` (tags, category, favourite, albums) when it has any.
 * Day folders are created only when something belongs to that day (Jalali months have 29-31 days, so none are made in advance).
 * Only records that are new or changed since the last backup are planned, and every version is a new file, because the server
 * never overwrites or deletes (docs/API_CONTRACT.md D.9).
 */
export const DATA_FOLDER = 'Backup';

/** record key -> fingerprint (`updatedAt`) of the version that was queued for upload. */
export type DataMarks = Record<string, string>;

export type PlanFile = { day: string; name: string; json: string };
/** A file to upload into the day folder; size and md5 are read from the phone by the caller. */
export type PlanUpload = { key: string; day: string; uri: string; name: string; mtime?: string };

export type DataPlan = {
  files: PlanFile[];
  uploads: PlanUpload[];
  /** Marks to store once the plan is queued. */
  marks: DataMarks;
  events: number;
  memories: number;
  archive: number;
};

/** What the caller found out about one photo/video of a memory (Library entry). */
export type MediaInfo = {
  key: string;
  name: string;
  tags: string[];
  /** Phone file to upload; null = nothing to upload (it is already on the server, or the file is not readable now). */
  uri: string | null;
  mtime?: string;
};

export type ArchiveFile = {
  key: string;
  name: string;
  uri: string;
  /** UTC ISO modification time of the file. */
  mtime: string;
  /** The date the person gave the file in the Archive (UTC ISO), or null. */
  date: string | null;
  category: string;
  favorite: boolean;
  tags: string[];
  albums: string[];
};

export const eventKey = (id: string) => `event:${id}`;
export const memoryKey = (id: string) => `memory:${id}`;
export const photoKey = (name: string) => `eventphoto:${name}`;
/** Mark of a photo/video (Library key) that was queued, whichever way it got there (memory or Archive). */
export const mediaMark = (key: string) => `media:${key}`;

/** Last path segment of a file uri. */
export function baseName(uri: string): string {
  return decodeURIComponent(uri.split('?')[0].split('/').pop() ?? '');
}

const emptyPlan = (): DataPlan => ({ files: [], uploads: [], marks: {}, events: 0, memories: 0, archive: 0 });

/**
 * What is new since `marks` for memories and events. Surprise events are never included: the server is shared with the partner,
 * who can browse it. Memories and events received from the partner are included (they are part of this phone's data).
 */
export function planDataBackup(input: {
  events: readonly EventRow[];
  diary: readonly DiaryRow[];
  marks: DataMarks;
  media: Readonly<Record<string, MediaInfo | undefined>>;
  switches?: { memories: boolean; events: boolean };
}): DataPlan | null {
  const { marks } = input;
  const on = input.switches ?? { memories: true, events: true };
  const plan = emptyPlan();

  if (on.memories) {
    for (const m of input.diary) {
      if (marks[memoryKey(m.id)] === m.updatedAt) continue;
      const day = dayFolderLocal(m.createdAt);
      const media: { name: string; tags: string[] }[] = [];
      for (const key of m.mediaKeys) {
        const info = input.media[key];
        if (!info) continue;
        media.push({ name: info.name, tags: info.tags });
        if (info.uri && !marks[mediaMark(key)] && !plan.marks[mediaMark(key)]) {
          plan.uploads.push({ key: mediaMark(key), day, uri: info.uri, name: info.name, mtime: info.mtime });
          plan.marks[mediaMark(key)] = 'queued';
        }
      }
      plan.files.push({
        day,
        name: `memory-${m.id}-${versionStamp(m.updatedAt)}.json`,
        json: JSON.stringify({
          app: 'meYou',
          kind: 'memory',
          version: 2,
          id: m.id,
          title: m.title,
          category: m.category,
          mood: m.mood,
          body: m.body,
          tags: [...new Set(media.flatMap((x) => x.tags))],
          media,
          saved: m.saved,
          fromMe: m.fromMe !== false,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }),
      });
      plan.marks[memoryKey(m.id)] = m.updatedAt;
      plan.memories += 1;
    }
  }

  if (on.events) {
    for (const e of input.events) {
      if (e.surprise) continue;
      const day = dayFolderUtc(e.date);
      const photoName = e.photoUri ? baseName(e.photoUri) : '';
      if (marks[eventKey(e.id)] !== e.updatedAt) {
        plan.files.push({
          day,
          name: `event-${e.id}-${versionStamp(e.updatedAt)}.json`,
          json: JSON.stringify({
            app: 'meYou',
            kind: 'event',
            version: 2,
            id: e.id,
            title: e.title,
            date: e.date,
            repeat: e.repeat,
            cal: e.cal,
            tags: e.tags,
            description: e.description,
            icon: e.icon,
            photo: photoName || null,
            fromMe: e.fromMe,
            updatedAt: e.updatedAt,
          }),
        });
        plan.marks[eventKey(e.id)] = e.updatedAt;
        plan.events += 1;
      }
      const key = photoKey(photoName);
      if (e.photoUri && photoName && !marks[key] && !plan.marks[key]) {
        plan.uploads.push({ key, day, uri: e.photoUri, name: photoName });
        plan.marks[key] = 'queued';
      }
    }
  }

  return plan.files.length === 0 && plan.uploads.length === 0 ? null : plan;
}

/** Files added straight to the Archive from the phone (the app's own library) that were not queued yet. */
export function planArchiveBackup(input: { files: readonly ArchiveFile[]; marks: DataMarks }): DataPlan | null {
  const plan = emptyPlan();
  for (const f of input.files) {
    if (input.marks[mediaMark(f.key)] || plan.marks[mediaMark(f.key)]) continue;
    const day = f.date ? dayFolderUtc(f.date) : dayFolderLocal(f.mtime);
    plan.uploads.push({ key: mediaMark(f.key), day, uri: f.uri, name: f.name, mtime: f.mtime });
    plan.marks[mediaMark(f.key)] = 'queued';
    plan.archive += 1;
    if (f.category !== 'none' || f.favorite || f.tags.length > 0 || f.albums.length > 0) {
      plan.files.push({
        day,
        name: `${f.name}.info.json`,
        json: JSON.stringify({ app: 'meYou', kind: 'archive-file', version: 1, name: f.name, key: f.key, date: f.date, category: f.category, favorite: f.favorite, tags: f.tags, albums: f.albums }),
      });
    }
  }
  return plan.uploads.length === 0 ? null : plan;
}

/** Joins two plans (marks merged, the second plan's counts added). */
export function mergePlans(a: DataPlan | null, b: DataPlan | null): DataPlan | null {
  if (!a) return b;
  if (!b) return a;
  return {
    files: [...a.files, ...b.files],
    uploads: [...a.uploads, ...b.uploads],
    marks: { ...a.marks, ...b.marks },
    events: a.events + b.events,
    memories: a.memories + b.memories,
    archive: a.archive + b.archive,
  };
}
