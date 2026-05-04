/**
 * TracingMiddleware — exercises before/after/onError span lifecycle (Issue #42).
 *
 * Uses an in-memory tracer stub so tests don't depend on @opentelemetry/api.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TracingMiddleware,
  CTX_TRACING_SPAN_ID,
  type OtelTracer,
  type OtelSpan,
} from '../../src/middleware/tracing.js';
import { Context } from '../../src/context.js';

interface RecordedSpan extends OtelSpan {
  readonly name: string;
  readonly attributes: Record<string, string>;
  status: { code: number; message?: string } | null;
  ended: boolean;
}

function makeTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: OtelTracer = {
    startSpan(name: string): OtelSpan {
      const attributes: Record<string, string> = {};
      let status: { code: number; message?: string } | null = null;
      const id = `span-${spans.length + 1}`;
      const span: RecordedSpan = {
        name,
        attributes,
        get status() { return status; },
        set status(v) { status = v; },
        ended: false,
        spanContext() {
          return { spanId: id };
        },
        setAttribute(k: string, v: string): void { attributes[k] = v; },
        setStatus(s: { code: number; message?: string }): void { status = s; },
        end(): void { (span as { ended: boolean }).ended = true; },
      };
      spans.push(span);
      return span;
    },
  };
  return { tracer, spans };
}

function makeContext(): Context {
  return new Context('trace-abc', 'caller-1', [], null, null);
}

describe('TracingMiddleware', () => {
  it('before() starts a span, sets attributes, and stashes the span_id in context.data', () => {
    const { tracer, spans } = makeTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = makeContext();

    mw.before('mod.a', {}, ctx);

    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('mod.a');
    expect(spans[0].attributes['apcore.trace_id']).toBe('trace-abc');
    expect(spans[0].attributes['apcore.caller_id']).toBe('caller-1');
    expect(spans[0].attributes['apcore.module_id']).toBe('mod.a');
    expect(ctx.data[CTX_TRACING_SPAN_ID]).toBe('span-1');
  });

  it('after() ends the active span with OK status', () => {
    const { tracer, spans } = makeTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = makeContext();

    mw.before('mod.b', {}, ctx);
    mw.after('mod.b', {}, {}, ctx);

    expect(spans[0].status).toEqual({ code: 1 });
    expect(spans[0].ended).toBe(true);
  });

  it('onError() ends the active span with ERROR status and the error message', () => {
    const { tracer, spans } = makeTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = makeContext();

    mw.before('mod.c', {}, ctx);
    mw.onError('mod.c', {}, new Error('boom'), ctx);

    expect(spans[0].status?.code).toBe(2);
    expect(spans[0].status?.message).toContain('boom');
    expect(spans[0].ended).toBe(true);
  });

  it('after() and onError() are no-ops when before() did not run', () => {
    const { tracer, spans } = makeTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = makeContext();

    expect(() => mw.after('m', {}, {}, ctx)).not.toThrow();
    expect(() => mw.onError('m', {}, new Error('x'), ctx)).not.toThrow();
    expect(spans.length).toBe(0);
  });

  it('after()/onError() ignore non-span values stored under the active-span key', () => {
    const { tracer } = makeTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = makeContext();

    // Plant garbage under the internal key without going through before().
    ctx.data['_apcore.mw.tracing._active_span'] = { not: 'a span' };

    expect(() => mw.after('m', {}, {}, ctx)).not.toThrow();
    expect(() => mw.onError('m', {}, new Error(), ctx)).not.toThrow();
  });

  it('null tracer makes before() a silent no-op', () => {
    const mw = new TracingMiddleware({ tracer: null });
    const ctx = makeContext();

    expect(mw.before('m', {}, ctx)).toBeNull();
    expect(ctx.data[CTX_TRACING_SPAN_ID]).toBeUndefined();
  });

  it('serviceName is passed through when no explicit tracer is given (no-op when OTel absent)', () => {
    // OTel is not installed in tests, so the resulting middleware is a no-op.
    const mw = new TracingMiddleware({ serviceName: 'svc' });
    const ctx = makeContext();
    expect(() => mw.before('m', {}, ctx)).not.toThrow();
  });

  it('before() swallows tracer errors and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracer: OtelTracer = {
      startSpan(): OtelSpan { throw new Error('tracer down'); },
    };
    const mw = new TracingMiddleware({ tracer });
    const ctx = makeContext();

    expect(() => mw.before('m', {}, ctx)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('handles a context with no callerId (sets attribute to empty string)', () => {
    const { tracer, spans } = makeTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = new Context('trace-1', null, [], null, null);
    mw.before('m', {}, ctx);
    expect(spans[0].attributes['apcore.caller_id']).toBe('');
  });
});
