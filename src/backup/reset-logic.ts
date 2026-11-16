/** Upload jobs of the new-entries backup carry these key prefixes; every other job with a key comes from the phone gallery. */
const ENTRY_KEY_PREFIXES = ['media:', 'eventphoto:'];

export function isGalleryJob(job: { backupKey?: string; state: string }): boolean {
  return !!job.backupKey && !ENTRY_KEY_PREFIXES.some((p) => job.backupKey!.startsWith(p));
}
