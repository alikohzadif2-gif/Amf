import Constants from 'expo-constants';
import { openFileReader } from '../server/file-reader';
import { useDriveStore } from '../state/drive-store';
import { GoogleSignInAuth } from './auth';
import { DriveProvider } from './provider';

/** Optional: the OAuth "Web client" id of the Google Cloud project (only needed for ID tokens; Drive works without it). */
function webClientId(): string | undefined {
  const fromEnv = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  const fromConfig = (Constants.expoConfig?.extra as { googleWebClientId?: string } | undefined)?.googleWebClientId;
  return fromEnv || fromConfig || undefined;
}

let auth: GoogleSignInAuth | null = null;
export function googleAuth(): GoogleSignInAuth {
  if (!auth) auth = new GoogleSignInAuth(webClientId());
  return auth;
}

/** Sign in with Google and remember the account (not the token) on this phone. */
export async function signInToDrive() {
  const account = await googleAuth().signIn();
  useDriveStore.getState().setAccount(account);
  return account;
}

/** Sign out, revoke the app's access and forget the account and the chosen folder. */
export async function signOutOfDrive(): Promise<void> {
  try {
    await googleAuth().signOut();
  } finally {
    useDriveStore.getState().clear();
  }
}

/** The real Google Drive provider for one source (wired into the registry). */
export function createDriveProvider(sourceId: string): DriveProvider {
  return new DriveProvider(sourceId, {
    auth: googleAuth(),
    hasAccount: () => useDriveStore.getState().account !== null,
    rootFolder: () => useDriveStore.getState().rootFolder,
    onRootFolder: (folder) => useDriveStore.getState().setRootFolder(folder),
    signIn: signInToDrive,
    openReader: openFileReader,
  });
}
