import { createStore, type StoreApi } from 'zustand/vanilla';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { isDriveError } from '@/src/drive/errors';
import { isServerError } from '@/src/server/errors';
import type { StorageProvider } from '@/src/storage/types';

export type UploadState = 'queued' | 'uploading' | 'done' | 'failed';

export type UploadJob = {
  id: string;
  sourceId: string;
  parentId: string | null;
  uri: string;
  name: string;
  size: number;
  md5?: string;
  state: UploadState;
  sent: number;
  /** Failure code (never UI text): ServerError kind or 'error'. */
  error?: string;
  /** Library key of the phone item, so "back up new media" skips it next time. */
  backupKey?: string;
  /** UTC ISO modification time of the phone file; the server keeps it as the file's date. */
  mtime?: string;
  /** Automatic retries used so far (network trouble); reset when the job succeeds or is retried by hand. */
  attempts?: number;
  /** UTC ISO. */
  addedAt: string;
  doneAt?: string;
};

export type EnqueueInput = Pick<UploadJob, 'sourceId' | 'parentId' | 'uri' | 'name' | 'size' | 'md5' | 'backupKey' | 'mtime'>;

/** What the last "back up" run found and sent (the summary screen). */
export type BackupRun = {
  /** UTC ISO of the scan. */
  at: string;
  scanned: number;
  /** Already on the server (or uploaded before): not sent again. */
  skipped: number;
  /** Files the phone could not read. */
  unreadable: number;
  queued: number;
  uploaded: number;
  bytes: number;
};

export type QueueState = {
  jobs: UploadJob[];
  paused: boolean;
  running: boolean;
  /** Why the loop is waiting (a Blocker code from `canRun`), or null. Not persisted. */
  waiting: string | null;
  /** backupKey -> UTC ISO of the successful upload. */
  backedUp: Record<string, string>;
  run: BackupRun | null;
};

export type QueueActions = {
  enqueue: (inputs: EnqueueInput[]) => number;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  retryFailed: () => Promise<void>;
  /** Failed jobs whose cause may pass (network, server busy) go back to waiting. */
  retryTransient: () => Promise<void>;
  /** Starts the loop again unless the person paused it (network or battery came back). */
  kick: () => Promise<void>;
  /** Records a scan: starts a new summary when the queue is idle, otherwise adds to the running one. */
  beginRun: (scan: { scanned: number; skipped: number; unreadable: number; queued: number }) => void;
  clearFinished: () => void;
  removeJob: (id: string) => void;
};

export type QueueStore = StoreApi<QueueState & QueueActions>;

/** A file to upload instead of the queued one (e.g. a copy without EXIF). */
export type PreparedFile = {
  uri: string;
  name: string;
  size: number;
  md5?: string;
  /** Called after the upload attempt, success or not (delete the temporary copy). */
  cleanup?: () => void;
};

export type QueueDeps = {
  resolveProvider: (sourceId: string) => StorageProvider | null;
  /**
   * Optional step before each upload. Return null to upload the file as queued.
   * Throwing fails the job (code `prepare`): a file that must be cleaned is never
   * uploaded as is.
   */
  prepare?: (job: UploadJob) => Promise<PreparedFile | null>;
  /** Optional persistence (AsyncStorage in the app, none in tests). */
  storage?: StateStorage;
  storageName?: string;
  now?: () => Date;
  /**
   * Checked before every job: a reason string (e.g. 'no-wifi') stops the loop
   * with `waiting` set; null lets it go on. Call `kick()` when it may have changed.
   */
  canRun?: () => Promise<string | null> | string | null;
  /** Wait before an automatic retry (injected so tests do not wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Delays of the automatic retries after network trouble; its length is the retry limit. */
  retryDelaysMs?: number[];
};

export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 180_000, 600_000];

class PrepareError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'prepare failed');
    this.name = 'PrepareError';
  }
}

/** Failure code (never UI text): `prepare`, a ServerError or DriveError kind (`drive-full`, `drive-unauthorized`) (`http-507` for an HTTP status), or `error`. */
export function errorCode(error: unknown): string {
  if (error instanceof PrepareError) return 'prepare';
  if (isDriveError(error)) {
    if (error.kind === 'unauthorized' || error.kind === 'cancelled') return 'drive-unauthorized';
    if (error.kind === 'quota') return error.status === 429 ? 'http-429' : 'drive-full';
    if (error.kind === 'http' && error.status) return `http-${error.status}`;
    return error.kind;
  }
  if (isServerError(error)) return error.kind === 'http' && error.status ? `http-${error.status}` : error.kind;
  return 'error';
}

/** Codes that can pass by themselves: no network, timeout, server restarting, busy, or a server-side hiccup (500) that gets fixed. */
export function isTransientCode(code: string | undefined): boolean {
  if (!code) return false;
  return code === 'network' || code === 'timeout' || code === 'protocol' || code === 'http-429' || /^http-5(00|02|03|04)$/.test(code);
}

function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'UploadCancelled';
}

/**
 * Upload queue. One job at a time; each job calls provider.upload(), which for
 * the file server is the resumable chunked upload. Jobs persist, so a restart
 * keeps the list (interrupted ones go back to `queued`).
 */
export function createUploadQueue(deps: QueueDeps): QueueStore {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let counter = 0;
  let loop: Promise<void> | null = null;

  const init = (
    set: StoreApi<QueueState & QueueActions>['setState'],
    get: StoreApi<QueueState & QueueActions>['getState'],
  ): QueueState & QueueActions => {
    const patch = (id: string, change: Partial<UploadJob>) =>
      set((state) => ({ jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...change } : job)) }));

    /** Waits `ms` in small steps so a pause ends the wait quickly. */
    const backoff = async (ms: number) => {
      const step = Math.min(500, ms);
      for (let waited = 0; waited < ms && !get().paused; waited += step) await sleep(step);
    };

    const runLoop = async () => {
      set({ running: true });
      try {
        for (;;) {
          const state = get();
          if (state.paused) break;
          const next = state.jobs.find((j) => j.state === 'queued');
          if (!next) break;
          const blocker = deps.canRun ? await deps.canRun() : null;
          if (blocker) {
            set({ waiting: blocker });
            break;
          }
          if (get().waiting !== null) set({ waiting: null });
          const job = next;
          patch(job.id, { state: 'uploading', sent: 0, error: undefined });
          const provider = deps.resolveProvider(job.sourceId);
          let prepared: PreparedFile | null = null;
          try {
            if (!provider) throw new Error('source missing');
            if (deps.prepare) {
              try {
                prepared = await deps.prepare(job);
              } catch (error) {
                throw new PrepareError(error);
              }
            }
            await provider.upload({
              name: prepared?.name ?? job.name,
              size: prepared?.size ?? job.size,
              parentId: job.parentId,
              sourceUri: prepared?.uri ?? job.uri,
              md5: prepared ? prepared.md5 : job.md5,
              mtime: job.mtime,
              onProgress: (sent) => patch(job.id, { sent }),
              // A pause stops in the middle of a big file; the server keeps what it got.
              isCancelled: () => get().paused,
            });
            const doneAt = now().toISOString();
            patch(job.id, { state: 'done', sent: job.size, doneAt, attempts: 0 });
            set((s) => ({
              ...(job.backupKey ? { backedUp: { ...s.backedUp, [job.backupKey]: doneAt } } : {}),
              run: s.run ? { ...s.run, uploaded: s.run.uploaded + 1, bytes: s.run.bytes + job.size } : s.run,
            }));
          } catch (error) {
            if (isCancel(error)) {
              patch(job.id, { state: 'queued', sent: 0 });
            } else {
              const code = errorCode(error);
              const attempts = (job.attempts ?? 0) + 1;
              if (isTransientCode(code) && attempts <= delays.length) {
                // Back to waiting; the next round re-checks network/battery, then resumes at the server's offset.
                patch(job.id, { state: 'queued', sent: 0, attempts, error: code });
                await backoff(delays[attempts - 1]);
              } else {
                patch(job.id, { state: 'failed', error: code });
              }
            }
          } finally {
            try {
              prepared?.cleanup?.();
            } catch {
              // temporary copy already gone
            }
          }
        }
      } finally {
        set({ running: false });
      }
    };

    const start = () => {
      if (!loop) {
        loop = runLoop().finally(() => {
          loop = null;
        });
      }
      return loop;
    };

    return {
      jobs: [],
      paused: false,
      running: false,
      waiting: null,
      backedUp: {},
      run: null,
      enqueue: (inputs) => {
        const known = new Set(
          get()
            .jobs.filter((j) => j.state !== 'failed' && j.state !== 'done')
            .map((j) => `${j.sourceId}|${j.uri}`),
        );
        const added: UploadJob[] = [];
        for (const input of inputs) {
          const dupKey = `${input.sourceId}|${input.uri}`;
          if (known.has(dupKey)) continue;
          known.add(dupKey);
          counter += 1;
          added.push({
            ...input,
            id: `${now().getTime().toString(36)}-${counter}`,
            state: 'queued',
            sent: 0,
            addedAt: now().toISOString(),
          });
        }
        if (added.length > 0) set((state) => ({ jobs: [...state.jobs, ...added] }));
        return added.length;
      },
      start: async () => {
        set({ paused: false });
        await start();
      },
      pause: () => set({ paused: true }),
      resume: async () => {
        set({ paused: false });
        await start();
      },
      retryFailed: async () => {
        set((state) => ({
          paused: false,
          jobs: state.jobs.map((job) =>
            job.state === 'failed' ? { ...job, state: 'queued', error: undefined, sent: 0, attempts: 0 } : job,
          ),
        }));
        await start();
      },
      retryTransient: async () => {
        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.state === 'failed' && isTransientCode(job.error)
              ? { ...job, state: 'queued', error: undefined, sent: 0, attempts: 0 }
              : job,
          ),
        }));
        if (!get().paused) await start();
      },
      kick: async () => {
        if (!get().paused) await start();
      },
      beginRun: (scan) =>
        set((state) => {
          const busy = state.jobs.some((j) => j.state === 'queued' || j.state === 'uploading');
          const at = now().toISOString();
          if (busy && state.run) {
            return { run: { ...state.run, at, scanned: scan.scanned, skipped: scan.skipped, unreadable: scan.unreadable, queued: state.run.queued + scan.queued } };
          }
          return { run: { at, ...scan, uploaded: 0, bytes: 0 } };
        }),
      clearFinished: () => set((state) => ({ jobs: state.jobs.filter((job) => job.state !== 'done') })),
      removeJob: (id) =>
        set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id || job.state === 'uploading') })),
    };
  };

  if (!deps.storage) return createStore<QueueState & QueueActions>()(init);
  return createStore<QueueState & QueueActions>()(
    persist(init, {
      name: deps.storageName ?? 'meyou-uploads',
      storage: createJSONStorage(() => deps.storage as StateStorage),
      version: 1,
      partialize: (state) => ({ jobs: state.jobs, paused: state.paused, backedUp: state.backedUp, run: state.run }) as QueueState & QueueActions,
      // Interrupted uploads restart from the offset the server reports.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<QueueState>;
        return {
          ...current,
          jobs: (saved.jobs ?? []).map((job) => (job.state === 'uploading' ? { ...job, state: 'queued' as const, sent: 0 } : job)),
          paused: saved.paused ?? false,
          backedUp: saved.backedUp ?? {},
          run: saved.run ?? null,
        };
      },
    }),
  );
}
