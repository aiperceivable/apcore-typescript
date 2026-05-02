/**
 * MiddlewareManager -- onion model execution engine for the middleware pipeline.
 */

import type { Context } from '../context.js';
import { ModuleError } from '../errors.js';
import { Middleware, RetrySignal } from './base.js';

export class MiddlewareChainError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  readonly original: Error;
  readonly executedMiddlewares: Middleware[];

  constructor(original: Error, executedMiddlewares: Middleware[]) {
    super('MIDDLEWARE_CHAIN_ERROR', String(original), undefined, original);
    this.name = 'MiddlewareChainError';
    this.original = original;
    this.executedMiddlewares = executedMiddlewares;
  }
}

export class MiddlewareManager {
  private _middlewares: Middleware[] = [];

  add(middleware: Middleware): void {
    // Stable insertion: find the first middleware with a strictly lower priority
    // and insert before it. This keeps higher-priority middlewares first and
    // preserves registration order among equal priorities.
    let insertAt = this._middlewares.length;
    for (let i = 0; i < this._middlewares.length; i++) {
      if (this._middlewares[i].priority < middleware.priority) {
        insertAt = i;
        break;
      }
    }
    this._middlewares.splice(insertAt, 0, middleware);
  }

  remove(middleware: Middleware): boolean {
    for (let i = 0; i < this._middlewares.length; i++) {
      if (this._middlewares[i] === middleware) {
        this._middlewares.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  snapshot(): Middleware[] {
    return [...this._middlewares];
  }

  /**
   * Run all `before` hooks in priority-descending order, awaiting any Promise
   * a middleware returns.
   *
   * Always-async (sync finding A-D-403) — matches apcore-rust's design and
   * removes the silent-Promise-into-currentInputs trap.
   */
  async executeBefore(
    moduleId: string,
    inputs: Record<string, unknown>,
    context: Context,
  ): Promise<[Record<string, unknown>, Middleware[]]> {
    let currentInputs = inputs;
    const executedMiddlewares: Middleware[] = [];
    const middlewares = this.snapshot();

    for (const mw of middlewares) {
      executedMiddlewares.push(mw);
      try {
        const result = await mw.before(moduleId, currentInputs, context);
        if (result !== null && result !== undefined) {
          currentInputs = result as Record<string, unknown>;
        }
      } catch (e) {
        throw new MiddlewareChainError(e as Error, executedMiddlewares);
      }
    }

    return [currentInputs, executedMiddlewares];
  }

  async executeAfter(
    moduleId: string,
    inputs: Record<string, unknown>,
    output: Record<string, unknown>,
    context: Context,
  ): Promise<Record<string, unknown>> {
    let currentOutput = output;
    const middlewares = this.snapshot();

    // Fail-fast: propagate the first error immediately (matches Python/Rust behaviour).
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const result = await middlewares[i].after(moduleId, inputs, currentOutput, context);
      if (result !== null && result !== undefined) {
        currentOutput = result as Record<string, unknown>;
      }
    }

    return currentOutput;
  }

  async executeOnError(
    moduleId: string,
    inputs: Record<string, unknown>,
    error: Error,
    context: Context,
    executedMiddlewares: Middleware[],
  ): Promise<Record<string, unknown> | RetrySignal | null> {
    for (let i = executedMiddlewares.length - 1; i >= 0; i--) {
      try {
        const result = await executedMiddlewares[i].onError(moduleId, inputs, error, context);
        // Strict recovery type check (sync finding A-D-404):
        // only a non-null object or a RetrySignal counts as recovery.
        // `undefined` (typical of arrow functions without a return) does NOT trigger recovery.
        if (
          result !== null
          && result !== undefined
          && (result instanceof RetrySignal || (typeof result === 'object'))
        ) {
          // RetrySignal short-circuits and propagates up to the executor's
          // call() loop, which re-runs the pipeline with new inputs.
          // Plain objects become the recovery output. (sync finding A-D-017)
          return result;
        }
      } catch (e) {
        console.warn('[apcore:middleware] Error in onError handler, continuing:', e);
        continue;
      }
    }
    return null;
  }
}
