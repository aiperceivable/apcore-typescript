import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import { AsyncTaskManager, InMemoryTaskStore } from '../src/async-task.js';
import { CancelToken } from '../src/cancel.js';
import { Context } from '../src/context.js';
import { Executor } from '../src/executor.js';
import { Registry } from '../src/registry/registry.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((complete) => { resolve = complete; }), resolve: () => resolve() };
}
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function cancellationFixture() {
  const started = deferred();
  const cleanup = deferred();
  const state = { cleaned: false };
  const registry = new Registry();
  registry.register('test.cleanup', {
    description: 'Cooperative execution with delayed finalization',
    inputSchema: Type.Object({}), outputSchema: Type.Object({}),
    async execute(_inputs: Record<string, unknown>, context: Context): Promise<Record<string, unknown>> {
      started.resolve();
      try {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => { resolve(); }, { once: true });
        });
      } finally {
        await cleanup.promise;
        state.cleaned = true;
      }
      return {};
    },
  });
  return { executor: Executor.fromRegistry(registry), started, cleanup, state };
}

describe('execution lifetime after prompt cancellation', () => {
  it('drains actual child execution from its root token after executor rejection', async () => {
    const fixture = cancellationFixture();
    const token = new CancelToken();
    const context = Context.create(null, null, token, {});
    const call = fixture.executor.call('test.cleanup', {}, context);
    const rejected = expect(call).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    await fixture.started.promise;
    token.cancel();
    await rejected;
    expect(fixture.state.cleaned).toBe(false);
    let drained = false;
    const draining = token.drain().then(() => { drained = true; });
    try {
      await turn();
      expect(drained).toBe(false);
    } finally { fixture.cleanup.resolve(); await draining; }
    expect(fixture.state.cleaned).toBe(true);
  });

  it('drains a timed-out child without delaying the executor deadline', async () => {
    const fixture = cancellationFixture();
    const token = new CancelToken();
    const context = Context.create(null, null, token, {}, null, Date.now() / 1000 + 0.2);
    const call = fixture.executor.call('test.cleanup', {}, context);
    const rejected = expect(call).rejects.toMatchObject({ code: 'MODULE_TIMEOUT' });
    await fixture.started.promise;
    await rejected;
    expect(fixture.state.cleaned).toBe(false);
    const draining = token.drain();
    fixture.cleanup.resolve();
    await draining;
    expect(fixture.state.cleaned).toBe(true);
  });

  it('drains an unused cancellation scope immediately', async () => {
    await expect(new CancelToken().drain()).resolves.toBeUndefined();
  });

  it.each([false, true])('joins already cancelled workers even after cleanup removes records=%s', async (removeRecords) => {
    const fixture = cancellationFixture();
    const manager = new AsyncTaskManager({ executor: fixture.executor });
    const taskId = await manager.submit('test.cleanup', {});
    await fixture.started.promise;
    await manager.cancel(taskId);
    expect(fixture.state.cleaned).toBe(false);
    await turn();
    if (removeRecords) await manager.cleanup(0);
    let stopped = false;
    const stopping = manager.shutdown().then(() => { stopped = true; });
    try {
      await turn();
      expect(stopped).toBe(false);
    } finally { fixture.cleanup.resolve(); await stopping; }
    expect(fixture.state.cleaned).toBe(true);
  });

  it('holds the concurrency slot until cancelled execution finalizers complete', async () => {
    const fixture = cancellationFixture();
    const manager = new AsyncTaskManager({ executor: fixture.executor, maxConcurrent: 1 });
    const first = await manager.submit('test.cleanup', {});
    await fixture.started.promise;
    await manager.cancel(first);
    const second = await manager.submit('test.cleanup', {});
    await turn();
    try { expect((await manager.getStatus(second))?.status).toBe('pending'); }
    finally { fixture.cleanup.resolve(); await manager.shutdown(); }
  });

  it('joins an active reaper store sweep before stop resolves', async () => {
    const started = deferred();
    const finishSweep = deferred();
    class DelayedStore extends InMemoryTaskStore {
      override async listExpired(): Promise<[]> {
        started.resolve(); await finishSweep.promise; return [];
      }
    }
    const manager = new AsyncTaskManager({ executor: cancellationFixture().executor, store: new DelayedStore() });
    const reaper = await manager.startReaper({ sweepIntervalMs: 1 });
    await started.promise;
    let stopped = false;
    const stopping = reaper.stop().then(() => { stopped = true; });
    try { await turn(); expect(stopped).toBe(false); }
    finally { finishSweep.resolve(); await stopping; await manager.shutdown(); }
  });
});
