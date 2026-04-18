/**
 * Structured logging: ContextLogger and ObsLoggingMiddleware.
 */

import type { Context } from '../context.js';
import { Middleware } from '../middleware/base.js';

const LEVELS: Record<string, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const REDACTED = '***REDACTED***';

interface WritableOutput {
  write(s: string): void;
}

export class ContextLogger {
  private _name: string;
  private _format: string;
  private _level: string;
  private _levelValue: number;
  private _redactSensitive: boolean;
  private _output: WritableOutput;
  private _traceId: string | null = null;
  private _moduleId: string | null = null;
  private _callerId: string | null = null;

  constructor(options?: {
    name?: string;
    format?: string;
    level?: string;
    redactSensitive?: boolean;
    output?: WritableOutput;
  }) {
    this._name = options?.name ?? 'apcore';
    this._format = options?.format ?? 'json';
    this._level = options?.level ?? 'info';
    this._levelValue = LEVELS[this._level] ?? 20;
    this._redactSensitive = options?.redactSensitive ?? true;
    // Default output uses console.error for universal compatibility (Node.js + browser)
    this._output = options?.output ?? { write: (s: string) => console.error(s) };
  }

  static fromContext(context: Context<unknown>, name: string, options?: {
    format?: string;
    level?: string;
    redactSensitive?: boolean;
    output?: WritableOutput;
  }): ContextLogger {
    const logger = new ContextLogger({ name, ...options });
    logger._traceId = context.traceId;
    logger._moduleId = context.callChain.length > 0 ? context.callChain[context.callChain.length - 1] : null;
    logger._callerId = context.callerId;
    return logger;
  }

  private _emit(levelName: string, message: string, extra?: Record<string, unknown> | null): void {
    const levelValue = LEVELS[levelName] ?? 20;
    if (levelValue < this._levelValue) return;

    let redactedExtra = extra ?? null;
    if (extra != null && this._redactSensitive) {
      redactedExtra = {};
      for (const [k, v] of Object.entries(extra)) {
        (redactedExtra as Record<string, unknown>)[k] = k.startsWith('_secret_') ? REDACTED : v;
      }
    }

    const now = new Date();
    const entry: Record<string, unknown> = {
      timestamp: now.toISOString(),
      level: levelName,
      message,
      trace_id: this._traceId,
      module_id: this._moduleId,
      caller_id: this._callerId,
      logger: this._name,
      extra: redactedExtra,
    };

    if (this._format === 'json') {
      this._output.write(JSON.stringify(entry) + '\n');
    } else {
      const ts = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      const lvl = levelName.toUpperCase();
      const trace = this._traceId ?? 'none';
      const mod = this._moduleId ?? 'none';
      let extrasStr = '';
      if (redactedExtra) {
        extrasStr = ' ' + Object.entries(redactedExtra).map(([k, v]) => `${k}=${v}`).join(' ');
      }
      this._output.write(`${ts} [${lvl}] [trace=${trace}] [module=${mod}] ${message}${extrasStr}\n`);
    }
  }

  trace(message: string, extra?: Record<string, unknown>): void {
    this._emit('trace', message, extra);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this._emit('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this._emit('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this._emit('warn', message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this._emit('error', message, extra);
  }

  fatal(message: string, extra?: Record<string, unknown>): void {
    this._emit('fatal', message, extra);
  }
}

export class ObsLoggingMiddleware extends Middleware {
  private _logger: ContextLogger;
  private _logInputs: boolean;
  private _logOutputs: boolean;

  constructor(options?: {
    logger?: ContextLogger;
    logInputs?: boolean;
    logOutputs?: boolean;
  }) {
    super();
    this._logger = options?.logger ?? new ContextLogger({ name: 'apcore.obs_logging' });
    this._logInputs = options?.logInputs ?? true;
    this._logOutputs = options?.logOutputs ?? true;
  }

  override before(
    moduleId: string,
    inputs: Record<string, unknown>,
    context: Context,
  ): null {
    const starts = (context.data['_apcore.mw.logging.obs_starts'] as number[]) ?? [];
    starts.push(performance.now());
    context.data['_apcore.mw.logging.obs_starts'] = starts;

    const extra: Record<string, unknown> = {
      module_id: moduleId,
      caller_id: context.callerId,
    };
    if (this._logInputs) {
      extra['inputs'] = context.redactedInputs ?? inputs;
    }
    this._logger.info('Module call started', extra);
    return null;
  }

  override after(
    moduleId: string,
    _inputs: Record<string, unknown>,
    output: Record<string, unknown>,
    context: Context,
  ): null {
    const starts = context.data['_apcore.mw.logging.obs_starts'] as number[] | undefined;
    if (!starts || starts.length === 0) return null;
    const startTime = starts.pop()!;
    const durationMs = performance.now() - startTime;

    const extra: Record<string, unknown> = {
      module_id: moduleId,
      duration_ms: durationMs,
    };
    if (this._logOutputs) {
      // Prefer the executor's schema-aware redacted output so x-sensitive
      // fields (API keys, tokens) do not leak into logs. The executor has
      // already applied the schema; falling back to `output` preserves
      // behavior for callers invoking the middleware outside the pipeline.
      extra['output'] = context.redactedOutput ?? output;
    }
    this._logger.info('Module call completed', extra);
    return null;
  }

  override onError(
    moduleId: string,
    _inputs: Record<string, unknown>,
    error: Error,
    context: Context,
  ): null {
    const starts = context.data['_apcore.mw.logging.obs_starts'] as number[] | undefined;
    if (!starts || starts.length === 0) return null;
    const startTime = starts.pop()!;
    const durationMs = performance.now() - startTime;

    this._logger.error('Module call failed', {
      module_id: moduleId,
      duration_ms: durationMs,
      error_type: error.constructor.name,
      error_message: String(error),
    });
    return null;
  }
}
