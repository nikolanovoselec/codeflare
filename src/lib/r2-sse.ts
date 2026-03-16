/**
 * R2 SSE-C (Server-Side Encryption with Customer-Provided Keys) header generation.
 *
 * When ENCRYPTION_KEY is set, generates the required S3-compatible headers
 * for encrypting/decrypting R2 objects at rest. Used by storage routes and r2-seed.
 */

/**
 * Minimal MD5 implementation for SSE-C key-MD5 header.
 * Cloudflare Workers do not support crypto.subtle.digest('MD5').
 * SSE-C requires: base64(MD5(raw_key_bytes)).
 */
function md5(input: Uint8Array): Uint8Array {
  // Pre-computed per-round shift amounts
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  // Pre-computed T[i] = floor(2^32 * abs(sin(i+1)))
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  // Pre-processing: pad message to 512-bit blocks
  const bitLen = input.length * 8;
  const padLen = ((input.length + 8) % 64 === 0)
    ? input.length + 8
    : input.length + 64 - ((input.length + 8) % 64);
  const padded = new Uint8Array(padLen + 8);
  padded.set(input);
  padded[input.length] = 0x80;
  // Append original length in bits as 64-bit little-endian
  const view = new DataView(padded.buffer);
  view.setUint32(padLen, bitLen >>> 0, true);
  view.setUint32(padLen + 4, 0, true);

  // Initialize hash values
  let a0 = 0x67452301 >>> 0;
  let b0 = 0xefcdab89 >>> 0;
  let c0 = 0x98badcfe >>> 0;
  let d0 = 0x10325476 >>> 0;

  // Process each 512-bit (64-byte) chunk
  const M = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true);
    }

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = ((F >>> 0) + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      const rotated = ((F << s[i]) | (F >>> (32 - s[i]))) >>> 0;
      B = (B + rotated) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  // Produce the 128-bit digest as little-endian bytes
  const digest = new Uint8Array(16);
  const dv = new DataView(digest.buffer);
  dv.setUint32(0, a0, true);
  dv.setUint32(4, b0, true);
  dv.setUint32(8, c0, true);
  dv.setUint32(12, d0, true);
  return digest;
}

/** Cache computed MD5 to avoid recomputation on repeated calls */
let cachedMd5Source: string | null = null;
let cachedMd5B64: string | null = null;

function computeKeyMd5(base64Key: string): string {
  if (cachedMd5Source === base64Key && cachedMd5B64) return cachedMd5B64;

  const rawKey = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const digest = md5(rawKey);
  cachedMd5B64 = btoa(String.fromCharCode(...digest));
  cachedMd5Source = base64Key;
  return cachedMd5B64;
}

/**
 * Generate SSE-C headers for R2 PUT/GET/HEAD operations.
 * Returns empty object when ENCRYPTION_KEY is not set.
 */
export function getSseHeaders(
  env: { ENCRYPTION_KEY?: string },
): Record<string, string> {
  if (!env.ENCRYPTION_KEY) return {};

  return {
    'x-amz-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-server-side-encryption-customer-key': env.ENCRYPTION_KEY,
    'x-amz-server-side-encryption-customer-key-MD5': computeKeyMd5(env.ENCRYPTION_KEY),
  };
}

/**
 * Generate SSE-C copy-source headers for S3 CopyObject operations.
 * Required when copying an SSE-C encrypted object (e.g., move.ts).
 */
export function getSseCopyHeaders(
  env: { ENCRYPTION_KEY?: string },
): Record<string, string> {
  if (!env.ENCRYPTION_KEY) return {};

  return {
    'x-amz-copy-source-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-copy-source-server-side-encryption-customer-key': env.ENCRYPTION_KEY,
    'x-amz-copy-source-server-side-encryption-customer-key-MD5': computeKeyMd5(env.ENCRYPTION_KEY),
  };
}
