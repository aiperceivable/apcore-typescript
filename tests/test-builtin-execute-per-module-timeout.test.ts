/**
 * Regression for A-D-EXEC-001 / spec D-11 (per-module timeout).
 *
 * BuiltinExecute MUST honour each module's declared `resources.timeout`
 * (milliseconds) ahead of the executor-wide default. The global deadline,
 * when present, further clamps the effective timeout — it never extends it.
 */

import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Executor } from '../src/executor.js';
import { Registry } from '../src/registry/registry.js';
import { Config } from '../src/config.js';
import { Context } from '../src/context.js';
import { ModuleTimeoutError } from '../src/errors.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('BuiltinExecute per-module timeout (D-11)', () => {
  it('uses the module-declared resources.timeout when present', async () => {
    const reg = new Registry();
    reg.register('slow.mod', {
      id: 'slow.mod',
      description: 'always slow',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      resources: { timeout: 30 },
      execute: async () => {
        await sleep(200);
        return { ok: true };
      },
    });

    const config = new Config({ executor: { default_timeout: 5000 } });
    const exec = new Executor({ registry: reg, config });
    await expect(exec.call('slow.mod', {})).rejects.toBeInstanceOf(ModuleTimeoutError);
  });

  it('reads resources.timeout from annotations.resources as well', async () => {
    const reg = new Registry();
    reg.register('slow.ann', {
      id: 'slow.ann',
      description: 'slow via annotations',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      annotations: { resources: { timeout: 40 } },
      execute: async () => {
        await sleep(250);
        return { ok: true };
      },
    });

    const config = new Config({ executor: { default_timeout: 5000 } });
    const exec = new Executor({ registry: reg, config });
    await expect(exec.call('slow.ann', {})).rejects.toBeInstanceOf(ModuleTimeoutError);
  });

  it('falls back to executor.default_timeout when no resources.timeout is declared', async () => {
    const reg = new Registry();
    reg.register('fast.mod', {
      id: 'fast.mod',
      description: 'no module timeout',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      execute: async () => {
        await sleep(10);
        return { ok: true };
      },
    });

    const config = new Config({ executor: { default_timeout: 5000 } });
    const exec = new Executor({ registry: reg, config });
    const result = await exec.call('fast.mod', {});
    expect(result).toEqual({ ok: true });
  });

  it('global deadline clamps the module timeout further when shorter', async () => {
    const reg = new Registry();
    reg.register('slow.global', {
      id: 'slow.global',
      description: 'module says 10s but global deadline says 50ms',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      resources: { timeout: 10_000 },
      execute: async () => {
        await sleep(2_000);
        return { ok: true };
      },
    });

    // global_timeout 50ms — much tighter than module timeout 10s
    const config = new Config({
      executor: { default_timeout: 5000, global_timeout: 50 },
    });
    const exec = new Executor({ registry: reg, config });
    await expect(exec.call('slow.global', {})).rejects.toBeInstanceOf(ModuleTimeoutError);
  });
});
