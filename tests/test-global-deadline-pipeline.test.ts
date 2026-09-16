/**
 * D-99 / D-100 / D-101 — `global_deadline` clock, storage and lifetime.
 *
 * See apcore `docs/features/core-executor.md`, section
 * "`global_deadline` Representation and Lifetime" (spec v1.50.0).
 *
 * D-100 — the first-class `Context.globalDeadline` field IS the storage. The
 *   pipeline wrote and read `context.data['_apcore.executor.global_deadline']`
 *   and never consulted the field, so a caller-supplied deadline — a
 *   documented `Context.create` parameter — was silently replaced by the
 *   config default.
 * D-99 — the clock is epoch SECONDS, not `Date.now()` milliseconds. A caller
 *   following the spec writes `time.time() + budget`; against a millisecond
 *   basis that value has already expired.
 * D-101 — the deadline belongs to the call tree. `context.data` is shared by
 *   reference through `child()`, so the previous "already present?" guard saw
 *   call #1's key on call #2 and a reused Context kept the first call's budget.
 */

import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Context } from '../src/context.js';
import { Config } from '../src/config.js';
import { Registry } from '../src/registry/registry.js';
import { Executor, CTX_GLOBAL_DEADLINE } from '../src/executor.js';
import { ModuleTimeoutError } from '../src/errors.js';

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Records the deadline the pipeline handed the module, per call. */
function makeProbe(seen: Array<number | null>) {
  return {
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({ ok: Type.Boolean() }),
    description: 'records the deadline it was given',
    execute: (_inputs: Record<string, unknown>, context: Context) => {
      seen.push(context.globalDeadline);
      return { ok: true };
    },
  };
}

function build(globalTimeoutMs?: number) {
  const registry = new Registry();
  const config =
    globalTimeoutMs === undefined
      ? null
      : new Config({ executor: { global_timeout: globalTimeoutMs } });
  const executor = new Executor({ registry, config });
  return { registry, executor };
}

describe('global_deadline is carried on the Context field (D-100)', () => {
  it('a caller-supplied deadline reaches the module instead of the config default', async () => {
    const seen: Array<number | null> = [];
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.read', makeProbe(seen));

    const supplied = nowSeconds() + 5;
    const ctx = Context.create(null, null, null, undefined, null, supplied);
    await executor.call('executor.probe.read', {}, ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(supplied);
  });

  it('a caller-supplied deadline that has already passed times the call out', async () => {
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.read', makeProbe([]));

    const ctx = Context.create(null, null, null, undefined, null, nowSeconds() - 10);
    await expect(executor.call('executor.probe.read', {}, ctx)).rejects.toThrow(
      ModuleTimeoutError,
    );
  });

  it('the private data key is no longer written', async () => {
    const seen: Array<number | null> = [];
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.read', makeProbe(seen));

    const ctx = Context.create();
    await executor.call('executor.probe.read', {}, ctx);

    expect(CTX_GLOBAL_DEADLINE in ctx.data).toBe(false);
  });
});

describe('global_deadline is on the epoch-seconds clock (D-99)', () => {
  it('the computed deadline is seconds, not milliseconds', async () => {
    const seen: Array<number | null> = [];
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.read', makeProbe(seen));

    const before = nowSeconds();
    await executor.call('executor.probe.read', {});
    const after = nowSeconds();

    expect(seen).toHaveLength(1);
    const deadline = seen[0] as number;
    // 600 s of budget on the seconds clock. A millisecond basis would put this
    // roughly a thousand times higher.
    expect(deadline).toBeGreaterThanOrEqual(before + 600);
    expect(deadline).toBeLessThanOrEqual(after + 600);
  });
});

describe('global_deadline belongs to the call tree, not the Context (D-101)', () => {
  it('a caller-supplied Context is not mutated by the call', async () => {
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.read', makeProbe([]));

    const ctx = Context.create();
    expect(ctx.globalDeadline).toBeNull();
    await executor.call('executor.probe.read', {}, ctx);

    expect(ctx.globalDeadline).toBeNull();
    expect(Object.keys(ctx.data)).not.toContain(CTX_GLOBAL_DEADLINE);
  });

  it('a reused Context gets a fresh budget on the second call', async () => {
    const seen: Array<number | null> = [];
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.read', makeProbe(seen));

    const ctx = Context.create();
    await executor.call('executor.probe.read', {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 12));
    await executor.call('executor.probe.read', {}, ctx);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBeNull();
    expect(seen[1] as number).toBeGreaterThan(seen[0] as number);
  });

  it('a nested call still inherits the enclosing budget', async () => {
    const seen: Array<number | null> = [];
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.read', makeProbe(seen));
    registry.registerInternal('executor.probe.outer', {
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'calls the probe',
      execute: async (_inputs: Record<string, unknown>, context: Context) => {
        seen.push(context.globalDeadline);
        await executor.call('executor.probe.read', {}, context);
        return { ok: true };
      },
    });

    await executor.call('executor.probe.outer', {});

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });
});

describe('global_deadline is enforced between stream chunks on the same clock', () => {
  it('a passed caller deadline aborts the stream', async () => {
    const { registry, executor } = build(600_000);
    registry.registerInternal('executor.probe.stream', {
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ n: Type.Number() }),
      description: 'streams two chunks',
      annotations: { streaming: true },
      // eslint-disable-next-line require-yield
      stream: async function* () {
        yield { n: 1 };
        yield { n: 2 };
      },
      execute: () => ({ n: 0 }),
    });

    const ctx = Context.create(null, null, null, undefined, null, nowSeconds() - 10);
    await expect(async () => {
      for await (const _chunk of executor.stream('executor.probe.stream', {}, ctx)) {
        /* drain */
      }
    }).rejects.toThrow(ModuleTimeoutError);
  });
});
