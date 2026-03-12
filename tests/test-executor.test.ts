import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Context, createIdentity } from '../src/context.js';
import { Executor, redactSensitive, REDACTED_VALUE } from '../src/executor.js';
import { FunctionModule } from '../src/decorator.js';
import { Registry } from '../src/registry/registry.js';
import { ACL } from '../src/acl.js';
import { Middleware } from '../src/middleware/base.js';
import {
  ModuleNotFoundError,
  ACLDeniedError,
  CallDepthExceededError,
  CircularCallError,
  CallFrequencyExceededError,
  SchemaValidationError,
} from '../src/errors.js';

function createSimpleModule(id: string): FunctionModule {
  return new FunctionModule({
    execute: (inputs) => ({ greeting: `Hello, ${inputs['name'] ?? 'world'}!` }),
    moduleId: id,
    inputSchema: Type.Object({ name: Type.Optional(Type.String()) }),
    outputSchema: Type.Object({ greeting: Type.String() }),
    description: 'Greet module',
  });
}

describe('redactSensitive', () => {
  it('redacts fields marked x-sensitive', () => {
    const data = { name: 'Alice', password: 'secret123' };
    const schema = {
      properties: {
        name: { type: 'string' },
        password: { type: 'string', 'x-sensitive': true },
      },
    };
    const result = redactSensitive(data, schema);
    expect(result['name']).toBe('Alice');
    expect(result['password']).toBe(REDACTED_VALUE);
  });

  it('redacts _secret_ prefix keys', () => {
    const data = { _secret_token: 'abc123', name: 'Bob' };
    const schema = { properties: { name: { type: 'string' } } };
    const result = redactSensitive(data, schema);
    expect(result['_secret_token']).toBe(REDACTED_VALUE);
    expect(result['name']).toBe('Bob');
  });

  it('does not modify original data', () => {
    const data = { password: 'secret' };
    const schema = { properties: { password: { type: 'string', 'x-sensitive': true } } };
    redactSensitive(data, schema);
    expect(data['password']).toBe('secret');
  });

  it('handles nested objects', () => {
    const data = { user: { name: 'Alice', token: 'abc' } };
    const schema = {
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            token: { type: 'string', 'x-sensitive': true },
          },
        },
      },
    };
    const result = redactSensitive(data, schema);
    expect((result['user'] as Record<string, unknown>)['name']).toBe('Alice');
    expect((result['user'] as Record<string, unknown>)['token']).toBe(REDACTED_VALUE);
  });
});

describe('Executor', () => {
  it('executes a simple module', async () => {
    const registry = new Registry();
    const mod = createSimpleModule('greet');
    registry.register('greet', mod);

    const executor = new Executor({ registry });
    const result = await executor.call('greet', { name: 'Alice' });
    expect(result['greeting']).toBe('Hello, Alice!');
  });

  it('throws ModuleNotFoundError for unknown module', async () => {
    const registry = new Registry();
    const executor = new Executor({ registry });

    await expect(executor.call('nonexistent')).rejects.toThrow(ModuleNotFoundError);
  });

  it('validates input against schema', async () => {
    const registry = new Registry();
    const mod = new FunctionModule({
      execute: (inputs) => ({ result: inputs['count'] }),
      moduleId: 'strict',
      inputSchema: Type.Object({ count: Type.Number() }),
      outputSchema: Type.Object({ result: Type.Number() }),
      description: 'Strict module',
    });
    registry.register('strict', mod);

    const executor = new Executor({ registry });
    await expect(executor.call('strict', { count: 'not-a-number' })).rejects.toThrow(SchemaValidationError);
  });

  it('enforces ACL deny', async () => {
    const registry = new Registry();
    registry.register('secret', createSimpleModule('secret'));

    const acl = new ACL([
      { callers: ['@external'], targets: ['secret'], effect: 'deny', description: 'deny all' },
    ], 'deny');

    const executor = new Executor({ registry, acl });
    await expect(executor.call('secret')).rejects.toThrow(ACLDeniedError);
  });

  it('enforces ACL allow', async () => {
    const registry = new Registry();
    registry.register('public', createSimpleModule('public'));

    const acl = new ACL([
      { callers: ['*'], targets: ['*'], effect: 'allow', description: 'allow all' },
    ], 'deny');

    const executor = new Executor({ registry, acl });
    const result = await executor.call('public', { name: 'World' });
    expect(result['greeting']).toBe('Hello, World!');
  });

  it('calls middleware before and after', async () => {
    const registry = new Registry();
    registry.register('echo', createSimpleModule('echo'));

    const calls: string[] = [];
    class TrackingMiddleware extends Middleware {
      override before() { calls.push('before'); return null; }
      override after() { calls.push('after'); return null; }
    }

    const executor = new Executor({ registry, middlewares: [new TrackingMiddleware()] });
    await executor.call('echo');
    expect(calls).toEqual(['before', 'after']);
  });

  it('runs middleware onError on execution failure', async () => {
    const registry = new Registry();
    const failMod = new FunctionModule({
      execute: () => { throw new Error('boom'); },
      moduleId: 'fail',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      description: 'Failing module',
    });
    registry.register('fail', failMod);

    let errorSeen = false;
    class ErrorTracker extends Middleware {
      override onError() { errorSeen = true; return null; }
    }

    const executor = new Executor({ registry, middlewares: [new ErrorTracker()] });
    await expect(executor.call('fail')).rejects.toThrow('boom');
    expect(errorSeen).toBe(true);
  });

  it('middleware onError can recover', async () => {
    const registry = new Registry();
    const failMod = new FunctionModule({
      execute: () => { throw new Error('boom'); },
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
    const result = await executor.call('fail');
    expect(result['recovered']).toBe(true);
  });

  it('validate() returns PreflightResult with all checks passed for valid inputs', () => {
    const registry = new Registry();
    const mod = new FunctionModule({
      execute: () => ({ ok: true }),
      moduleId: 'v',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'Validate test',
    });
    registry.register('v', mod);

    const executor = new Executor({ registry });
    const result = executor.validate('v', { x: 42 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks.length).toBe(6);
    expect(result.checks.every(c => c.passed)).toBe(true);
  });

  it('validate() returns schema failure for invalid inputs', () => {
    const registry = new Registry();
    const mod = new FunctionModule({
      execute: () => ({ ok: true }),
      moduleId: 'v',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'Validate test',
    });
    registry.register('v', mod);

    const executor = new Executor({ registry });
    const result = executor.validate('v', { x: 'not-a-number' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.checks.find(c => c.check === 'schema')?.passed).toBe(false);
  });

  it('validate() returns module_id failure for invalid ID format', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const result = executor.validate('INVALID-ID!!');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e['code'] === 'INVALID_INPUT')).toBe(true);
    expect(result.checks.find(c => c.check === 'module_id')?.passed).toBe(false);
  });

  it('validate() returns module_lookup failure for unknown module', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const result = executor.validate('unknown.module', {});
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e['code'] === 'MODULE_NOT_FOUND')).toBe(true);
    expect(result.checks.find(c => c.check === 'module_lookup')?.passed).toBe(false);
  });

  it('validate() reports ACL denial without executing', () => {
    const registry = new Registry();
    const mod = new FunctionModule({
      execute: () => ({ ok: true }),
      moduleId: 'access.test',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'ACL test',
    });
    registry.register('access.test', mod);

    const acl = new ACL([], 'deny');
    const executor = new Executor({ registry, acl });
    const result = executor.validate('access.test', { x: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e['code'] === 'ACL_DENIED')).toBe(true);
  });

  it('validate() detects requiresApproval annotation', () => {
    const registry = new Registry();
    const mod = new FunctionModule({
      execute: () => ({ ok: true }),
      moduleId: 'approval.test',
      inputSchema: Type.Object({ x: Type.Number() }),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'Approval test',
      annotations: { requiresApproval: true, readonly: false, destructive: false, idempotent: false, openWorld: true, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const },
    });
    registry.register('approval.test', mod);

    const executor = new Executor({ registry });
    const result = executor.validate('approval.test', { x: 42 });
    expect(result.valid).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it('auto-creates context when none provided', async () => {
    const registry = new Registry();
    registry.register('ctx', createSimpleModule('ctx'));

    const executor = new Executor({ registry });
    const result = await executor.call('ctx');
    expect(result['greeting']).toBeDefined();
  });

  it('uses provided context', async () => {
    const registry = new Registry();
    let capturedCtx: Context | null = null;
    const mod = new FunctionModule({
      execute: (_inputs, ctx) => { capturedCtx = ctx; return { ok: true }; },
      moduleId: 'ctx_test',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'Context capture',
    });
    registry.register('ctx_test', mod);

    const executor = new Executor({ registry });
    const ctx = Context.create(executor, createIdentity('user1'));
    await executor.call('ctx_test', {}, ctx);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.traceId).toBe(ctx.traceId);
    expect(capturedCtx!.identity?.id).toBe('user1');
  });

  it('use/remove middleware chaining', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const mw = new Middleware();

    const result = executor.use(mw);
    expect(result).toBe(executor);
    expect(executor.middlewares).toHaveLength(1);

    executor.remove(mw);
    expect(executor.middlewares).toHaveLength(0);
  });
});
