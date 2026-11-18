import type { TranslationKey } from '@/src/i18n';
import type { ConnectionIssue, ConnectionTest } from './test-connection';

/** UI text keys for a connection test. Pure, so the live test can check the mapping. */
const ISSUE_KEY: Record<ConnectionIssue, TranslationKey> = {
  unauthorized: 'connUnauthorized',
  unreachable: 'connUnreachable',
  timeout: 'connTimeout',
  certificate: 'connCertificate',
  'not-meyou': 'connNotMeyou',
  busy: 'connBusy',
  'server-error': 'connServerError',
};

export function connectionMessageKey(test: ConnectionTest): TranslationKey {
  if (test.ok) return 'testOk';
  return test.issue ? ISSUE_KEY[test.issue] : 'testError';
}

const FEATURE_KEY: Record<string, TranslationKey> = {
  e2e: 'featureE2e',
  push: 'featurePush',
};

/** Known features map to a translated label; unknown ones are shown as the server sent them. */
export function featureLabelKey(feature: string): TranslationKey | null {
  return FEATURE_KEY[feature] ?? null;
}
