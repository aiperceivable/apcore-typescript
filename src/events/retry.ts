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

const _patternCache = new Map<string, RegExp>();

/** Glob pattern matching supporting * (any chars) and ? (single char). Cached per pattern. */
export function fnmatch(text: string, pattern: string): boolean {
  let regex = _patternCache.get(pattern);
  if (regex === undefined) {
    const regexStr = Array.from(pattern)
      .map((c) => {
        if (c === '*') return '.*';
        if (c === '?') return '.';
        return c.replace(/[$()*+.?[\]^{|}-]/g, '\\$&');
      })
      .join('');
    regex = new RegExp(`^${regexStr}$`);
    _patternCache.set(pattern, regex);
  }
  return regex.test(text);
}

/** Exponential-backoff delay for attempt `attempt` (0-based, clamped to ≥ 0). */
export function computeDelayMs(cfg: ResolvedRetryConfig, attempt: number): number {
  return Math.min(
    cfg.maxBackoffMs,
    Math.floor(cfg.initialBackoffMs * Math.pow(cfg.backoffMultiplier, Math.max(0, attempt))),
  );
}
