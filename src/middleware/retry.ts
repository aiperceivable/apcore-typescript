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
 * **IMPORTANT:** Despite the name, this middleware does NOT cause the
 * MiddlewareManager to re-invoke the failed module. First-class
 * re-execution is not part of the middleware contract in this version.
 *
 * What this middleware actually does when onError fires on a retryable
 * error:
 *
 *   1. Increments a retry counter in `context.data` (key prefix
 *      `CTX_RETRY_COUNT_PREFIX`).
 *   2. Writes an advisory delay (ms) to `context.data` under
 *      `CTX_RETRY_DELAY_PREFIX` so an outer executor can honor it.
 *   3. Returns the original inputs. `MiddlewareManager.executeOnError`
 *      treats the first non-null return from onError as the **recovered
 *      output** and yields it to the caller — meaning the caller will see
 *      the input payload echoed back as the module's output.
 *
 * If you need real retries, wrap `Executor.call` in an outer retry loop
 * that inspects `error.retryable` and the hint values above. A first-class
 * pipeline-level retry primitive may be added in a future major version.
 *
 * After `maxRetries` attempts or for non-retryable errors, `onError`
 * returns null so the original error propagates.
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

    console.warn(
      `[apcore:retry] Retrying module '${moduleId}' (attempt ${retryCount + 1}/${this._config.maxRetries}) after ${Math.round(delayMs)}ms`,
    );

    // Synchronous onError cannot await -- schedule sleep externally.
    // In JS, the MiddlewareManager runs onError synchronously, so we block
    // via a busy wait only if strictly needed, but the better approach is
    // to return the inputs immediately and let the pipeline handle retry.
    // For compatibility with the sync Middleware base class, we return
    // inputs directly. The delay is handled via context.data hint.
    context.data[`${CTX_RETRY_DELAY_PREFIX}${moduleId}`] = delayMs;

    return { ...inputs };
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
