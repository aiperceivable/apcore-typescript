import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { RetryMiddleware } from '../src/middleware/retry.js';
import { ModuleError, ModuleTimeoutError } from '../src/errors.js';
import { Context } from '../src/context.js';
import { Executor } from '../src/executor.js';
import { Registry } from '../src/registry/registry.js';
import { FunctionModule } from '../src/decorator.js';

describe('RetryMiddleware', () => {
  const makeContext = () => new Context('trace-1', null, ['test.module'], null, null, null, {});

  it('returns null for non-retryable errors', () => {
    const mw = new RetryMiddleware();
    const ctx = makeContext();
    const err = new ModuleError('TEST', 'test error', {}, undefined, undefined, false);
    expect(mw.onError('test.module', { x: 1 }, err, ctx)).toBeNull();
  });

  it('returns null for retryable errors (error always propagates) and records hint in context', () => {
    const mw = new RetryMiddleware();
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);
    const result = mw.onError('test.module', { x: 1 }, err, ctx);
    expect(result).toBeNull();
    expect(ctx.data['_apcore.mw.retry.count.test.module']).toBe(1);
  });

  it('tracks retry count across calls', () => {
    const mw = new RetryMiddleware({ maxRetries: 3 });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);

    mw.onError('test.module', {}, err, ctx); // attempt 1
    expect(ctx.data['_apcore.mw.retry.count.test.module']).toBe(1);

    mw.onError('test.module', {}, err, ctx); // attempt 2
    expect(ctx.data['_apcore.mw.retry.count.test.module']).toBe(2);

    mw.onError('test.module', {}, err, ctx); // attempt 3
    expect(ctx.data['_apcore.mw.retry.count.test.module']).toBe(3);

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
    expect(ctx.data['_apcore.mw.retry.delay_ms.test.module']).toBe(200);
  });

  it('uses exponential backoff by default', () => {
    const mw = new RetryMiddleware({ baseDelayMs: 100, jitter: false });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);

    mw.onError('test.module', {}, err, ctx);
    expect(ctx.data['_apcore.mw.retry.delay_ms.test.module']).toBe(100); // 100 * 2^0

    mw.onError('test.module', {}, err, ctx);
    expect(ctx.data['_apcore.mw.retry.delay_ms.test.module']).toBe(200); // 100 * 2^1

    mw.onError('test.module', {}, err, ctx);
    expect(ctx.data['_apcore.mw.retry.delay_ms.test.module']).toBe(400); // 100 * 2^2
  });

  it('caps delay at maxDelayMs', () => {
    const mw = new RetryMiddleware({ baseDelayMs: 1000, maxDelayMs: 2000, jitter: false, maxRetries: 10 });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);

    mw.onError('test.module', {}, err, ctx); // 1000
    mw.onError('test.module', {}, err, ctx); // 2000
    mw.onError('test.module', {}, err, ctx); // capped at 2000
    expect(ctx.data['_apcore.mw.retry.delay_ms.test.module']).toBe(2000);
  });

  it('returns null from onError so the error propagates (no input echoing)', async () => {
    // RetryMiddleware now always returns null — errors propagate to the caller
    // and context.data holds retry hints for outer retry loops.
    let invocations = 0;
    const flaky = new FunctionModule({
      execute: () => {
        invocations += 1;
        throw new ModuleTimeoutError('flaky', 5000);
      },
      moduleId: 'flaky',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ x: Type.Number() }),
      description: 'Flaky module',
    });
    const registry = new Registry();
    registry.register('flaky', flaky);
    const executor = new Executor({ registry, middlewares: [new RetryMiddleware()] });

    await expect(executor.call('flaky', { x: 42 })).rejects.toThrow(ModuleTimeoutError);
    // Module executed exactly once — no auto-retry.
    expect(invocations).toBe(1);
  });
});
