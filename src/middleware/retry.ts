/**
 * RetryMiddleware for automatic retry of retryable module errors.
 */

import type { Context } from '../context.js';
import type { ModuleError } from '../errors.js';
import { Middleware } from './base.js';

/** Well-known context.data key prefixes for retry state. */
export const CTX_RETRY_COUNT_PREFIX = '_apcore.mw.retry.count.';
export const CTX_RETRY_DELAY_PREFIX = '_apcore.mw.retry.delay_ms.';

export interface RetryConfig {
  maxRetries: number;
  strategy: 'exponential' | 'fixed';
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  strategy: 'exponential',
  baseDelayMs: 100,
  maxDelayMs: 5000,
  jitter: true,
};

/**
 * Advisory retry-hint middleware.
 *
 * This middleware does NOT re-invoke the failed module. It records retry
 * state and advisory delay hints in `context.data` for outer retry loops,
 * then returns null so the original error always propagates to the caller.
 *
 * Context keys written on a retryable error:
 *   - `CTX_RETRY_COUNT_PREFIX + moduleId` — number of attempts so far
 *   - `CTX_RETRY_DELAY_PREFIX + moduleId` — suggested delay in ms before retry
 *
 * If you need real retries, wrap `Executor.call` in an outer retry loop
 * that inspects `error.retryable` and the hint values above.
 */
export class RetryMiddleware extends Middleware {
  private _config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    super();
    this._config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  override onError(
    moduleId: string,
    inputs: Record<string, unknown>,
    error: Error,
    context: Context,
  ): Record<string, unknown> | null {
    const retryable = (error as ModuleError).retryable;
    if (retryable !== true) return null;

    const retryKey = `${CTX_RETRY_COUNT_PREFIX}${moduleId}`;
    const retryCount = (context.data[retryKey] as number) ?? 0;

    if (retryCount >= this._config.maxRetries) {
      console.warn(
        `[apcore:retry] Max retries (${this._config.maxRetries}) exceeded for module '${moduleId}'`,
      );
      return null;
    }

    const delayMs = this._calculateDelay(retryCount);
    context.data[retryKey] = retryCount + 1;
    context.data[`${CTX_RETRY_DELAY_PREFIX}${moduleId}`] = delayMs;

    console.warn(
      `[apcore:retry] Retryable error in '${moduleId}' (attempt ${retryCount + 1}/${this._config.maxRetries}). ` +
        `Hint written to context.data for outer retry loop (delay: ${Math.round(delayMs)}ms).`,
    );

    // Return null so the error propagates. Returning inputs here would cause
    // the executor to treat them as the recovered output — a silent footgun.
    return null;
  }

  private _calculateDelay(attempt: number): number {
    let delay: number;
    if (this._config.strategy === 'fixed') {
      delay = this._config.baseDelayMs;
    } else {
      // Exponential: baseDelayMs * 2^attempt, capped at maxDelayMs
      delay = Math.min(
        this._config.baseDelayMs * Math.pow(2, attempt),
        this._config.maxDelayMs,
      );
    }

    if (this._config.jitter) {
      delay *= 0.5 + Math.random(); // 0.5 to 1.5x
    }

    return delay;
  }
}
