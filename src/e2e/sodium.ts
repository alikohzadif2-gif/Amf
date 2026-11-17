import {
  crypto_aead_xchacha20poly1305_ietf_decrypt,
  crypto_aead_xchacha20poly1305_ietf_encrypt,
  crypto_box_keypair,
  crypto_box_seal,
  crypto_box_seal_open,
  crypto_generichash,
  crypto_kdf_derive_from_key,
  randombytes_buf,
} from 'react-native-libsodium';
import type { Sodium } from './crypto';

/** The app's libsodium (native, through JSI). Tests inject `libsodium-wrappers` instead: same function names and arguments. */
export const nativeSodium: Sodium = {
  crypto_box_keypair: () => crypto_box_keypair(),
  crypto_box_seal: (message, publicKey) => crypto_box_seal(message, publicKey),
  crypto_box_seal_open: (ciphertext, publicKey, privateKey) => crypto_box_seal_open(ciphertext, publicKey, privateKey),
  crypto_kdf_derive_from_key: (length, id, context, key) => crypto_kdf_derive_from_key(length, id, context, key),
  crypto_generichash: (length, message) => crypto_generichash(length, message, null),
  randombytes_buf: (length) => randombytes_buf(length),
  crypto_aead_xchacha20poly1305_ietf_encrypt: (message, ad, secretNonce, nonce, key) => crypto_aead_xchacha20poly1305_ietf_encrypt(message, ad, secretNonce, nonce, key),
  crypto_aead_xchacha20poly1305_ietf_decrypt: (secretNonce, ciphertext, ad, nonce, key) => crypto_aead_xchacha20poly1305_ietf_decrypt(secretNonce, ciphertext, ad, nonce, key),
};
