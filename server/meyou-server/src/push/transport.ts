// FCM transport (S9). The rest of the server only knows the PushTransport interface, so tests
// use a fake. The real one wraps firebase-admin (FCM HTTP v1).
import fs from 'node:fs';
import type { FcmMessage } from './messages.js';

export interface PushTransport {
  /** Resolves when FCM accepted the message; rejects with an error that has a string `code`. */
  send(message: FcmMessage): Promise<void>;
  /** Firebase project id (not a secret), for `push-test --check`. */
  readonly projectId?: string;
  close?(): Promise<void>;
}

/** Thrown when the credentials cannot be used. The text never contains file content. */
export class PushConfigError extends Error {}

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const MAX_FILE_BYTES = 64 * 1024;

/** Reads and checks a Firebase service-account JSON. Error messages are safe to log. */
export function loadServiceAccount(file: string): ServiceAccount {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new PushConfigError('the path is not a file');
    if (st.size > MAX_FILE_BYTES) throw new PushConfigError('the file is too big to be a service-account key');
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof PushConfigError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new PushConfigError('the file does not exist');
    if (code === 'EACCES') throw new PushConfigError('the file cannot be read (the container runs as uid 1000: chown 1000:1000 or chmod 644 it)');
    throw new PushConfigError('the file cannot be read');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PushConfigError('the file is not valid JSON');
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (o.type !== 'service_account') throw new PushConfigError('the file is not a service-account key (type must be "service_account")');
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.trim() === '') throw new PushConfigError(`the key file has no "${k}"`);
    return v;
  };
  return { projectId: str('project_id'), clientEmail: str('client_email'), privateKey: str('private_key') };
}

let appCounter = 0;

/** firebase-admin is loaded on demand: a server without push never pays for it. */
export async function createFcmTransport(file: string): Promise<PushTransport> {
  const sa = loadServiceAccount(file);
  const { initializeApp, cert, deleteApp } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  let app;
  try {
    app = initializeApp({ credential: cert(sa), projectId: sa.projectId }, `meyou-push-${(appCounter += 1)}`);
  } catch {
    // firebase-admin's own text can quote parts of the key: do not pass it on.
    throw new PushConfigError('the private key in the file is not usable');
  }
  const messaging = getMessaging(app);
  return {
    projectId: sa.projectId,
    async send(message: FcmMessage): Promise<void> {
      await messaging.send(message);
    },
    async close(): Promise<void> {
      await deleteApp(app);
    },
  };
}
