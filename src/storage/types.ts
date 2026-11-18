/**
 * StorageProvider contract. The UI never talks to the server or the
 * file system directly: everything goes through this interface (brief rule 5).
 * All timestamps are UTC ISO 8601 strings.
 */
export type SourceKind = 'local' | 'vault' | 'partner';

/** Kinds whose files sit on THIS phone (the vault is private app storage; the partner's gallery lists only pictures already stored here). Every source is on this phone. */
export const isPhoneKind = (kind: SourceKind | undefined): boolean => kind === 'local' || kind === 'vault' || kind === 'partner';
export type SourceBackend = 'real' | 'mock';
export type ItemType = 'dir' | 'image' | 'video' | 'file' | 'text';

export type StorageItem = {
  id: string;
  parentId: string | null;
  name: string;
  type: ItemType;
  size: number;
  mtime: string;
  md5?: string;
  mime?: string;
  width?: number;
  height?: number;
  duration?: number;
};

export type ListOptions = { cursor?: string; limit?: number };
export type ListResult = { items: StorageItem[]; nextCursor?: string };

export type ImageRef = { uri: string; headers?: Record<string, string> };

export type ProviderChange = {
  id: string;
  op: 'add' | 'update' | 'delete';
  item?: StorageItem;
};
export type ChangesResult = { changes: ProviderChange[]; cursor: string };

export type UploadInput = {
  name: string;
  size: number;
  parentId: string | null;
  sourceUri: string;
  md5?: string;
  /** UTC ISO modification time of the source file (the file server keeps it). */
  mtime?: string;
  onProgress?: (sent: number, total: number) => void;
  /** Polled between chunks; true stops the upload (the server keeps the part it has). */
  isCancelled?: () => boolean;
};

export type TestCode =
  | 'ok'
  | 'permission-needed'
  | 'unavailable'
  | 'unauthorized'
  | 'error';

export type ProviderTestResult = {
  ok: boolean;
  code: TestCode;
  latencyMs: number;
  rootCount?: number;
  /** The server answered 429 (`rate_limited` / `locked_out`): it is busy, the token is not wrong. */
  busy?: boolean;
  retryAfter?: number;
};

export type ProviderCapabilities = {
  canUpload: boolean;
  canDelete: boolean;
  supportsChanges: boolean;
  needsPermission: boolean;
};

export interface StorageProvider {
  readonly id: string;
  readonly kind: SourceKind;
  readonly isMock: boolean;
  capabilities(): ProviderCapabilities;
  test(): Promise<ProviderTestResult>;
  /** Only for providers with needsPermission: asks the OS and re-tests. */
  requestAccess?(): Promise<ProviderTestResult>;
  /** parentId null lists the provider's roots. */
  list(parentId: string | null, options?: ListOptions): Promise<ListResult>;
  stat(id: string): Promise<StorageItem | null>;
  getThumb(id: string, size?: number): Promise<ImageRef | null>;
  getPreview(id: string): Promise<ImageRef | null>;
  /** Bare URL without credentials (kept for providers whose URLs are self-contained). */
  getOriginalUrl(id: string): Promise<string | null>;
  /**
   * URL plus request headers for the original. Providers that need auth
   * (the file server) implement this; callers use `originalSource()` from
   * `src/storage/original.ts`, which falls back to getOriginalUrl.
   */
  getOriginalSource?(id: string): Promise<ImageRef | null>;
  upload(input: UploadInput): Promise<StorageItem>;
  /** Optional: what the remote end announces it can do (file server `/ping` features). */
  features?(): Promise<string[]>;
  /** Optional: finds or creates a sub-folder (by name) under `parentId` (null = the provider's own library folder). */
  createFolder?(name: string, parentId: string | null): Promise<StorageItem>;
  delete(id: string): Promise<void>;
  changes(since?: string): Promise<ChangesResult>;
}

export type SourceConfig = {
  id: string;
  kind: SourceKind;
  backend: SourceBackend;
  /** Custom name; built-in/default names come from i18n. */
  name?: string;
  enabled: boolean;
  builtIn: boolean;
  /** Mock only: the large (5,000 item) demo tree for scroll tests. */
  stress?: boolean;
};
