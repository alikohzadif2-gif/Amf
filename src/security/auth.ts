import * as LocalAuthentication from 'expo-local-authentication';

/**
 * ok          the person proved who they are
 * cancelled   the prompt was dismissed
 * unavailable the phone has no screen lock / biometrics set up (nothing to ask)
 * failed      wrong finger/PIN, lockout, anything else
 */
export type AuthResult = 'ok' | 'cancelled' | 'unavailable' | 'failed';

/** True when the phone has a PIN, pattern, password or biometric enrolled. */
export async function deviceHasLock(): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level !== LocalAuthentication.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/** Biometric prompt with the device PIN/pattern as fallback (no custom PIN). */
export async function authenticate(promptMessage: string, cancelLabel: string): Promise<AuthResult> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel,
      disableDeviceFallback: false,
    });
    if (result.success) return 'ok';
    switch (result.error) {
      case 'not_enrolled':
      case 'not_available':
      case 'passcode_not_set':
        return 'unavailable';
      case 'user_cancel':
      case 'system_cancel':
      case 'app_cancel':
        return 'cancelled';
      default:
        return 'failed';
    }
  } catch {
    return 'unavailable';
  }
}
