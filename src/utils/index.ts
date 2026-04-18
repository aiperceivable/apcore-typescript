export { matchPattern, calculateSpecificity } from './pattern.js';
export { normalizeToCanonicalId } from './normalize.js';
export { guardCallChain, DEFAULT_MAX_CALL_DEPTH, DEFAULT_MAX_MODULE_REPEAT } from './call-chain.js';
export { propagateError } from './error-propagation.js';

// Lazy-load node:crypto for environments without globalThis.crypto (Node.js < 19)
let _nodeCrypto: typeof import('node:crypto') | undefined;
try { _nodeCrypto = await import('node:crypto'); } catch { /* browser environment */ }

export function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Generate a random hex string of the given byte length.
 *
 * Uses the Web Crypto API (`crypto.getRandomValues`) when available
 * (all modern browsers, Node.js ≥ 19), falling back to `node:crypto`
 * for Node.js < 19.
 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const c = globalThis.crypto ?? _nodeCrypto?.webcrypto;
  if (c) {
    c.getRandomValues(bytes);
  } else {
    // Last-resort fallback for environments without crypto (e.g., legacy Node without webcrypto)
    console.warn('[apcore:utils] crypto unavailable — falling back to Math.random for randomHex (not cryptographically secure)');
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
