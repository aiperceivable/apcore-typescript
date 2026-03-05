/**
 * RetryMiddleware for automatic retry of retryable module errors.
 */

import type { Context } from '../context.js';
import type { ModuleError } from '../errors.js';
import { Middleware } from './base.js';

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
 * Middleware that retries failed module executions based on error retryability.
 *
 * When onError is called with a retryable error (error.retryable === true),
 * it returns the original inputs to signal the middleware pipeline to retry.
 * The calculated delay is stored in context.data as a hint for the caller.
 * After maxRetries attempts or for non-retryable errors, returns null so the
 * error propagates.
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

    const retryKey = `_retry_count_${moduleId}`;
    const retryCount = (context.data[retryKey] as number) ?? 0;

    if (retryCount >= this._config.maxRetries) {
      console.warn(
        `[apcore:retry] Max retries (${this._config.maxRetries}) exceeded for module '${moduleId}'`,
      );
      return null;
    }

    const delayMs = this._calculateDelay(retryCount);
    context.data[retryKey] = retryCount + 1;

    console.info(
      `[apcore:retry] Retrying module '${moduleId}' (attempt ${retryCount + 1}/${this._config.maxRetries}) after ${Math.round(delayMs)}ms`,
    );

    // Synchronous onError cannot await -- schedule sleep externally.
    // In JS, the MiddlewareManager runs onError synchronously, so we block
    // via a busy wait only if strictly needed, but the better approach is
    // to return the inputs immediately and let the pipeline handle retry.
    // For compatibility with the sync Middleware base class, we return
    // inputs directly. The delay is handled via context.data hint.
    context.data[`_retry_delay_ms_${moduleId}`] = delayMs;

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
