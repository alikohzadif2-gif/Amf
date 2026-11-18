import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions } from '../src/app.js';
import { dbFile, loadConfig, type Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { initHousehold, type InitResult } from '../src/init.js';

export interface Env {
  cfg: Config;
  db: Db;
  app: FastifyInstance;
  init: InitResult;
  token: string;
  logs: string[];
  cleanup: () => Promise<void>;
}

export async function makeEnv(extra: Record<string, string> = {}, build: Pick<BuildOptions, 'partner' | 'push' | 'lockoutNow'> = {}): Promise<Env> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meyou-test-'));
  const cfg = loadConfig({ DATA_DIR: dataDir, DOMAIN: 'meyou.example.com', SERVER_NAME: 'Test Home', ...extra });
  const db = openDb(dbFile(cfg));
  const init = initHousehold(cfg, db);
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const app = await buildApp(cfg, db, { logStream, logLevel: 'debug', ...build });
  await app.ready();
  return {
    cfg,
    db,
    app,
    init,
    token: init.token!,
    logs,
    cleanup: async () => {
      await app.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
