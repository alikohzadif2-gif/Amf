/**
 * Incremental SHA-256 in plain TypeScript (no native module, no dependency), so a big video can be hashed chunk by chunk with the
 * JS thread released between chunks. Checked against Node's crypto in scripts/test-sync-hash.mjs.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private block = new Uint8Array(64);
  private filled = 0;
  private length = 0; // bytes
  private w = new Uint32Array(64);

  update(bytes: Uint8Array): this {
    this.length += bytes.length;
    let i = 0;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      i = take;
      if (this.filled === 64) {
        this.compress(this.block, 0);
        this.filled = 0;
      }
    }
    for (; i + 64 <= bytes.length; i += 64) this.compress(bytes, i);
    if (i < bytes.length) {
      this.block.set(bytes.subarray(i), 0);
      this.filled = bytes.length - i;
    }
    return this;
  }

  /** The digest as 64 lower-case hex characters. The object cannot be used afterwards. */
  digestHex(): string {
    const bits = this.length * 8;
    const pad = new Uint8Array(((this.filled < 56 ? 56 : 120) - this.filled) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(pad.length - 4, bits >>> 0);
    const saved = this.length;
    this.update(pad);
    this.length = saved;
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t += 1) {
      const j = offset + t * 4;
      w[t] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t += 1) {
      const a = w[t - 15];
      const b = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let t = 0; t < 64; t += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const s = this.h;
    s[0] += a; s[1] += b; s[2] += c; s[3] += d; s[4] += e; s[5] += f; s[6] += g; s[7] += h;
  }
}

export const sha256Hex = (bytes: Uint8Array): string => new Sha256().update(bytes).digestHex();

/**
 * SHA-256 of a file read in pieces through `read(offset, length)` (the same reader the chunk sender uses). The JS thread is released
 * between pieces; `onProgress` gets 0..1. Throws when a read comes back short (the file changed while hashing).
 */
export async function hashSource(source: { size: number; read: (offset: number, length: number) => Promise<Uint8Array> }, opts: { piece?: number; yieldMs?: number; onProgress?: (fraction: number) => void } = {}): Promise<string> {
  const piece = opts.piece ?? 256 * 1024;
  const hash = new Sha256();
  for (let offset = 0; offset < source.size; offset += piece) {
    const length = Math.min(piece, source.size - offset);
    const bytes = await source.read(offset, length);
    if (bytes.length !== length) throw new Error('short read');
    hash.update(bytes);
    opts.onProgress?.((offset + length) / source.size);
    await new Promise<void>((resolve) => setTimeout(resolve, opts.yieldMs ?? 0));
  }
  return hash.digestHex();
}

type Readable = { size: number; read: (offset: number, length: number) => Promise<Uint8Array> };

/**
 * Do two files hold exactly the same bytes? Both are hashed with SHA-256 in pieces. 'unknown' = a file could not be read completely
 * (the caller must then keep what it has: never act on 'unknown').
 */
export async function compareSources(a: Readable, b: Readable, opts: { piece?: number } = {}): Promise<'same' | 'different' | 'unknown'> {
  if (a.size !== b.size) return 'different';
  try {
    const first = await hashSource(a, opts);
    const second = await hashSource(b, opts);
    return first === second ? 'same' : 'different';
  } catch {
    return 'unknown';
  }
}
