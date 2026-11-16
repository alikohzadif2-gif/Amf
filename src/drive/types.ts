/** Shared types for the Google Drive client (Drive REST API v3). */
export type DriveAuth = {
  /** A valid OAuth access token. `forceRefresh` asks Google for a new one (after a 401). Throws DriveError when signed out. */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
};

export type DriveAccount = { email: string; name: string | null; photo: string | null };

/** The fields of a Drive file this app asks for (see FILE_FIELDS in client.ts). */
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  md5Checksum?: string;
  thumbnailLink?: string;
  parents?: string[];
  trashed?: boolean;
  imageMediaMetadata?: { width?: number; height?: number };
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
};

export type DriveFilePage = { files: DriveFile[]; nextPageToken?: string };

export type DriveAbout = {
  user: { emailAddress?: string; displayName?: string; photoLink?: string };
  storageQuota?: { limit?: string; usage?: string; usageInDrive?: string };
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
