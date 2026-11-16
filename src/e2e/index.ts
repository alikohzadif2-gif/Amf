import { createE2ePairing, type E2ePairing } from './pairing-flow';
import { secureKvStore } from './key-store';
import { nativeSodium } from './sodium';

let instance: E2ePairing | null = null;

/** The one E2E pairing object of the app (native libsodium + SecureStore). */
export function e2ePairing(): E2ePairing {
  instance ??= createE2ePairing({ sodium: nativeSodium, store: secureKvStore });
  return instance;
}
