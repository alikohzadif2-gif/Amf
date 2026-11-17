// `meyou-server push-test` (S9): checks the Firebase credentials and sends a real test
// notification to every registered phone. Run it on the VPS, e.g.
//   docker compose exec meyou-server node dist/cli.js push-test
// Never prints a token or any key material.
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { dbFile } from '../config.js';
import { activeDevices, getHousehold, openDb } from '../db.js';
import { Push } from './service.js';
import { createFcmTransport, PushConfigError, type PushTransport } from './transport.js';

/** What to do about the most common failures (shown after the error code). */
const HINTS: Record<string, string> = {
  'app/invalid-credential': 'could not get an access token from Google: check that the VPS can reach the internet and that the key file is the right one and not revoked',
  'messaging/mismatched-credential': 'the key belongs to a different Firebase project than the app (google-services.json): use the key of the same project',
  'messaging/third-party-auth-error': 'Firebase refused the credentials: check that "Firebase Cloud Messaging API (V1)" is enabled for the project',
  'messaging/server-unavailable': 'Google did not answer: try again in a minute',
  'messaging/internal-error': 'Google had an internal error: try again in a minute',
};

const quiet = (() => {
  const l: Record<string, unknown> = {
    level: 'silent',
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    silent() {},
  };
  l.child = () => l;
  return l as unknown as FastifyBaseLogger;
})();

/** Returns the process exit code: 0 all good, 1 something failed, 2 not set up. */
export async function runPushTest(
  cfg: Config,
  args: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  /** Test hook: builds the transport (the real one talks to Google). */
  makeTransport: (file: string) => Promise<PushTransport> = createFcmTransport,
): Promise<number> {
  const checkOnly = args.includes('--check');
  if (!cfg.fcmServiceAccountFile) {
    out('FCM_SERVICE_ACCOUNT_FILE is not set, so push is off.\nPut the Firebase service-account JSON on the VPS, mount it read-only and set FCM_SERVICE_ACCOUNT_FILE (see README, "Push").\n');
    return 2;
  }
  let transport: PushTransport;
  try {
    transport = await makeTransport(cfg.fcmServiceAccountFile);
  } catch (e) {
    out(`Credentials NOT usable: ${e instanceof PushConfigError ? e.message : 'unexpected error'}.\n`);
    return 2;
  }
  out(`Credentials OK. Firebase project: ${transport.projectId}\n`);
  if (checkOnly) {
    await transport.close?.();
    return 0;
  }

  const db = openDb(dbFile(cfg));
  const push = new Push(db, quiet, transport, { retryDelaysMs: [1000, 3000] });
  try {
    const household = getHousehold(db);
    if (!household) {
      out('Not initialized yet: run "meyou-server init" first.\n');
      return 2;
    }
    const devices = activeDevices(db, household.id).filter((d) => d.fcm_token);
    if (devices.length === 0) {
      out('No phone has registered for push yet. The app registers its token after the push update (S10); until then use --check.\n');
      return 1;
    }
    let failed = 0;
    for (const d of devices) {
      const r = await push.sendTest(d);
      if (r.ok) out(`  sent to "${d.name}" (${d.lang ?? 'en'})\n`);
      else {
        failed += 1;
        const hint = r.tokenRemoved ? 'the phone token was invalid and has been removed; open the app to register again' : HINTS[r.code];
        out(`  FAILED for "${d.name}": ${r.code}${hint ? ` (${hint})` : ''}\n`);
      }
    }
    out(failed === 0 ? 'Done. The phone should show a notification within a few seconds.\n' : `${failed} of ${devices.length} failed.\n`);
    return failed === 0 ? 0 : 1;
  } finally {
    await push.stop();
    db.close();
  }
}
