/**
 * Tesla dashcam decryption (firmware 2026.20+).
 *
 * Starting with 2026.20, dashcam / Sentry clips on the USB drive are stored as
 * encrypted containers rather than plain MP4. This module detects those
 * containers, reads the ownership metadata from their header, fetches the
 * per-file AES key from Tesla's key endpoint (the only step that leaves the
 * device — and only file identifiers travel, never video), and decrypts the
 * payload locally in the browser.
 *
 * Container layout (big-endian fields):
 *   0x0000  8    plaintext MP4 size (uint64)
 *   0x0004  16   file id bytes (formatted as the API item UUID)
 *   0x0014  4    metadata offset — equals 0x1000 for these containers
 *   0x1000  4    key_id (uint32)
 *   0x1004  65   public_key (uncompressed EC point, first byte 0x04)
 *   0x1045  17   VIN (ASCII)
 *   0x1056  8    timestamp (uint64)
 *   0x105e  44   wrapped_key
 *   0x2000+ ...  encrypted payload, 4096-byte AES-128-CBC pages
 *
 * Each 4096-byte page is encrypted independently with
 *   IV = MD5( MD5(file_key) ‖ ascii(page_index) ‖ zero-pad to 32 bytes )
 */

import { md5, aes128CbcDecryptNoPad } from './tesla-crypto';

/**
 * Where the browser sends the key request. A browser cannot call
 * dashcam.tesla.com directly (CORS), so by default we use a same-origin proxy
 * path that forwards to Tesla server-to-server. Three deployments serve it:
 * the Next dev server rewrites it locally (next.config.ts), a Cloudflare Pages
 * Function handles it on exportdash.cam (functions/tesla-decrypt/[[path]].ts),
 * and nginx proxies it in the Docker image (nginx.conf).
 * Override with NEXT_PUBLIC_TESLA_KEY_URL for other deployments.
 */
const KEY_API_URL =
  process.env.NEXT_PUBLIC_TESLA_KEY_URL || '/tesla-decrypt/api/1/decrypt/batch';

const TOKEN_STORAGE_KEY = 'tesla-cam-decrypt-token';

const PAGE_SIZE = 4096;
const METADATA_OFFSET = 0x1000;
const CIPHERTEXT_OFFSET = 0x2000;

const KEY_ID_OFFSET = METADATA_OFFSET;
const PUBLIC_KEY_OFFSET = KEY_ID_OFFSET + 4;
const PUBLIC_KEY_SIZE = 65;
const VIN_OFFSET = PUBLIC_KEY_OFFSET + PUBLIC_KEY_SIZE;
const VIN_SIZE = 17;
const TIMESTAMP_OFFSET = VIN_OFFSET + VIN_SIZE;
const TIMESTAMP_SIZE = 8;
const WRAPPED_KEY_OFFSET = TIMESTAMP_OFFSET + TIMESTAMP_SIZE;
const WRAPPED_KEY_SIZE = 44;

const MIN_HEADER_BYTES = WRAPPED_KEY_OFFSET + WRAPPED_KEY_SIZE;

/** Metadata read from an encrypted container header. */
export interface TeslaFileHeader {
  /** File UUID — the id used as the key-request item id. */
  id: string;
  vin: string;
  keyId: number;
  timestamp: number;
  /** base64, as the key API expects. */
  wrappedKey: string;
  /** base64, as the key API expects. */
  publicKey: string;
  /** Decrypted MP4 length in bytes. */
  plaintextSize: number;
}

// ── byte helpers ─────────────────────────────────────────────────────────────

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
  );
}

function readU64BE(buf: Uint8Array, offset: number): number {
  // MP4 sizes fit comfortably in a JS safe integer; read as two 32-bit halves.
  const hi = readU32BE(buf, offset);
  const lo = readU32BE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20, 32)}`;
}

// ── detection & parsing ──────────────────────────────────────────────────────

/**
 * Heuristically decide whether a file is a Tesla 2026.20+ encrypted container.
 * Uses several independent signals so ordinary MP4 files are never misread:
 * the metadata offset field equals 0x1000, the key_id is non-zero, and the
 * embedded EC public key begins with the uncompressed-point marker 0x04.
 */
export function isEncryptedTeslaContainer(buf: Uint8Array): boolean {
  if (buf.length < CIPHERTEXT_OFFSET) return false;
  if (readU32BE(buf, 0x14) !== METADATA_OFFSET) return false;
  if (readU32BE(buf, KEY_ID_OFFSET) === 0) return false;
  if (buf[PUBLIC_KEY_OFFSET] !== 0x04) return false;
  const size = readU64BE(buf, 0);
  if (size <= 0) return false;
  return true;
}

/** Parse the header metadata required for the key request and for decryption. */
export function parseTeslaHeader(buf: Uint8Array): TeslaFileHeader {
  if (buf.length < MIN_HEADER_BYTES) {
    throw new Error('File too short to contain Tesla encrypted header');
  }

  const plaintextSize = readU64BE(buf, 0);
  if (plaintextSize <= 0) throw new Error('Invalid plaintext size in encrypted header');

  const id = formatUuid(buf.subarray(0x04, 0x04 + 16));

  const publicKey = buf.subarray(PUBLIC_KEY_OFFSET, PUBLIC_KEY_OFFSET + PUBLIC_KEY_SIZE);
  if (publicKey[0] !== 0x04) throw new Error('Invalid public key in encrypted header');

  let vin = '';
  for (let i = 0; i < VIN_SIZE; i++) {
    const c = buf[VIN_OFFSET + i];
    if (c === 0) break;
    vin += String.fromCharCode(c);
  }
  if (vin.length !== VIN_SIZE) throw new Error('Invalid VIN in encrypted header');

  const wrappedKey = buf.subarray(WRAPPED_KEY_OFFSET, WRAPPED_KEY_OFFSET + WRAPPED_KEY_SIZE);

  return {
    id,
    vin,
    keyId: readU32BE(buf, KEY_ID_OFFSET),
    timestamp: readU64BE(buf, TIMESTAMP_OFFSET),
    wrappedKey: bytesToBase64(wrappedKey),
    publicKey: bytesToBase64(publicKey),
    plaintextSize,
  };
}

/** Read just the header region of a File and report whether it's an encrypted container. */
export async function isEncryptedTeslaFile(file: File): Promise<boolean> {
  if (file.size < CIPHERTEXT_OFFSET) return false;
  const head = new Uint8Array(await file.slice(0, CIPHERTEXT_OFFSET).arrayBuffer());
  return isEncryptedTeslaContainer(head);
}

// ── token storage ────────────────────────────────────────────────────────────

/** Load a previously remembered Tesla token from this device, if any. */
export function loadStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the Tesla token on this device (localStorage). */
export function saveStoredToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    /* storage may be unavailable (private mode); ignore */
  }
}

/** Remove any remembered Tesla token from this device. */
export function clearStoredToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ── key retrieval ────────────────────────────────────────────────────────────

export class KeyFetchError extends Error {
  constructor(
    message: string,
    /** true when the failure looks like a browser CORS block rather than an auth/server error. */
    readonly likelyCors: boolean = false,
    readonly status?: number
  ) {
    super(message);
    this.name = 'KeyFetchError';
  }
}

/** Tesla's key endpoint rejects batches larger than this many items. */
const MAX_KEY_BATCH = 30;

/** POST a single (already size-limited) batch of headers and return its keys. */
async function fetchKeyBatch(
  headers: TeslaFileHeader[],
  bearer: string
): Promise<Map<string, Uint8Array>> {
  const payload = {
    items: headers.map((h) => ({
      id: h.id,
      vin: h.vin,
      key_id: h.keyId,
      timestamp: h.timestamp,
      wrapped_key: h.wrappedKey,
      public_key: h.publicKey,
    })),
  };

  let resp: Response;
  try {
    resp = await fetch(KEY_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Same-origin proxy path unreachable — the proxy isn't running/configured,
    // or the network is down. (A direct cross-origin call to Tesla would be
    // blocked by CORS, which is why the request goes through the proxy.)
    throw new KeyFetchError(
      `Couldn't reach the key proxy at ${KEY_API_URL}. It's served by the Next dev server locally, a Cloudflare Pages Function on exportdash.cam, and nginx in the Docker image. Make sure it's running.`,
      true
    );
  }

  // A static host with no proxy configured answers a POST to an asset path with
  // 405 (or a non-JSON 404) — that's the host talking, not Tesla, so don't
  // report it as a Tesla failure.
  const contentType = resp.headers.get('content-type') ?? '';
  if (resp.status === 405 || (resp.status === 404 && !contentType.includes('json'))) {
    throw new KeyFetchError(
      `The key proxy at ${KEY_API_URL} isn't deployed — the host answered HTTP ${resp.status} for a static path instead of forwarding to Tesla.`,
      true,
      resp.status
    );
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new KeyFetchError('Tesla rejected the token. Grab a fresh one and try again.', false, resp.status);
  }
  if (!resp.ok) {
    throw new KeyFetchError(`Tesla key service returned HTTP ${resp.status}.`, false, resp.status);
  }

  const data = (await resp.json()) as {
    results?: Array<{ id: string; key?: string; error?: string | null }>;
  };

  const keys = new Map<string, Uint8Array>();
  for (const result of data.results ?? []) {
    if (result.error || !result.key) continue;
    keys.set(result.id, base64ToBytes(result.key));
  }
  return keys;
}

/**
 * Request per-file AES keys from Tesla's key endpoint. Only file identifiers
 * and ownership metadata are sent; the encrypted video never leaves the device.
 * Requests are split into batches of at most {@link MAX_KEY_BATCH} to respect
 * Tesla's per-request limit. Returns a map of file id -> raw 16-byte AES key.
 *
 * @param onBatch optional callback (batchesDone, batchTotal) for progress.
 */
export async function fetchDecryptKeys(
  headers: TeslaFileHeader[],
  token: string,
  onBatch?: (done: number, total: number) => void
): Promise<Map<string, Uint8Array>> {
  // Accept a token pasted either bare or with a leading "Bearer " (copied
  // straight from the Authorization header) — strip the prefix so we don't
  // send "Bearer Bearer …".
  const bearer = token.trim().replace(/^Bearer\s+/i, '');

  const keys = new Map<string, Uint8Array>();
  const batchTotal = Math.ceil(headers.length / MAX_KEY_BATCH);
  for (let i = 0; i < headers.length; i += MAX_KEY_BATCH) {
    const batch = headers.slice(i, i + MAX_KEY_BATCH);
    const batchKeys = await fetchKeyBatch(batch, bearer);
    for (const [id, key] of batchKeys) keys.set(id, key);
    onBatch?.(Math.floor(i / MAX_KEY_BATCH) + 1, batchTotal);
  }
  return keys;
}

// ── decryption ───────────────────────────────────────────────────────────────

/** Derive the AES-CBC IV for a given zero-based page index. */
function derivePageIv(rootIv: Uint8Array, pageIndex: number): Uint8Array {
  const material = new Uint8Array(32);
  material.set(rootIv, 0);
  const ascii = String(pageIndex);
  for (let i = 0; i < ascii.length; i++) material[rootIv.length + i] = ascii.charCodeAt(i);
  return md5(material);
}

/**
 * Decrypt a Tesla encrypted container into a plain MP4 byte array.
 *
 * @param buf   the full encrypted file bytes
 * @param key   the raw 16-byte AES key for this file
 * @param onProgress optional callback (0..1) invoked periodically
 */
export function decryptTeslaContainer(
  buf: Uint8Array,
  key: Uint8Array,
  onProgress?: (fraction: number) => void
): Uint8Array {
  const { plaintextSize } = parseTeslaHeader(buf);
  const rootIv = md5(key);

  const out = new Uint8Array(plaintextSize);
  let written = 0;
  let page = 0;
  let offset = CIPHERTEXT_OFFSET;
  const pageBuf = new Uint8Array(PAGE_SIZE);
  const totalPages = Math.ceil(plaintextSize / PAGE_SIZE);

  while (written < plaintextSize) {
    if (offset + PAGE_SIZE > buf.length) {
      throw new Error('Encrypted payload is truncated');
    }
    pageBuf.set(buf.subarray(offset, offset + PAGE_SIZE));
    const iv = derivePageIv(rootIv, page);

    const remaining = plaintextSize - written;
    if (remaining >= PAGE_SIZE) {
      aes128CbcDecryptNoPad(pageBuf, key, iv, out, written);
      written += PAGE_SIZE;
    } else {
      // Final partial page: decrypt into a scratch block then copy the tail.
      const scratch = new Uint8Array(PAGE_SIZE);
      aes128CbcDecryptNoPad(pageBuf, key, iv, scratch, 0);
      out.set(scratch.subarray(0, remaining), written);
      written += remaining;
    }

    offset += PAGE_SIZE;
    page += 1;
    if (onProgress && (page % 64 === 0 || written >= plaintextSize)) {
      onProgress(page / totalPages);
    }
  }

  return out;
}

const PKCS7_FULL_BLOCK = new Uint8Array(16).fill(16);
const ZERO_IV = new Uint8Array(16);

/**
 * Decrypt one 4096-byte page with the browser's native AES-CBC.
 *
 * WebCrypto's AES-CBC always strips PKCS7 padding, but Tesla's pages are raw
 * (a whole number of blocks, no padding). To use it anyway we append one
 * crafted cipher block `X` so that WebCrypto decrypts a 257th block equal to a
 * full PKCS7 padding block (16 × 0x10) and strips exactly it, leaving our 4096
 * plaintext bytes. For CBC, that trailing block decrypts to
 *   P = Dec(X) XOR C_last   ⇒   choosing X = Enc(0x10¹⁶ XOR C_last) gives P = 0x10¹⁶.
 * `Enc(·)` of a single block is a CBC encryption with a zero IV.
 */
async function decryptPageWebCrypto(
  cryptoKey: CryptoKey,
  cipherPage: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cLast = cipherPage.subarray(PAGE_SIZE - 16);
  const encInput = new Uint8Array(16);
  for (let i = 0; i < 16; i++) encInput[i] = PKCS7_FULL_BLOCK[i] ^ cLast[i];

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ZERO_IV }, cryptoKey, encInput as BufferSource)
  );
  const padBlock = encrypted.subarray(0, 16);

  const data = new Uint8Array(PAGE_SIZE + 16);
  data.set(cipherPage, 0);
  data.set(padBlock, PAGE_SIZE);

  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, cryptoKey, data as BufferSource)
  );
}

/**
 * Decrypt a Tesla encrypted container into a plain MP4 Blob using the browser's
 * native AES (WebCrypto) — dramatically faster than the pure-JS fallback.
 * Pages are processed in concurrent batches to saturate the crypto engine while
 * keeping the main thread responsive, with periodic progress reporting.
 */
export async function decryptTeslaFile(
  buf: Uint8Array,
  key: Uint8Array,
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  const { plaintextSize } = parseTeslaHeader(buf);

  // Fall back to the synchronous pure-JS path where WebCrypto is unavailable
  // (e.g. non-secure context). Correct, just slower.
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return new Blob([decryptTeslaContainer(buf, key, onProgress) as BlobPart], {
      type: 'video/mp4',
    });
  }

  const rootIv = md5(key);
  const out = new Uint8Array(plaintextSize);
  const totalPages = Math.ceil(plaintextSize / PAGE_SIZE);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-CBC', false, [
    'encrypt',
    'decrypt',
  ]);

  const CONCURRENCY = 64; // pages decrypted in parallel per batch
  for (let start = 0; start < totalPages; start += CONCURRENCY) {
    const end = Math.min(start + CONCURRENCY, totalPages);
    const tasks: Promise<void>[] = [];
    for (let page = start; page < end; page++) {
      const offset = CIPHERTEXT_OFFSET + page * PAGE_SIZE;
      if (offset + PAGE_SIZE > buf.length) throw new Error('Encrypted payload is truncated');
      const cipherPage = buf.subarray(offset, offset + PAGE_SIZE);
      const iv = derivePageIv(rootIv, page);
      const writeOff = page * PAGE_SIZE;
      const n = Math.min(PAGE_SIZE, plaintextSize - writeOff);
      tasks.push(
        decryptPageWebCrypto(cryptoKey, cipherPage, iv).then((plain) => {
          out.set(plain.subarray(0, n), writeOff);
        })
      );
    }
    await Promise.all(tasks);
    onProgress?.(Math.min(end * PAGE_SIZE, plaintextSize) / plaintextSize);
  }

  return new Blob([out as BlobPart], { type: 'video/mp4' });
}
