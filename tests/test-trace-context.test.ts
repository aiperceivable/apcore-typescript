import { describe, it, expect } from 'vitest';
import { TraceContext } from '../src/trace-context.js';
import type { TraceParent } from '../src/trace-context.js';
import { Context } from '../src/context.js';
import type { Span } from '../src/observability/tracing.js';

const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

describe('TraceContext.inject()', () => {
  it('produces a valid traceparent format', () => {
    const ctx = Context.create();
    const headers = TraceContext.inject(ctx);
    expect(headers).toHaveProperty('traceparent');
    expect(headers.traceparent).toMatch(TRACEPARENT_RE);
  });

  it('uses context traceId (already 32-hex)', () => {
    const ctx = Context.create();
    const headers = TraceContext.inject(ctx);
    const parts = headers.traceparent.split('-');
    // traceId is already 32-hex format, no dash stripping needed
    // Format: 00-<32hex>-<16hex>-<2hex>
    // Splitting by '-' gives: ["00", <32hex>, <16hex>, <2hex>]
    expect(parts[1]).toBe(ctx.traceId);
  });

  it('starts with version 00', () => {
    const ctx = Context.create();
    const headers = TraceContext.inject(ctx);
    expect(headers.traceparent.startsWith('00-')).toBe(true);
  });

  it('ends with trace flags 01', () => {
    const ctx = Context.create();
    const headers = TraceContext.inject(ctx);
    expect(headers.traceparent.endsWith('-01')).toBe(true);
  });

  it('uses spanId from tracing stack when available', () => {
    const ctx = Context.create();
    const fakeSpan: Span = {
      traceId: ctx.traceId,
      name: 'test',
      startTime: 0,
      spanId: 'abcdef0123456789',
      parentSpanId: null,
      attributes: {},
      endTime: null,
      status: 'ok',
      events: [],
    };
    ctx.data['_apcore.mw.tracing.spans'] = [fakeSpan];

    const headers = TraceContext.inject(ctx);
    const parts = headers.traceparent.split('-');
    expect(parts[2]).toBe('abcdef0123456789');
  });

  it('generates random parentId when no spans exist', () => {
    const ctx = Context.create();
    const headers = TraceContext.inject(ctx);
    const parts = headers.traceparent.split('-');
    const parentId = parts[2];
    expect(parentId).toHaveLength(16);
    expect(parentId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('TraceContext.extract()', () => {
  it('parses a valid traceparent header', () => {
    const headers = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
    const result = TraceContext.extract(headers);
    expect(result).not.toBeNull();
    expect(result!.version).toBe('00');
    expect(result!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(result!.parentId).toBe('00f067aa0ba902b7');
    expect(result!.traceFlags).toBe('01');
  });

  it('returns null for missing header', () => {
    const result = TraceContext.extract({});
    expect(result).toBeNull();
  });

  it('returns null for unrelated headers', () => {
    const result = TraceContext.extract({ 'other-header': 'value' });
    expect(result).toBeNull();
  });

  it('returns null for malformed traceparent', () => {
    const result = TraceContext.extract({ traceparent: 'invalid-format' });
    expect(result).toBeNull();
  });

  it('returns null for short trace_id', () => {
    const result = TraceContext.extract({ traceparent: '00-abc-00f067aa0ba902b7-01' });
    expect(result).toBeNull();
  });

  it('normalizes uppercase to lowercase', () => {
    const headers = { traceparent: '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01' };
    const result = TraceContext.extract(headers);
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('parses unsampled trace flags', () => {
    const headers = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00' };
    const result = TraceContext.extract(headers);
    expect(result).not.toBeNull();
    expect(result!.traceFlags).toBe('00');
  });

  it('returns null for all-zero trace_id', () => {
    const result = TraceContext.extract({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' });
    expect(result).toBeNull();
  });

  it('returns null for all-zero parent_id', () => {
    const result = TraceContext.extract({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' });
    expect(result).toBeNull();
  });

  it('returns null for version ff', () => {
    const result = TraceContext.extract({ traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    expect(result).toBeNull();
  });

  it('returns a frozen object', () => {
    const headers = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
    const result = TraceContext.extract(headers);
    expect(result).not.toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('TraceContext.fromTraceparent()', () => {
  it('parses a valid traceparent string', () => {
    const tp = TraceContext.fromTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(tp.version).toBe('00');
    expect(tp.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(tp.parentId).toBe('00f067aa0ba902b7');
    expect(tp.traceFlags).toBe('01');
  });

  it('throws on invalid traceparent', () => {
    expect(() => TraceContext.fromTraceparent('not-a-valid-traceparent'))
      .toThrow('Malformed traceparent');
  });

  it('throws on empty string', () => {
    expect(() => TraceContext.fromTraceparent(''))
      .toThrow('Malformed traceparent');
  });

  it('throws on missing parts', () => {
    expect(() => TraceContext.fromTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736'))
      .toThrow('Malformed traceparent');
  });

  it('throws on all-zero trace_id', () => {
    expect(() => TraceContext.fromTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'))
      .toThrow('all-zero trace_id or parent_id');
  });

  it('throws on all-zero parent_id', () => {
    expect(() => TraceContext.fromTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'))
      .toThrow('all-zero trace_id or parent_id');
  });

  it('throws on version ff', () => {
    expect(() => TraceContext.fromTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'))
      .toThrow('version ff is not allowed');
  });

  it('returns a frozen object', () => {
    const tp = TraceContext.fromTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(Object.isFrozen(tp)).toBe(true);
  });
});

describe('Round-trip: inject -> extract', () => {
  it('preserves trace_id through inject then extract', () => {
    const ctx = Context.create();
    const headers = TraceContext.inject(ctx);
    const parsed = TraceContext.extract(headers);

    expect(parsed).not.toBeNull();
    // traceId is already 32-hex format
    expect(parsed!.traceId).toBe(ctx.traceId);
  });

  it('preserves parent_id through inject then extract', () => {
    const ctx = Context.create();
    const headers = TraceContext.inject(ctx);
    const parsed = TraceContext.extract(headers);

    expect(parsed).not.toBeNull();
    const parts = headers.traceparent.split('-');
    expect(parsed!.parentId).toBe(parts[2]);
  });
});

describe('Context.create() with traceParent', () => {
  it('uses traceParent traceId as 32-hex format', () => {
    const tp: TraceParent = {
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      traceFlags: '01',
    };
    const ctx = Context.create(null, null, undefined, tp);
    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('produces a valid 32-hex string from traceParent', () => {
    const tp: TraceParent = {
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      traceFlags: '01',
    };
    const ctx = Context.create(null, null, undefined, tp);
    // Should match 32-hex format
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still works without traceParent', () => {
    const ctx = Context.create();
    expect(ctx.traceId).toBeDefined();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique traceIds without traceParent', () => {
    const ctx1 = Context.create();
    const ctx2 = Context.create();
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });

  it('full round-trip: context -> inject -> extract -> create', () => {
    const original = Context.create();
    const headers = TraceContext.inject(original);
    const parsed = TraceContext.extract(headers);
    expect(parsed).not.toBeNull();

    const restored = Context.create(null, null, undefined, parsed);
    expect(restored.traceId).toBe(original.traceId);
  });
});
