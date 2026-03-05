/**
 * MiddlewareManager -- onion model execution engine for the middleware pipeline.
 */

import type { Context } from '../context.js';
import { ModuleError } from '../errors.js';
import { Middleware } from './base.js';

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
    this._middlewares.push(middleware);
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

  executeBefore(
    moduleId: string,
    inputs: Record<string, unknown>,
    context: Context,
  ): [Record<string, unknown>, Middleware[]] {
    let currentInputs = inputs;
    const executedMiddlewares: Middleware[] = [];
    const middlewares = this.snapshot();

    for (const mw of middlewares) {
      executedMiddlewares.push(mw);
      try {
        const result = mw.before(moduleId, currentInputs, context);
        if (result !== null) {
          currentInputs = result;
        }
      } catch (e) {
        throw new MiddlewareChainError(e as Error, executedMiddlewares);
      }
    }

    return [currentInputs, executedMiddlewares];
  }

  executeAfter(
    moduleId: string,
    inputs: Record<string, unknown>,
    output: Record<string, unknown>,
    context: Context,
  ): Record<string, unknown> {
    let currentOutput = output;
    const middlewares = this.snapshot();

    for (let i = middlewares.length - 1; i >= 0; i--) {
      const result = middlewares[i].after(moduleId, inputs, currentOutput, context);
      if (result !== null) {
        currentOutput = result;
      }
    }

    return currentOutput;
  }

  executeOnError(
    moduleId: string,
    inputs: Record<string, unknown>,
    error: Error,
    context: Context,
    executedMiddlewares: Middleware[],
  ): Record<string, unknown> | null {
    for (let i = executedMiddlewares.length - 1; i >= 0; i--) {
      try {
        const result = executedMiddlewares[i].onError(moduleId, inputs, error, context);
        if (result !== null) {
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
