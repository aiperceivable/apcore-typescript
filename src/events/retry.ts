/**
 * Retry configuration types and helpers for event delivery.
 */

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

/** Default retry settings when a subscriber configures retry but omits individual fields. */
export const DEFAULT_RETRY: ResolvedRetryConfig = {
  maxAttempts: 3,
  initialBackoffMs: 100,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2.0,
};

/**
 * Merge caller-supplied retry config with defaults.
 * A caller that does NOT supply `retry` gets `maxAttempts: 1` (no retry) to
 * preserve backward-compatible fire-and-forget behavior.
 */
export function resolveRetry(config?: RetryConfig): ResolvedRetryConfig {
  if (config === undefined) {
    // No retry config → single attempt (backward compatible)
    return { ...DEFAULT_RETRY, maxAttempts: 1 };
  }
  return { ...DEFAULT_RETRY, ...config };
}

/** Exponential-backoff delay for attempt `attempt` (0-based). */
export function computeDelayMs(cfg: ResolvedRetryConfig, attempt: number): number {
  return Math.min(
    cfg.maxBackoffMs,
    Math.floor(cfg.initialBackoffMs * Math.pow(cfg.backoffMultiplier, attempt)),
  );
}
