import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Executor } from '../src/executor.js';
import { FunctionModule } from '../src/decorator.js';
import { Registry } from '../src/registry/registry.js';
import { Middleware } from '../src/middleware/base.js';
import { ModuleNotFoundError, SchemaValidationError } from '../src/errors.js';

function createSimpleModule(id: string): FunctionModule {
  return new FunctionModule({
    execute: (inputs) => ({ greeting: `Hello, ${inputs['name'] ?? 'world'}!` }),
    moduleId: id,
    inputSchema: Type.Object({ name: Type.Optional(Type.String()) }),
    outputSchema: Type.Object({ greeting: Type.String() }),
    description: 'Greet module',
  });
}

/**
 * Creates a module with a stream() async generator that yields chunks.
 */
function createStreamingModule(id: string): FunctionModule & { stream: (inputs: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>> } {
  const mod = new FunctionModule({
    execute: (inputs) => ({ greeting: `Hello, ${inputs['name'] ?? 'world'}!` }),
    moduleId: id,
    inputSchema: Type.Object({ name: Type.Optional(Type.String()) }),
    outputSchema: Type.Object({ greeting: Type.String() }),
    description: 'Streaming greet module',
  });

  // Attach a stream method to the module
  const streamingMod = mod as FunctionModule & { stream: (inputs: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>> };
  streamingMod.stream = async function* (inputs: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
    const name = (inputs['name'] as string) ?? 'world';
    yield { greeting: `Hello, ` };
    yield { greeting: `${name}` };
    yield { greeting: `!` };
  };

  return streamingMod;
}

async function collectChunks(gen: AsyncGenerator<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('Executor.stream()', () => {
  it('falls back to single chunk when module has no stream()', async () => {
    const registry = new Registry();
    const mod = createSimpleModule('greet');
    registry.register('greet', mod);

    const executor = new Executor({ registry });
    const chunks = await collectChunks(executor.stream('greet', { name: 'Alice' }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]['greeting']).toBe('Hello, Alice!');
  });

  it('yields multiple chunks from streaming module', async () => {
    const registry = new Registry();
    const mod = createStreamingModule('greet');
    registry.register('greet', mod);

    const executor = new Executor({ registry });
    const chunks = await collectChunks(executor.stream('greet', { name: 'Bob' }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]['greeting']).toBe('Hello, ');
    expect(chunks[1]['greeting']).toBe('Bob');
    expect(chunks[2]['greeting']).toBe('!');
  });

  it('throws ModuleNotFoundError for unknown module', async () => {
    const registry = new Registry();
    const executor = new Executor({ registry });

    const chunks: Record<string, unknown>[] = [];
    await expect(async () => {
      for await (const chunk of executor.stream('nonexistent')) {
        chunks.push(chunk);
      }
    }).rejects.toThrow(ModuleNotFoundError);
  });

  it('runs before-middleware before streaming and after-middleware on accumulated result', async () => {
    const registry = new Registry();
    const mod = createStreamingModule('echo');
    registry.register('echo', mod);

    const calls: string[] = [];
    class TrackingMiddleware extends Middleware {
      override before() { calls.push('before'); return null; }
      override after() { calls.push('after'); return null; }
    }

    const executor = new Executor({ registry, middlewares: [new TrackingMiddleware()] });
    const chunks = await collectChunks(executor.stream('echo', { name: 'Test' }));

    expect(chunks.length).toBeGreaterThan(0);
    expect(calls).toContain('before');
    expect(calls).toContain('after');
    // before must come first
    expect(calls.indexOf('before')).toBeLessThan(calls.indexOf('after'));
  });

  it('runs before-middleware before fallback and after-middleware on result', async () => {
    const registry = new Registry();
    const mod = createSimpleModule('echo');
    registry.register('echo', mod);

    const calls: string[] = [];
    class TrackingMiddleware extends Middleware {
      override before() { calls.push('before'); return null; }
      override after() { calls.push('after'); return null; }
    }

    const executor = new Executor({ registry, middlewares: [new TrackingMiddleware()] });
    const chunks = await collectChunks(executor.stream('echo', { name: 'Test' }));

    expect(chunks).toHaveLength(1);
    expect(calls).toEqual(['before', 'after']);
  });

  it('handles middleware error recovery in streaming mode', async () => {
    const registry = new Registry();
    const failMod = new FunctionModule({
      execute: () => { throw new Error('stream-boom'); },
      moduleId: 'fail',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      description: 'Failing module',
    });
    registry.register('fail', failMod);

    class RecoveryMiddleware extends Middleware {
      override onError() { return { recovered: true }; }
    }

    const executor = new Executor({ registry, middlewares: [new RecoveryMiddleware()] });
    // Non-streaming module fallback with error should recover
    const chunks = await collectChunks(executor.stream('fail'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]['recovered']).toBe(true);
  });

  it('accumulates chunks via shallow merge for after-middleware', async () => {
    const registry = new Registry();
    const mod = {
      description: 'multi-key streaming module',
      inputSchema: Type.Object({ prefix: Type.String() }),
      outputSchema: Type.Object({ a: Type.Optional(Type.String()), b: Type.Optional(Type.String()) }),
      execute: async (inputs: Record<string, unknown>) => ({ a: `${inputs['prefix']}_a`, b: `${inputs['prefix']}_b` }),
      async *stream(inputs: Record<string, unknown>) {
        yield { a: `${inputs['prefix']}_a` };
        yield { b: `${inputs['prefix']}_b` };
      },
    };
    registry.register('multi', mod);

    let afterOutput: Record<string, unknown> | null = null;
    const executor = new Executor({ registry });
    executor.useAfter((_mid, _inputs, output) => {
      afterOutput = { ...output };
      return null;
    });

    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of executor.stream('multi', { prefix: 'test' })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ a: 'test_a' });
    expect(chunks[1]).toEqual({ b: 'test_b' });
    // After-middleware should receive the MERGED result
    expect(afterOutput).toEqual({ a: 'test_a', b: 'test_b' });
  });

  it('throws and routes to onError middleware when post-stream after() throws (Phase-3 rethrow)', async () => {
    // Fix: post-stream validation / after-middleware exceptions are now re-thrown
    // after running the onError middleware chain.
    const registry = new Registry();
    const mod = createStreamingModule('stream_after_fail');
    registry.register('stream_after_fail', mod);

    let onErrorCalled = false;
    class FailingAfter extends Middleware {
      override after(): null {
        throw new Error('post-stream after boom');
      }
      override onError(): null {
        onErrorCalled = true;
        return null;
      }
    }

    const executor = new Executor({ registry, middlewares: [new FailingAfter()] });
    await expect(
      collectChunks(executor.stream('stream_after_fail', { name: 'Test' })),
    ).rejects.toThrow();
    expect(onErrorCalled).toBe(true);
  });

  it('validates output schema on accumulated streaming result', async () => {
    const registry = new Registry();
    const mod = new FunctionModule({
      execute: () => ({ greeting: 'fallback' }),
      moduleId: 'validated',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ greeting: Type.String() }),
      description: 'Validated module',
    });

    // Attach a stream that produces valid accumulated output
    const streamingMod = mod as FunctionModule & { stream: (inputs: Record<string, unknown>) => AsyncGenerator<Record<string, unknown>> };
    streamingMod.stream = async function* (): AsyncGenerator<Record<string, unknown>> {
      yield { greeting: 'chunk1' };
      yield { greeting: 'chunk2' };
    };

    registry.register('validated', streamingMod);

    const executor = new Executor({ registry });
    // The last chunk is used as the accumulated output for validation
    const chunks = await collectChunks(executor.stream('validated'));
    expect(chunks).toHaveLength(2);
  });

  it('throws SchemaValidationError after stream when accumulated output fails output schema (Phase-3 rethrow)', async () => {
    // Module yields chunks that individually pass but accumulated output violates outputSchema
    const registry = new Registry();
    const streamingMod = new FunctionModule({
      execute: () => ({ count: 1 }),
      moduleId: 'phase3.fail',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ count: Type.Number() }),
      description: 'Streaming module with invalid accumulated output',
    }) as FunctionModule & { stream: () => AsyncGenerator<Record<string, unknown>> };

    streamingMod.stream = async function* () {
      yield { count: 'not-a-number' }; // violates outputSchema
    };

    registry.register('phase3.fail', streamingMod);
    const executor = new Executor({ registry });

    await expect(collectChunks(executor.stream('phase3.fail'))).rejects.toBeInstanceOf(SchemaValidationError);
  });
});
