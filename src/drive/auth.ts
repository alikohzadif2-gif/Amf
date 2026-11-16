import { DriveError } from './errors';
import type { DriveAccount, DriveAuth } from './types';

/** Full Drive access: the app lists, reads, adds, creates folders and moves things to the bin in the person's own Drive. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** The parts of `@react-native-google-signin/google-signin` we use (loaded lazily, so Expo Go and tests never need it). */
type SignInModule = typeof import('@react-native-google-signin/google-signin');

async function loadModule(): Promise<SignInModule> {
  try {
    return await import('@react-native-google-signin/google-signin');
  } catch {
    throw new DriveError('unsupported', 0, 'Google sign-in is not part of this build');
  }
}

function mapSignInError(error: unknown): DriveError {
  if (error instanceof DriveError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const text = String(code ?? '');
  if (/CANCEL/i.test(text)) return new DriveError('cancelled');
  if (/SIGN_IN_REQUIRED/i.test(text)) return new DriveError('unauthorized');
  if (/NETWORK/i.test(text)) return new DriveError('network');
  return new DriveError('http', 0, error instanceof Error ? error.message : text || undefined);
}

/**
 * Google sign-in on the phone itself: the token never goes through the personal server.
 * Android Play Services keeps the session and hands out fresh access tokens (`getTokens`).
 */
export class GoogleSignInAuth implements DriveAuth {
  private configured = false;

  constructor(private readonly webClientId?: string) {}

  private async module(): Promise<SignInModule> {
    const mod = await loadModule();
    if (!this.configured) {
      mod.GoogleSignin.configure({ scopes: [DRIVE_SCOPE], ...(this.webClientId ? { webClientId: this.webClientId } : {}) });
      this.configured = true;
    }
    return mod;
  }

  /** Opens the Google account picker and consent screen. */
  async signIn(): Promise<DriveAccount> {
    const { GoogleSignin } = await this.module();
    try {
      await GoogleSignin.hasPlayServices();
      let response = await GoogleSignin.signIn();
      if (response.type === 'cancelled') throw new DriveError('cancelled');
      if (!response.data.scopes.includes(DRIVE_SCOPE)) {
        const added = await GoogleSignin.addScopes({ scopes: [DRIVE_SCOPE] });
        if (!added || added.type === 'cancelled') throw new DriveError('cancelled');
        response = added;
      }
      const { email, name, photo } = response.data.user;
      return { email, name, photo };
    } catch (error) {
      throw mapSignInError(error);
    }
  }

  /** The account Google Play Services still remembers (no screen), or null. */
  async current(): Promise<DriveAccount | null> {
    try {
      const { GoogleSignin } = await this.module();
      const silent = await GoogleSignin.signInSilently();
      if (silent.type !== 'success') return null;
      const { email, name, photo } = silent.data.user;
      return { email, name, photo };
    } catch {
      return null;
    }
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const { GoogleSignin } = await this.module();
    try {
      if (!GoogleSignin.hasPreviousSignIn()) {
        const silent = await GoogleSignin.signInSilently();
        if (silent.type !== 'success') throw new DriveError('unauthorized');
      }
      let tokens = await GoogleSignin.getTokens();
      if (forceRefresh) {
        await GoogleSignin.clearCachedAccessToken(tokens.accessToken);
        tokens = await GoogleSignin.getTokens();
      }
      if (!tokens.accessToken) throw new DriveError('unauthorized');
      return tokens.accessToken;
    } catch (error) {
      throw mapSignInError(error);
    }
  }

  /** Signs out on this phone and revokes the app's access, so a later sign-in asks for consent again. */
  async signOut(): Promise<void> {
    try {
      const { GoogleSignin } = await this.module();
      try {
        await GoogleSignin.revokeAccess();
      } catch {
        // not signed in any more: signing out below is enough
      }
      await GoogleSignin.signOut();
    } catch (error) {
      if (error instanceof DriveError && error.kind === 'unsupported') return;
      throw mapSignInError(error);
    }
  }
}
