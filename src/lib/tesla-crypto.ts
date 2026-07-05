/**
 * Self-contained crypto primitives for decrypting Tesla dashcam containers.
 *
 * Two primitives are needed that the browser's WebCrypto API does not provide
 * in a usable form here:
 *
 *   1. MD5 — used to derive each page's IV. WebCrypto has no MD5.
 *   2. Raw AES-128-CBC (no PKCS7 padding) — each 4096-byte page is a whole
 *      number of blocks with no padding byte. WebCrypto's AES-CBC always
 *      appends/strips PKCS7, so it cannot decrypt these pages as-is.
 *
 * Both implementations are standard and verified against published test
 * vectors (see tesla-crypto.test.ts / the round-trip check in scripts).
 */

// ── MD5 ─────────────────────────────────────────────────────────────────────

function md5cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
  a = (((a + q) | 0) + ((x + t) | 0)) | 0;
  return (((a << s) | (a >>> (32 - s))) + b) | 0;
}
function md5ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return md5cmn((b & c) | (~b & d), a, b, x, s, t);
}
function md5gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function md5hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return md5cmn(b ^ c ^ d, a, b, x, s, t);
}
function md5ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return md5cmn(c ^ (b | ~d), a, b, x, s, t);
}

/** Compute the MD5 digest of a byte array. Returns 16 raw bytes. */
export function md5(input: Uint8Array): Uint8Array {
  const len = input.length;
  // Pad message: append 0x80, then zeros, then 64-bit little-endian bit length.
  const withPad = ((len + 8) >> 6) + 1;
  const words = new Int32Array(withPad * 16);
  for (let i = 0; i < len; i++) {
    words[i >> 2] |= input[i] << ((i % 4) * 8);
  }
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[withPad * 16 - 2] = len * 8;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < words.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;

    a = md5ff(a, b, c, d, words[i + 0], 7, -680876936);
    d = md5ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = md5ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = md5ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = md5ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = md5ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = md5ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = md5ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = md5ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = md5ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = md5ff(c, d, a, b, words[i + 10], 17, -42063);
    b = md5ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = md5ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = md5ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = md5ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = md5ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = md5gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = md5gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = md5gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = md5gg(b, c, d, a, words[i + 0], 20, -373897302);
    a = md5gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = md5gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = md5gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = md5gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = md5gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = md5gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = md5gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = md5gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = md5gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = md5gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = md5gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = md5gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = md5hh(a, b, c, d, words[i + 5], 4, -378558);
    d = md5hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = md5hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = md5hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = md5hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = md5hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = md5hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = md5hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = md5hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = md5hh(d, a, b, c, words[i + 0], 11, -358537222);
    c = md5hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = md5hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = md5hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = md5hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = md5hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = md5hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = md5ii(a, b, c, d, words[i + 0], 6, -198630844);
    d = md5ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = md5ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = md5ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = md5ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = md5ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = md5ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = md5ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = md5ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = md5ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = md5ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = md5ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = md5ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = md5ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = md5ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = md5ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = (a + oa) | 0;
    b = (b + ob) | 0;
    c = (c + oc) | 0;
    d = (d + od) | 0;
  }

  const out = new Uint8Array(16);
  const regs = [a, b, c, d];
  for (let i = 0; i < 4; i++) {
    out[i * 4 + 0] = regs[i] & 0xff;
    out[i * 4 + 1] = (regs[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (regs[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (regs[i] >>> 24) & 0xff;
  }
  return out;
}

// ── AES-128 ─────────────────────────────────────────────────────────────────
// Standard AES (Rijndael, 128-bit key) with precomputed tables. Decryption
// only; the container is never re-encrypted.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

(function buildSboxes() {
  // Multiplicative inverse in GF(2^8) via log/exp tables, then affine transform.
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 256; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  SBOX[0] = 0x63;
  for (let i = 1; i < 256; i++) {
    let inv = exp[(255 - log[i]) % 255];
    let s = inv;
    for (let c = 0; c < 4; c++) {
      inv = ((inv << 1) | (inv >>> 7)) & 0xff;
      s ^= inv;
    }
    s ^= 0x63;
    SBOX[i] = s & 0xff;
  }
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

function xtime(a: number): number {
  return ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;
}
function mul(a: number, b: number): number {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) result ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return result & 0xff;
}

/** Expanded key schedule: 44 32-bit words for AES-128. */
function expandKey(key: Uint8Array): Uint32Array {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) {
    w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  }
  for (let i = 4; i < 44; i++) {
    let temp = w[i - 1];
    if (i % 4 === 0) {
      // RotWord + SubWord + Rcon
      temp = ((temp << 8) | (temp >>> 24)) >>> 0;
      temp =
        ((SBOX[(temp >>> 24) & 0xff] << 24) |
          (SBOX[(temp >>> 16) & 0xff] << 16) |
          (SBOX[(temp >>> 8) & 0xff] << 8) |
          SBOX[temp & 0xff]) >>>
        0;
      temp ^= RCON[i / 4 - 1] << 24;
    }
    w[i] = (w[i - 4] ^ temp) >>> 0;
  }
  return w;
}

/** Decrypt a single 16-byte block in place-ish; returns a new 16-byte block. */
function decryptBlock(input: Uint8Array, w: Uint32Array): Uint8Array {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i];

  addRoundKey(s, w, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s);
    invSubBytes(s);
    addRoundKey(s, w, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  invSubBytes(s);
  addRoundKey(s, w, 0);
  return s;
}

function addRoundKey(s: Uint8Array, w: Uint32Array, round: number) {
  for (let c = 0; c < 4; c++) {
    const word = w[round * 4 + c];
    s[c * 4 + 0] ^= (word >>> 24) & 0xff;
    s[c * 4 + 1] ^= (word >>> 16) & 0xff;
    s[c * 4 + 2] ^= (word >>> 8) & 0xff;
    s[c * 4 + 3] ^= word & 0xff;
  }
}
function invSubBytes(s: Uint8Array) {
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
}
function invShiftRows(s: Uint8Array) {
  // State is column-major: s[col*4 + row].
  const t = new Uint8Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      t[((c + r) % 4) * 4 + r] = s[c * 4 + r];
    }
  }
  s.set(t);
}
function invMixColumns(s: Uint8Array) {
  for (let c = 0; c < 4; c++) {
    const a0 = s[c * 4 + 0];
    const a1 = s[c * 4 + 1];
    const a2 = s[c * 4 + 2];
    const a3 = s[c * 4 + 3];
    s[c * 4 + 0] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
    s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
    s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
    s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
  }
}

// Keep xtime referenced (used implicitly by mul-free paths in some builds).
void xtime;

/**
 * Decrypt `ciphertext` (a whole number of 16-byte blocks) with AES-128-CBC and
 * NO padding removal. Writes plaintext into `out` at `outOffset`. `iv` is 16
 * bytes. Returns the number of bytes written (== ciphertext.length).
 */
export function aes128CbcDecryptNoPad(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  out: Uint8Array,
  outOffset: number
): number {
  if (ciphertext.length % 16 !== 0) {
    throw new Error(`CBC ciphertext not a multiple of 16 bytes: ${ciphertext.length}`);
  }
  const w = expandKey(key);
  const prev = new Uint8Array(16);
  prev.set(iv);
  const block = new Uint8Array(16);

  for (let off = 0; off < ciphertext.length; off += 16) {
    for (let i = 0; i < 16; i++) block[i] = ciphertext[off + i];
    const dec = decryptBlock(block, w);
    for (let i = 0; i < 16; i++) {
      out[outOffset + off + i] = dec[i] ^ prev[i];
    }
    prev.set(block);
  }
  return ciphertext.length;
}
