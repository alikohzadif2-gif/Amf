import type { QrServer } from './qr';

/** In-memory hand-off (never persisted) from SSH setup to the add-server wizard. */
let pending: QrServer | null = null;

export function setServerPrefill(value: QrServer) {
  pending = value;
}

export function takeServerPrefill(): QrServer | null {
  const value = pending;
  pending = null;
  return value;
}
