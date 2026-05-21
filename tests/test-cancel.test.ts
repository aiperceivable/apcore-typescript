import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { CancelToken, ExecutionCancelledError } from '../src/cancel.js';
import { Context } from '../src/context.js';
import { Executor } from '../src/executor.js';
import { FunctionModule } from '../src/decorator.js';
import { Registry } from '../src/registry/registry.js';

describe('CancelToken', () => {
  it('is initially not cancelled', () => {
    const token = new CancelToken();
    expect(token.isCancelled).toBe(false);
  });

  it('sets flag after cancel()', () => {
    const token = new CancelToken();
    token.cancel();
    expect(token.isCancelled).toBe(true);
  });

  it('check() does nothing when not cancelled', () => {
    const token = new CancelToken();
    expect(() => token.check()).not.toThrow();
  });

  it('check() throws ExecutionCancelledError when cancelled', () => {
    const token = new CancelToken();
    token.cancel();
    expect(() => token.check()).toThrow(ExecutionCancelledError);
  });

  it('reset() clears cancellation', () => {
    const token = new CancelToken();
    token.cancel();
    expect(token.isCancelled).toBe(true);
    token.reset();
    expect(token.isCancelled).toBe(false);
    expect(() => token.check()).not.toThrow();
  });
});

describe('CancelToken D-18 — real abort via AbortSignal', () => {
  it('exposes an AbortSignal that is not aborted initially', () => {
    const token = new CancelToken();
    expect(token.signal).toBeInstanceOf(AbortSignal);
    expect(token.signal.aborted).toBe(false);
  });

  it('aborts the AbortSignal when cancel() is called', () => {
    const token = new CancelToken();
    const observed: boolean[] = [];
    token.signal.addEventListener('abort', () => observed.push(true));
    token.cancel();
    expect(token.signal.aborted).toBe(true);
    expect(observed).toEqual([true]);
  });

  it('reset() installs a fresh non-aborted signal', () => {
    const token = new CancelToken();
    const oldSignal = token.signal;
    token.cancel();
    expect(oldSignal.aborted).toBe(true);
    token.reset();
    expect(token.signal).not.toBe(oldSignal);
    expect(token.signal.aborted).toBe(false);
  });
});

describe('Context.signal D-18 — exposes cancel signal to modules', () => {
  it('returns the cancel token signal when one is bound', () => {
    const token = new CancelToken();
    const ctx = new Context('t', null, [], null, null, null, {}, token);
    expect(ctx.signal).toBe(token.signal);
  });

  it('returns a never-aborted signal when no cancel token is bound', () => {
    const ctx = new Context('t', null, [], null, null, null, {}, null);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });
});

describe('Executor cancellation', () => {
  it('respects cancelled token before execution', async () => {
    const registry = new Registry();
    const mod = new FunctionModule({
      execute: () => ({ result: 'ok' }),
      moduleId: 'test.module',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ result: Type.String() }),
      description: 'Simple module',
    });
    registry.register('test.module', mod);

    const executor = new Executor({ registry });
    const token = new CancelToken();
    token.cancel();

    const ctx = new Context(
      'trace-1',
      null,
      [],
      executor,
      null,
      null,
      {},
      token,
    );

    await expect(executor.call('test.module', {}, ctx)).rejects.toThrow(ExecutionCancelledError);
  });

  it('D-18 — cancelling mid-execution interrupts an awaiting module via signal', async () => {
    // Regression for A-D-AT-02 / D-18: a module that awaits the cancel signal
    // (e.g. via AbortSignal.timeout or fetch's signal option) must be
    // interrupted by cancelToken.cancel() rather than running to completion.
    const registry = new Registry();
    let moduleFinished = false;

    const mod = new FunctionModule({
      execute: async (_inputs, context) => {
        // Simulate a Web-API I/O call that participates in the signal.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => { moduleFinished = true; resolve(); }, 5000);
          context!.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted via signal'));
          });
        });
        return { result: 'never' };
      },
      moduleId: 'test.longrun',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ result: Type.String() }),
      description: 'long-running module',
    });
    registry.register('test.longrun', mod);

    const executor = new Executor({ registry });
    const token = new CancelToken();
    const ctx = new Context('trace-1', null, [], executor, null, null, {}, token);

    const callPromise = executor.call('test.longrun', {}, ctx);
    // Allow the module's await to start
    await new Promise((r) => setTimeout(r, 20));
    token.cancel();

    await expect(callPromise).rejects.toThrow();
    expect(moduleFinished).toBe(false);
  });
});
