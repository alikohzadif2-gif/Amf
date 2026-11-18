import type { ErrorBoundaryProps } from 'expo-router';
import { ErrorFallback } from '@/components/ErrorFallback';
import { logEvent } from '@/src/diagnostics/log';

/**
 * Q2: Expo Router's route-level error boundary (`export { RouteErrorBoundary as ErrorBoundary }` in a route file).
 * A render error in that screen shows the app's error message with a retry instead of closing the app.
 */
export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  logEvent('error', `route: ${error.name}: ${error.message}`);
  return <ErrorFallback error={error} resetError={() => void retry()} />;
}
