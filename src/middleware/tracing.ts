/**
 * TracingMiddleware — OpenTelemetry-compatible span lifecycle management (Issue #42).
 *
 * Behaviour:
 *   - before(): creates a span named after the module_id, sets apcore.* attributes,
 *               and stores the span_id in context.data["_apcore.mw.tracing.span_id"].
 *   - after():  ends the span with status OK.
 *   - onError(): ends the span with status ERROR.
 *   - If @opentelemetry/api is not installed (and no tracer is injected), all methods
 *     are silent no-ops.
 */

import { createRequire } from 'node:module';
import type { Context } from '../context.js';
import { Middleware } from './base.js';

export const CTX_TRACING_SPAN_ID = '_apcore.mw.tracing.span_id';
// Internal key — stores the live Span object for retrieval in after()/onError().
// Not part of the public spec; not serialised; prefixed with _ to signal internal use.
const CTX_TRACING_SPAN = '_apcore.mw.tracing._active_span';

// OTel SpanStatusCode values (from @opentelemetry/api):
//   UNSET = 0, OK = 1, ERROR = 2
const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;

export interface OtelSpan {
  spanContext(): { spanId: string };
  setAttribute(key: string, value: string): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

export interface OtelTracer {
  startSpan(name: string, options?: Record<string, unknown>): OtelSpan;
}

// Attempt to load @opentelemetry/api synchronously via Node.js require.
// If the package is absent, _defaultTrace remains null and TracingMiddleware
// silently becomes a no-op unless a tracer is explicitly injected.
const _nodeRequire = createRequire(import.meta.url);
let _defaultTrace: { getTracer(name: string): OtelTracer } | null = null;
try {
  _defaultTrace = (_nodeRequire('@opentelemetry/api') as { trace: { getTracer(n: string): OtelTracer } }).trace;
} catch {
  _defaultTrace = null;
}

export interface TracingMiddlewareOptions {
  /** OTel service name used when initialising the default tracer. Default: 'apcore' */
  serviceName?: string;
  /**
   * Inject a custom tracer (primarily for testing).
   * When provided this takes precedence over auto-detected OTel.
   * Pass `null` to force no-op mode even if OTel is installed.
   */
  tracer?: OtelTracer | null;
  /** Middleware priority (0–1000). Default: 800 */
  priority?: number;
}

export class TracingMiddleware extends Middleware {
  private readonly _tracer: OtelTracer | null;

  constructor(options: TracingMiddlewareOptions = {}) {
    super(options.priority ?? 800);

    if ('tracer' in options) {
      this._tracer = options.tracer ?? null;
    } else {
      const name = options.serviceName ?? 'apcore';
      this._tracer = _defaultTrace ? _defaultTrace.getTracer(name) : null;
    }
  }

  /** Type-safe accessor for the active span stored by before(). */
  private _activeSpan(context: Context): OtelSpan | null {
    const val = context.data[CTX_TRACING_SPAN];
    if (val == null) return null;
    // Minimal shape check: any valid OtelSpan must expose an `end` method.
    if (typeof val === 'object' && typeof (val as OtelSpan).end === 'function') {
      return val as OtelSpan;
    }
    return null;
  }

  override before(
    moduleId: string,
    _inputs: Record<string, unknown>,
    context: Context,
  ): Record<string, unknown> | null {
    if (!this._tracer) return null;

    try {
      const span = this._tracer.startSpan(moduleId);
      span.setAttribute('apcore.trace_id', context.traceId);
      span.setAttribute('apcore.caller_id', context.callerId ?? '');
      span.setAttribute('apcore.module_id', moduleId);

      context.data[CTX_TRACING_SPAN_ID] = span.spanContext().spanId;
      context.data[CTX_TRACING_SPAN] = span;
    } catch (err) {
      console.warn(`[apcore:middleware] TracingMiddleware: span creation failed for '${moduleId}':`, err);
    }

    return null;
  }

  override after(
    _moduleId: string,
    _inputs: Record<string, unknown>,
    _output: Record<string, unknown>,
    context: Context,
  ): Record<string, unknown> | null {
    const span = this._activeSpan(context);
    if (span) {
      span.setStatus({ code: SPAN_STATUS_OK });
      span.end();
    }
    return null;
  }

  override onError(
    _moduleId: string,
    _inputs: Record<string, unknown>,
    error: Error,
    context: Context,
  ): Record<string, unknown> | null {
    const span = this._activeSpan(context);
    if (span) {
      span.setStatus({ code: SPAN_STATUS_ERROR, message: String(error) });
      span.end();
    }
    return null;
  }
}
