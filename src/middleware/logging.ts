/**
 * LoggingMiddleware for structured module call logging.
 */

import type { Context } from '../context.js';
import { Middleware } from './base.js';

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

const defaultLogger: Logger = {
  info(message: string, extra?: Record<string, unknown>) {
    console.info(`[apcore:middleware.logging] ${message}`, extra ?? '');
  },
  error(message: string, extra?: Record<string, unknown>) {
    console.error(`[apcore:middleware.logging] ${message}`, extra ?? '');
  },
};

export class LoggingMiddleware extends Middleware {
  private _logger: Logger;
  private _logInputs: boolean;
  private _logOutputs: boolean;
  private _logErrors: boolean;

  constructor(options?: {
    logger?: Logger;
    logInputs?: boolean;
    logOutputs?: boolean;
    logErrors?: boolean;
  }) {
    super(700);
    this._logger = options?.logger ?? defaultLogger;
    this._logInputs = options?.logInputs ?? true;
    this._logOutputs = options?.logOutputs ?? true;
    this._logErrors = options?.logErrors ?? true;
  }

  override before(
    moduleId: string,
    inputs: Record<string, unknown>,
    context: Context,
  ): null {
    context.data['_apcore.mw.logging.start_time'] = performance.now();

    if (this._logInputs) {
      const redacted = context.redactedInputs ?? inputs;
      this._logger.info(`[${context.traceId}] START ${moduleId}`, {
        traceId: context.traceId,
        moduleId,
        callerId: context.callerId,
        inputs: redacted,
      });
    }

    return null;
  }

  override after(
    moduleId: string,
    _inputs: Record<string, unknown>,
    output: Record<string, unknown>,
    context: Context,
  ): null {
    const startTime = (context.data['_apcore.mw.logging.start_time'] as number) ?? performance.now();
    const durationMs = performance.now() - startTime;

    if (this._logOutputs) {
      // Use the schema-aware redacted output when the executor produced one;
      // the executor's redaction only ran on context.redactedOutput and not
      // on the raw `output` argument.
      const redactedOutput = context.redactedOutput ?? output;
      this._logger.info(
        `[${context.traceId}] END ${moduleId} (${durationMs.toFixed(2)}ms)`,
        {
          traceId: context.traceId,
          moduleId,
          durationMs,
          output: redactedOutput,
        },
      );
    }

    return null;
  }

  override onError(
    moduleId: string,
    inputs: Record<string, unknown>,
    error: Error,
    context: Context,
  ): null {
    if (this._logErrors) {
      const redacted = context.redactedInputs ?? inputs;
      this._logger.error(`[${context.traceId}] ERROR ${moduleId}: ${error}`, {
        traceId: context.traceId,
        moduleId,
        error: String(error),
        inputs: redacted,
      });
    }

    return null;
  }
}
