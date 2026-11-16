/**
 * Quick setup over SSH (brief section 7). The wizard talks only to this
 * interface; Phase 4 ships a stub, Phase 11 adds the real SSH client.
 * Credentials are passed in memory, used once and never stored.
 */
export type SshAuth = { kind: 'password'; password: string } | { kind: 'key'; privateKey: string; passphrase?: string };

export type SshInstallParams = {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
};

export type SshInstallStep = 'connect' | 'upload' | 'install' | 'start' | 'verify';

export type SshInstallResult =
  | { ok: true; url: string; token: string; name?: string; certFingerprint?: string }
  | { ok: false; code: 'not-implemented' | 'auth-failed' | 'unreachable' | 'install-failed' };

export interface SshInstaller {
  /** False for the stub: the UI shows "coming in a later phase" instead of running it. */
  readonly available: boolean;
  install(params: SshInstallParams, onStep?: (step: SshInstallStep) => void): Promise<SshInstallResult>;
}

export class StubSshInstaller implements SshInstaller {
  readonly available = false;
  async install(): Promise<SshInstallResult> {
    return { ok: false, code: 'not-implemented' };
  }
}

let installer: SshInstaller = new StubSshInstaller();

export function getSshInstaller(): SshInstaller {
  return installer;
}

/** Phase 11 replaces the stub here. */
export function setSshInstaller(next: SshInstaller) {
  installer = next;
}
