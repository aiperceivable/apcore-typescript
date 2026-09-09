/**
 * Retry configuration types and helpers for event delivery.
 */

import { matchGlob } from '../utils/pattern.js';

export interface RetryConfig {
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
}

export interface ResolvedRetryConfig {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
}

/**
 * Spec default retry policy (event-system.md §Per-Subscriber Retry Policy).
 * Applied when a subscriber omits the `retry` block entirely, and as the base
 * for merging when individual fields are omitted. `max_attempts` default is 3 —
 * uniform across Python/TypeScript/Rust SDKs.
 */
export const DEFAULT_RETRY: ResolvedRetryConfig = {
  maxAttempts: 3,
  initialBackoffMs: 100,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2.0,
};

/**
 * Merge caller-supplied retry config with the spec defaults.
 * A subscriber that does NOT supply `retry` receives the full DEFAULT_RETRY
 * policy (max_attempts=3), per event-system.md §Per-Subscriber Retry Policy —
 * built-in and user-registered subscribers share the same default. A subscriber
 * that explicitly sets `maxAttempts: 1` disables retry (single attempt).
 */
export function resolveRetry(config?: RetryConfig): ResolvedRetryConfig {
  if (config === undefined) {
    return { ...DEFAULT_RETRY };
  }
  return { ...DEFAULT_RETRY, ...config };
}

/**
 * Event-type pattern matching (PROTOCOL_SPEC §9.16.3, Algorithm A25).
 *
 * Kept as a named export for the call sites that already use it, but the
 * implementation is now the one shared matcher rather than a local
 * glob-to-RegExp translation. The translation happened to agree with A25 on
 * `*` and `?` and to escape `[`, so this SDK was the closest of the three —
 * but "closest" is not a contract, and the argument order (text, pattern) is
 * the reverse of A25's, which is exactly the kind of local convention that
 * makes two implementations look identical and behave differently.
 */
export function fnmatch(text: string, pattern: string): boolean {
  return matchGlob(pattern, text);
}

/** Exponential-backoff delay for attempt `attempt` (0-based, clamped to ≥ 0). */
export function computeDelayMs(cfg: ResolvedRetryConfig, attempt: number): number {
  return Math.min(
    cfg.maxBackoffMs,
    Math.floor(cfg.initialBackoffMs * Math.pow(cfg.backoffMultiplier, Math.max(0, attempt))),
  );
}
