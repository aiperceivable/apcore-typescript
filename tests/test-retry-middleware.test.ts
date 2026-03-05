import { describe, it, expect } from 'vitest';
import { RetryMiddleware } from '../src/middleware/retry.js';
import { ModuleError, ModuleTimeoutError } from '../src/errors.js';
import { Context } from '../src/context.js';

describe('RetryMiddleware', () => {
  const makeContext = () => new Context('trace-1', null, ['test.module'], null, null, null, {});

  it('returns null for non-retryable errors', () => {
    const mw = new RetryMiddleware();
    const ctx = makeContext();
    const err = new ModuleError('TEST', 'test error', {}, undefined, undefined, false);
    expect(mw.onError('test.module', { x: 1 }, err, ctx)).toBeNull();
  });

  it('returns inputs for retryable errors', () => {
    const mw = new RetryMiddleware();
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);
    const result = mw.onError('test.module', { x: 1 }, err, ctx);
    expect(result).toEqual({ x: 1 });
    expect(ctx.data['_retry_count_test.module']).toBe(1);
  });

  it('tracks retry count across calls', () => {
    const mw = new RetryMiddleware({ maxRetries: 3 });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);

    mw.onError('test.module', {}, err, ctx); // attempt 1
    expect(ctx.data['_retry_count_test.module']).toBe(1);

    mw.onError('test.module', {}, err, ctx); // attempt 2
    expect(ctx.data['_retry_count_test.module']).toBe(2);

    mw.onError('test.module', {}, err, ctx); // attempt 3
    expect(ctx.data['_retry_count_test.module']).toBe(3);

    // 4th call exceeds maxRetries
    const result = mw.onError('test.module', {}, err, ctx);
    expect(result).toBeNull();
  });

  it('returns null for errors without retryable property', () => {
    const mw = new RetryMiddleware();
    const ctx = makeContext();
    const err = new Error('plain error');
    expect(mw.onError('test.module', {}, err, ctx)).toBeNull();
  });

  it('stores delay hint in context.data', () => {
    const mw = new RetryMiddleware({ baseDelayMs: 200, jitter: false, strategy: 'fixed' });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);
    mw.onError('test.module', {}, err, ctx);
    expect(ctx.data['_retry_delay_ms_test.module']).toBe(200);
  });

  it('uses exponential backoff by default', () => {
    const mw = new RetryMiddleware({ baseDelayMs: 100, jitter: false });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);

    mw.onError('test.module', {}, err, ctx);
    expect(ctx.data['_retry_delay_ms_test.module']).toBe(100); // 100 * 2^0

    mw.onError('test.module', {}, err, ctx);
    expect(ctx.data['_retry_delay_ms_test.module']).toBe(200); // 100 * 2^1

    mw.onError('test.module', {}, err, ctx);
    expect(ctx.data['_retry_delay_ms_test.module']).toBe(400); // 100 * 2^2
  });

  it('caps delay at maxDelayMs', () => {
    const mw = new RetryMiddleware({ baseDelayMs: 1000, maxDelayMs: 2000, jitter: false, maxRetries: 10 });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);

    mw.onError('test.module', {}, err, ctx); // 1000
    mw.onError('test.module', {}, err, ctx); // 2000
    mw.onError('test.module', {}, err, ctx); // capped at 2000
    expect(ctx.data['_retry_delay_ms_test.module']).toBe(2000);
  });
});
