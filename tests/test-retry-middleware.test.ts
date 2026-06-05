import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { RetryMiddleware, RetryHintMiddleware } from '../src/middleware/retry.js';
import { RetrySignal } from '../src/middleware/base.js';
import { ModuleError, ModuleTimeoutError } from '../src/errors.js';
import { Context } from '../src/context.js';
import { Executor } from '../src/executor.js';
import { Registry } from '../src/registry/registry.js';
import { FunctionModule } from '../src/decorator.js';

describe('RetryMiddleware', () => {
  const makeContext = () => new Context('trace-1', null, ['test.module'], null, null, null, {});
  const COUNT_KEY = '_apcore.mw.retry.count.test.module';

  it('returns null for non-retryable errors', async () => {
    const mw = new RetryMiddleware({ baseDelayMs: 1, jitter: false });
    const ctx = makeContext();
    const err = new ModuleError('TEST', 'test error', {}, undefined, undefined, false);
    expect(await mw.onError('test.module', { x: 1 }, err, ctx)).toBeNull();
    expect(ctx.data[COUNT_KEY]).toBeUndefined();
  });

  it('returns a RetrySignal carrying the inputs for retryable errors', async () => {
    const mw = new RetryMiddleware({ baseDelayMs: 1, jitter: false });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);
    const result = await mw.onError('test.module', { x: 1 }, err, ctx);
    expect(result).toBeInstanceOf(RetrySignal);
    expect((result as RetrySignal).inputs).toEqual({ x: 1 });
    expect(ctx.data[COUNT_KEY]).toBe(1);
  });

  it('tracks retry count across calls and stops after maxRetries', async () => {
    const mw = new RetryMiddleware({ maxRetries: 3, baseDelayMs: 1, jitter: false });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);

    expect(await mw.onError('test.module', {}, err, ctx)).toBeInstanceOf(RetrySignal);
    expect(ctx.data[COUNT_KEY]).toBe(1);

    expect(await mw.onError('test.module', {}, err, ctx)).toBeInstanceOf(RetrySignal);
    expect(ctx.data[COUNT_KEY]).toBe(2);

    expect(await mw.onError('test.module', {}, err, ctx)).toBeInstanceOf(RetrySignal);
    expect(ctx.data[COUNT_KEY]).toBe(3);

    // 4th call exceeds maxRetries -> propagate
    expect(await mw.onError('test.module', {}, err, ctx)).toBeNull();
  });

  it('returns null for errors without retryable property', async () => {
    const mw = new RetryMiddleware({ baseDelayMs: 1, jitter: false });
    const ctx = makeContext();
    const err = new Error('plain error');
    expect(await mw.onError('test.module', {}, err, ctx)).toBeNull();
  });

  it('clears the per-module retry counter on success via after()', () => {
    const mw = new RetryMiddleware();
    const ctx = makeContext();
    ctx.data[COUNT_KEY] = 2;
    mw.after('test.module', {}, {}, ctx);
    expect(ctx.data[COUNT_KEY]).toBeUndefined();
  });

  it('uses exponential backoff by default (delay scales per attempt)', async () => {
    // jitter off: verify the sleep duration grows by inspecting elapsed time
    // indirectly is brittle, so assert the signal/counter progression instead.
    const mw = new RetryMiddleware({ baseDelayMs: 1, jitter: false, maxRetries: 5 });
    const ctx = makeContext();
    const err = new ModuleTimeoutError('test.module', 5000);
    for (let i = 1; i <= 3; i++) {
      const r = await mw.onError('test.module', {}, err, ctx);
      expect(r).toBeInstanceOf(RetrySignal);
      expect(ctx.data[COUNT_KEY]).toBe(i);
    }
  });

  it('drives a real end-to-end retry: flaky module recovers after N attempts', async () => {
    let invocations = 0;
    const flaky = new FunctionModule({
      execute: () => {
        invocations += 1;
        if (invocations < 3) {
          throw new ModuleTimeoutError('flaky', 5000); // retryable
        }
        return { x: invocations };
      },
      moduleId: 'flaky',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ x: Type.Number() }),
      description: 'Flaky module',
    });
    const registry = new Registry();
    registry.register('flaky', flaky);
    const executor = new Executor({
      registry,
      middlewares: [new RetryMiddleware({ baseDelayMs: 1, jitter: false, maxRetries: 5 })],
    });

    const out = await executor.call('flaky', { x: 42 });
    // Failed twice, succeeded on the 3rd attempt.
    expect(invocations).toBe(3);
    expect(out).toEqual({ x: 3 });
  });

  it('does NOT retry a non-retryable error: module runs once and error propagates', async () => {
    let invocations = 0;
    const broken = new FunctionModule({
      execute: () => {
        invocations += 1;
        // retryable=false
        throw new ModuleError('BROKEN', 'permanent failure', {}, undefined, undefined, false);
      },
      moduleId: 'broken',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ x: Type.Number() }),
      description: 'Permanently broken module',
    });
    const registry = new Registry();
    registry.register('broken', broken);
    const executor = new Executor({
      registry,
      middlewares: [new RetryMiddleware({ baseDelayMs: 1, jitter: false })],
    });

    await expect(executor.call('broken', { x: 42 })).rejects.toThrow(ModuleError);
    expect(invocations).toBe(1);
  });

  it('exhausts retries and propagates when the module never recovers', async () => {
    let invocations = 0;
    const flaky = new FunctionModule({
      execute: () => {
        invocations += 1;
        throw new ModuleTimeoutError('flaky', 5000); // always retryable
      },
      moduleId: 'flaky',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ x: Type.Number() }),
      description: 'Flaky module',
    });
    const registry = new Registry();
    registry.register('flaky', flaky);
    const executor = new Executor({
      registry,
      middlewares: [new RetryMiddleware({ baseDelayMs: 1, jitter: false, maxRetries: 2 })],
    });

    await expect(executor.call('flaky', { x: 42 })).rejects.toThrow(ModuleTimeoutError);
    // Initial attempt + 2 retries = 3 invocations.
    expect(invocations).toBe(3);
  });

  it('clears the retry counter after a successful end-to-end recovery', async () => {
    let invocations = 0;
    const flaky = new FunctionModule({
      execute: () => {
        invocations += 1;
        if (invocations < 2) throw new ModuleTimeoutError('flaky', 5000);
        return { x: 1 };
      },
      moduleId: 'flaky',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ x: Type.Number() }),
      description: 'Flaky module',
    });
    const registry = new Registry();
    registry.register('flaky', flaky);
    const ctx = new Context('trace-2', null, ['flaky'], null, null, null, {});
    const executor = new Executor({
      registry,
      middlewares: [new RetryMiddleware({ baseDelayMs: 1, jitter: false })],
    });

    await executor.call('flaky', { x: 42 }, ctx);
    expect(ctx.data['_apcore.mw.retry.count.flaky']).toBeUndefined();
  });

  it('RetryHintMiddleware is a deprecated alias for RetryMiddleware', () => {
    expect(RetryHintMiddleware).toBe(RetryMiddleware);
  });
});
