/** Pure helpers of the 24-hour Story feature (no React Native imports, unit-tested in scripts/test-stories.mjs). */

export const STORY_TTL_MS = 24 * 60 * 60 * 1000;
export const STORY_MAX_VIDEO_SECONDS = 30;
export const STORY_MAX_CAPTION = 200;
export const STORY_MAX_OVERLAY = 120;
export const STORY_FOLDER = 'stories';

export type StoryType = 'photo' | 'video';

export type StoryRow = {
  id: string;
  fromMe: boolean;
  type: StoryType;
  mediaUri: string;
  /** Text laid over the picture (WhatsApp-status style); its vertical place is `overlayY` (0 = top, 1 = bottom). */
  overlayText: string | null;
  overlayY: number;
  caption: string | null;
  createdAt: string;
  expiresAt: string;
  /** When the partner opened it (only set on my own stories, once they have seen it). */
  viewedAt: string | null;
};

export function expiresAtOf(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + STORY_TTL_MS).toISOString();
}

export function isActive(expiresAt: string, nowMs: number): boolean {
  const end = new Date(expiresAt).getTime();
  return Number.isFinite(end) && end > nowMs;
}

/** Time left as hours (rounded up), or minutes when under one hour. Expired = 0 minutes. */
export function timeLeft(expiresAt: string, nowMs: number): { unit: 'hours' | 'minutes'; n: number } {
  const ms = Math.max(0, new Date(expiresAt).getTime() - nowMs);
  if (ms >= 60 * 60 * 1000) return { unit: 'hours', n: Math.ceil(ms / (60 * 60 * 1000)) };
  return { unit: 'minutes', n: Math.ceil(ms / 60000) };
}

export function clampOverlayY(y: number): number {
  if (!Number.isFinite(y)) return 0.5;
  return Math.min(0.9, Math.max(0.1, y));
}

/** Trims; empty becomes null; cuts to `max` characters. */
export function cleanText(value: string, max: number): string | null {
  const text = value.trim().slice(0, max);
  return text === '' ? null : text;
}

/** `HH:MM` of an ISO time in the phone's local zone (digits are converted by the caller). */
export function clockText(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function newStoryId(nowMs: number = Date.now(), rand: () => number = Math.random): string {
  return `st${nowMs.toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

/** Stories not yet expired, newest last (the order they are watched in). */
export function activeStories<T extends { expiresAt: string; createdAt: string }>(list: T[], nowMs: number): T[] {
  return list.filter((s) => isActive(s.expiresAt, nowMs)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export const STORY_PHOTO_MS = 5000;

export type RingState = 'none' | 'unseen' | 'seen';

/**
 * The ring around an avatar: none = no active story, unseen = a coloured ring, seen = a grey ring.
 * My own stories always show the coloured ring while they are active; the partner's turn grey once I have opened all of them.
 */
export function ringState(stories: { viewedAt: string | null }[], mine: boolean): RingState {
  if (stories.length === 0) return 'none';
  if (mine) return 'unseen';
  return stories.some((s) => s.viewedAt === null) ? 'unseen' : 'seen';
}

/** Index to start watching from: the first story I have not opened yet, else the first one. */
export function firstUnseenIndex(stories: { viewedAt: string | null }[]): number {
  const i = stories.findIndex((s) => s.viewedAt === null);
  return i < 0 ? 0 : i;
}

/** Milliseconds until the first of these stories expires; null when there are none. */
export function msUntilNextExpiry(stories: { expiresAt: string }[], nowMs: number): number | null {
  const ends = stories.map((s) => new Date(s.expiresAt).getTime()).filter((n) => Number.isFinite(n));
  return ends.length === 0 ? null : Math.max(0, Math.min(...ends) - nowMs);
}

/** File name used when a story is saved to the Library: `story-20261023-100000.jpg` (UTC, like the camera snaps) with the media's own extension. */
export function storyExportName(story: { createdAt: string; mediaUri: string; type: StoryType }): string {
  const d = new Date(story.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = Number.isFinite(d.getTime())
    ? `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
    : 'story';
  const ext = (story.mediaUri.split('?')[0].split('.').pop() ?? '').toLowerCase();
  return `story-${stamp}.${/^[a-z0-9]{2,4}$/.test(ext) ? ext : story.type === 'video' ? 'mp4' : 'jpg'}`;
}

/** After deleting the story at `index` from a list of `count`: the index to show next, or null when none are left. */
export function indexAfterDelete(count: number, index: number): number | null {
  if (count <= 1) return null;
  return Math.min(Math.max(0, index), count - 2);
}

/** The direct-chat text of a story reply: a one-line "reply to story" marker, then the typed text. Null when the text is blank. */
export function storyReplyBody(prefix: string, text: string, max: number): string | null {
  const body = text.trim();
  if (!body) return null;
  const head = `${prefix}\n`;
  return `${head}${body}`.slice(0, max);
}
