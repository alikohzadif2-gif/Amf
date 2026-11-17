#!/usr/bin/env node
// meyou-server <command>
//   serve   start the HTTP server (default)
//   init    create the household + owner token, print link/QR/JSON (idempotent)
//   devices | rotate-token | revoke | backup-db | purge-legacy  admin commands (S11)
//   push-test  check the Firebase credentials and send a test notification (S9)
//   help
import fs from 'node:fs';
import QRCode from 'qrcode';
import { buildApp, isInitialized, VERSION } from './app.js';
import { ConfigError, dbFile, loadConfig } from './config.js';
import { openDb } from './db.js';
import { AdminError, backupDb, listDevices, purgeLegacy, revokeFromCli, rotateToken } from './admin.js';
import { runInit } from './init.js';
import { runPushTest } from './push/test-command.js';

const HELP = `meyou-server ${VERSION}

Usage: meyou-server <command>

  serve   Start the server (default). Env: DATA_DIR, SERVER_NAME, PORT, TRUST_PROXY
  init    Create the household and the owner token; prints a pairing link, QR and JSON.
          Needs DOMAIN (or PUBLIC_URL). Safe to run again: it never changes anything twice.
  devices Lists the devices (name, role, last seen, push). Never prints a token.
  rotate-token [<deviceId>|owner]
          Gives a device a NEW token (default: the owner) and prints a new link/QR. The old token stops
          working at once; open the new link on that phone. Use it after a token leaked.
  revoke <deviceId>
          Removes a lost phone from the server (the other phone stays). The last device is refused.
  backup-db <file>
          Writes a consistent copy of the database (safe while the server runs). See README, "Backup".
  purge-legacy
          After upgrading from 1.x: empties the old tables (plaintext partner mailbox, media index, upload sessions).
          Optional and irreversible; files in the data folder are not touched. Make a backup-db first if unsure.
  push-test [--check]
          Checks FCM_SERVICE_ACCOUNT_FILE and sends a test notification to every phone that registered
          for push. --check only validates the credentials (no phone needed).
  help    Show this text
`;

async function serve(): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(dbFile(cfg));
  const app = await buildApp(cfg, db);
  if (!isInitialized(db)) app.log.warn('not initialized yet: run "meyou-server init" to create the owner token');

  const stop = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await app.listen({ host: cfg.host, port: cfg.port });
}

async function runAdmin(cmd: string, args: string[]): Promise<number> {
  const cfg = loadConfig();
  const db = openDb(dbFile(cfg));
  const out = (t: string) => process.stdout.write(t);
  try {
    if (cmd === 'devices') {
      const list = listDevices(db);
      if (list.length === 0) out('No devices: run "meyou-server init" first.\n');
      for (const d of list) {
        out(`${d.id}  ${d.role.padEnd(6)}  ${d.revokedAt ? 'REVOKED' : 'active '}  push:${d.push ? 'yes' : 'no '}  seen:${d.lastSeen ?? '-'}  ${d.name}\n`);
      }
      return 0;
    }
    if (cmd === 'rotate-token') {
      const r = rotateToken(cfg, db, args[0] ?? 'owner');
      out(`New token for "${r.device.name}" (${r.device.role}). The old one no longer works.\n`);
      out('Open this link on that phone, or paste it in Settings > Server connection. Shown once; keep it private.\n\n');
      out(`${r.link}\n\n`);
      out(await QRCode.toString(r.link, { type: 'terminal', small: true }));
      out('\nJSON (same payload as API contract C.6):\n');
      out(`${JSON.stringify(r.payload)}\n`);
      return 0;
    }
    if (cmd === 'revoke') {
      if (!args[0]) throw new AdminError('usage: meyou-server revoke <deviceId>   (ids: meyou-server devices)');
      const d = revokeFromCli(db, args[0]);
      out(`Revoked "${d.name}" (${d.id}). Its token no longer works.\n`);
      return 0;
    }
    if (cmd === 'purge-legacy') {
      const r = purgeLegacy(db);
      const parts = Object.entries(r.deleted).map(([t, n]) => `${t}: ${n}`);
      out(`Legacy rows deleted (${parts.length ? parts.join(', ') : 'nothing to delete'}). The database file was shrunk.\n`);
      out('Folders library/, uploads/ and cache/ inside the data folder are no longer used by 2.0 and were NOT touched; delete them yourself when you are sure.\n');
      return 0;
    }
    if (!args[0]) throw new AdminError('usage: meyou-server backup-db <file>');
    out(`Database copy written to ${backupDb(db, args[0])}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof AdminError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'serve';
  switch (cmd) {
    case 'serve':
      return serve();
    case 'init':
      await runInit(loadConfig());
      return;
    case 'devices':
    case 'rotate-token':
    case 'revoke':
    case 'backup-db':
    case 'purge-legacy':
      process.exitCode = await runAdmin(cmd, process.argv.slice(3));
      return;
    case 'push-test':
      process.exitCode = await runPushTest(loadConfig(), process.argv.slice(3));
      return;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) process.stderr.write(`Configuration error: ${e.message}\n`);
  else process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
