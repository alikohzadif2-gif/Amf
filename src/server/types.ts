/** Shared types for the personal server client (ping, token check, saved entries). */
export type ServerPing = {
  name: string;
  version: string;
  features: string[];
  certFingerprint?: string;
};

/** `GET /api/v1/me` (contract section D.4). */
export type ServerMe = {
  deviceId: string;
  role: 'owner' | 'member';
  household: { partner: { deviceId: string; name: string } | null };
  features: string[];
};

/** One address of a personal server. Several can be tried in order (failover). */
export type Endpoint = { id: string; url: string; token: string };

/** A saved server entry (the token itself lives in the token store, never here). */
export type ServerEntry = {
  id: string;
  /** The Library source this server belongs to (entries of one source are mirrors). */
  sourceId: string;
  name: string;
  url: string;
  /** Fingerprint the user confirmed on first connect (real pinning: Phase 11). */
  fingerprint?: string;
  fingerprintConfirmed?: boolean;
  /** UTC ISO. */
  addedAt: string;
};

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type TokenStore = {
  get(serverId: string): Promise<string | null>;
  set(serverId: string, token: string): Promise<void>;
  remove(serverId: string): Promise<void>;
};

/** Reads a local file in chunks (so a big video is never loaded whole). */
export type ChunkReader = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): void;
};
export type OpenReader = (uri: string) => Promise<ChunkReader>;
