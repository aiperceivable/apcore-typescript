/**
 * Tests for the Pipeline StepMiddleware interface (Issue #33 §2.2).
 *
 * StepMiddleware lets callers intercept the lifecycle of every pipeline
 * step — beforeStep / afterStep / onStepError — without modifying the
 * step itself. This decouples cross-cutting concerns (tracing, metrics,
 * recovery) from the engine.
 */

import { describe, expect, it, vi } from 'vitest';
import { Context } from '../src/context.js';
import { ExecutionStrategy, PipelineEngine, PipelineStepError } from '../src/pipeline.js';
import type {
  PipelineContext,
  PipelineState,
  Step,
  StepMiddleware,
  StepResult,
} from '../src/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(
  name: string,
  opts: {
    throws?: boolean;
    action?: 'continue' | 'abort' | 'skip_to';
    skipTo?: string;
    pure?: boolean;
    output?: Record<string, unknown>;
  } = {},
): Step {
  return {
    name,
    description: `Step ${name}`,
    removable: true,
    replaceable: true,
    pure: opts.pure,
    execute: async (ctx: PipelineContext): Promise<StepResult> => {
      if (opts.throws) throw new Error(`Step ${name} failed`);
      if (opts.output) {
        ctx.output = { ...(ctx.output ?? {}), ...opts.output };
      }
      return {
        action: opts.action ?? 'continue',
        skipTo: opts.skipTo,
      };
    },
  };
}

function makeContext(moduleId = 'test.module'): PipelineContext {
  return {
    moduleId,
    inputs: {},
    context: new Context('trace-id', null, []),
  };
}

// ---------------------------------------------------------------------------
// before/after invocation order
// ---------------------------------------------------------------------------

describe('StepMiddleware before/after order', () => {
  it('invokes beforeStep then step then afterStep with the produced result', async () => {
    const events: string[] = [];
    const mw: StepMiddleware = {
      beforeStep: (stepName: string) => {
        events.push(`before:${stepName}`);
      },
      afterStep: (stepName: string, _state: PipelineState, _result: unknown) => {
        events.push(`after:${stepName}`);
      },
    };

    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    const ctx = makeContext();
    const strategy = new ExecutionStrategy('s', [makeStep('a'), makeStep('b')]);
    await engine.run(strategy, ctx);

    expect(events).toEqual(['before:a', 'after:a', 'before:b', 'after:b']);
  });

  it('passes the same step name and PipelineState to before/after', async () => {
    const seen: Array<{ phase: string; name: string; hasState: boolean }> = [];
    const mw: StepMiddleware = {
      beforeStep: (name, state) => {
        seen.push({ phase: 'before', name, hasState: state != null && state.stepName === name });
      },
      afterStep: (name, state, _result) => {
        seen.push({ phase: 'after', name, hasState: state != null && state.stepName === name });
      },
    };

    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    const ctx = makeContext();
    const strategy = new ExecutionStrategy('s', [makeStep('only')]);
    await engine.run(strategy, ctx);

    expect(seen).toEqual([
      { phase: 'before', name: 'only', hasState: true },
      { phase: 'after', name: 'only', hasState: true },
    ]);
  });

  it('awaits async beforeStep/afterStep before continuing the pipeline', async () => {
    const order: string[] = [];
    const mw: StepMiddleware = {
      beforeStep: async (name) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`before:${name}`);
      },
      afterStep: async (name) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`after:${name}`);
      },
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    const strategy = new ExecutionStrategy('s', [makeStep('one'), makeStep('two')]);
    await engine.run(strategy, makeContext());

    expect(order).toEqual(['before:one', 'after:one', 'before:two', 'after:two']);
  });

  it('detects thenable (non-async-function) returns and awaits them (Issue #42 alignment)', async () => {
    let resolved = false;
    const mw: StepMiddleware = {
      // Plain function returning a thenable, not declared async.
      beforeStep: (_name) => {
        return {
          // biome-ignore lint/suspicious/noThenProperty: deliberate thenable to test engine awaiting (Issue #42 alignment)
          then(resolve: () => void) {
            setTimeout(() => {
              resolved = true;
              resolve();
            }, 5);
          },
        } as unknown as Promise<void>;
      },
    };

    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    await engine.run(new ExecutionStrategy('s', [makeStep('a')]), makeContext());
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Onion stacking — multiple middlewares
// ---------------------------------------------------------------------------

describe('StepMiddleware onion stacking', () => {
  it('runs beforeStep in registration order and afterStep in registration order', async () => {
    const events: string[] = [];
    const mwA: StepMiddleware = {
      beforeStep: () => {
        events.push('A:before');
      },
      afterStep: () => {
        events.push('A:after');
      },
    };
    const mwB: StepMiddleware = {
      beforeStep: () => {
        events.push('B:before');
      },
      afterStep: () => {
        events.push('B:after');
      },
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mwA);
    engine.addStepMiddleware(mwB);
    await engine.run(new ExecutionStrategy('s', [makeStep('only')]), makeContext());
    expect(events).toEqual(['A:before', 'B:before', 'A:after', 'B:after']);
  });
});

// ---------------------------------------------------------------------------
// onStepError + recovery
// ---------------------------------------------------------------------------

describe('StepMiddleware onStepError', () => {
  it('is invoked when a step throws, with the step name and error', async () => {
    const errors: Array<{ name: string; msg: string }> = [];
    const mw: StepMiddleware = {
      onStepError: (name, _state, err) => {
        errors.push({ name, msg: err.message });
        return null; // no recovery
      },
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    await expect(
      engine.run(new ExecutionStrategy('s', [makeStep('boom', { throws: true })]), makeContext()),
    ).rejects.toThrow(PipelineStepError);
    expect(errors).toEqual([{ name: 'boom', msg: 'Step boom failed' }]);
  });

  it('returning a non-null value suppresses the error and continues the pipeline', async () => {
    const mw: StepMiddleware = {
      onStepError: () => ({ recovered: true }),
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);

    const strategy = new ExecutionStrategy('s', [
      makeStep('boom', { throws: true }),
      makeStep('next', { output: { ok: true } }),
    ]);
    const ctx = makeContext();
    const [output, trace] = await engine.run(strategy, ctx);
    expect(trace.success).toBe(true);
    expect(output).toEqual({ ok: true });
    // Both steps appear in trace
    expect(trace.steps.map((s) => s.name)).toEqual(['boom', 'next']);
  });

  it('async onStepError that resolves to non-null is treated as recovery', async () => {
    const mw: StepMiddleware = {
      onStepError: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { recovered: true };
      },
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    const strategy = new ExecutionStrategy('s', [
      makeStep('boom', { throws: true }),
      makeStep('next'),
    ]);
    const [, trace] = await engine.run(strategy, makeContext());
    expect(trace.success).toBe(true);
  });

  it('first non-null recovery wins (later onStepError middlewares are skipped)', async () => {
    const calls: string[] = [];
    const mwA: StepMiddleware = {
      onStepError: () => {
        calls.push('A');
        return { recovered: 'A' };
      },
    };
    const mwB: StepMiddleware = {
      onStepError: () => {
        calls.push('B');
        return { recovered: 'B' };
      },
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mwA);
    engine.addStepMiddleware(mwB);
    await engine.run(
      new ExecutionStrategy('s', [makeStep('boom', { throws: true })]),
      makeContext(),
    );
    expect(calls).toEqual(['A']);
  });

  it('if all onStepError return null, the original error is re-thrown', async () => {
    const mw: StepMiddleware = {
      onStepError: () => null,
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    await expect(
      engine.run(new ExecutionStrategy('s', [makeStep('boom', { throws: true })]), makeContext()),
    ).rejects.toThrow(PipelineStepError);
  });

  it('does not invoke onStepError when the step succeeds', async () => {
    const mw: StepMiddleware = {
      onStepError: vi.fn(() => null),
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    await engine.run(new ExecutionStrategy('s', [makeStep('a')]), makeContext());
    expect(mw.onStepError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Optional methods — partial implementations are safe
// ---------------------------------------------------------------------------

describe('StepMiddleware partial implementations', () => {
  it('a middleware that only implements beforeStep does not break afterStep', async () => {
    const events: string[] = [];
    const mw: StepMiddleware = {
      beforeStep: (name) => {
        events.push(`before:${name}`);
      },
    };
    const engine = new PipelineEngine();
    engine.addStepMiddleware(mw);
    await engine.run(new ExecutionStrategy('s', [makeStep('a')]), makeContext());
    expect(events).toEqual(['before:a']);
  });

  it('engine runs cleanly with no middlewares registered', async () => {
    const engine = new PipelineEngine();
    const [output] = await engine.run(new ExecutionStrategy('s', [makeStep('a')]), makeContext());
    expect(output).toBeNull();
  });
});
