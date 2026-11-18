/** Size of a photo/video preview in the chat: the file's own proportions, never a forced square. */
export const RATIO_MIN = 0.5;
export const RATIO_MAX = 2;
export const MEDIA_MAX_WIDTH = 270;
export const MEDIA_MAX_HEIGHT = 380;
/** Shape used until the thumbnail has told its real size. */
const PLACEHOLDER_RATIO = 4 / 3;

/** `ratio` = width / height of the thumbnail (null while unknown). A very tall or wide picture is limited to 1:2 / 2:1. */
export function mediaBox(ratio: number | null, screenWidth: number): { width: number; height: number; ratio: number } {
  const shape = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio && ratio > 0 ? ratio : PLACEHOLDER_RATIO));
  const maxWidth = Math.min(MEDIA_MAX_WIDTH, Math.round(screenWidth * 0.68));
  const width = Math.min(maxWidth, Math.round(MEDIA_MAX_HEIGHT * shape));
  return { width, height: Math.round(width / shape), ratio: shape };
}
