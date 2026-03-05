/**
 * Call chain safety guard (Algorithm A20).
 */

import {
  CallDepthExceededError,
  CallFrequencyExceededError,
  CircularCallError,
} from '../errors.js';

export const DEFAULT_MAX_CALL_DEPTH = 32;
export const DEFAULT_MAX_MODULE_REPEAT = 3;

/**
 * Validate call chain safety (Algorithm A20).
 *
 * Performs three checks in order:
 * 1. Depth limit -- call chain length must not exceed maxCallDepth.
 * 2. Circular detection -- strict cycles of length >= 2 (A->B->A).
 * 3. Frequency throttle -- moduleId must not appear more than maxModuleRepeat times.
 *
 * @param moduleId - The module about to be called.
 * @param callChain - Current call chain (should already include moduleId at the end).
 * @param maxCallDepth - Maximum allowed chain length.
 * @param maxModuleRepeat - Maximum times a module may appear in the chain.
 * @throws {CallDepthExceededError} Chain too deep.
 * @throws {CircularCallError} Circular call detected.
 * @throws {CallFrequencyExceededError} Module called too many times.
 */
export function guardCallChain(
  moduleId: string,
  callChain: readonly string[],
  maxCallDepth: number = DEFAULT_MAX_CALL_DEPTH,
  maxModuleRepeat: number = DEFAULT_MAX_MODULE_REPEAT,
): void {
  if (maxCallDepth < 1) {
    throw new Error(`maxCallDepth must be >= 1, got ${maxCallDepth}`);
  }
  if (maxModuleRepeat < 1) {
    throw new Error(`maxModuleRepeat must be >= 1, got ${maxModuleRepeat}`);
  }

  const chain = [...callChain];

  // 1. Depth check
  if (chain.length > maxCallDepth) {
    throw new CallDepthExceededError(chain.length, maxCallDepth, chain);
  }

  // 2. Circular detection (strict cycles of length >= 2)
  const priorChain = chain.slice(0, -1);
  const lastIdx = priorChain.lastIndexOf(moduleId);
  if (lastIdx !== -1) {
    const subsequence = priorChain.slice(lastIdx + 1);
    if (subsequence.length > 0) {
      throw new CircularCallError(moduleId, chain);
    }
  }

  // 3. Frequency check
  const count = chain.filter((id) => id === moduleId).length;
  if (count > maxModuleRepeat) {
    throw new CallFrequencyExceededError(moduleId, count, maxModuleRepeat, chain);
  }
}
