/**
 * Integration tests for the approval system through the full executor pipeline.
 */

import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import { ACL } from '../src/acl.js';
import type { ACLRule } from '../src/acl.js';
import {
  AlwaysDenyHandler,
  AutoApproveHandler,
  CallbackApprovalHandler,
  createApprovalResult,
} from '../src/approval.js';
import type { ApprovalHandler, ApprovalRequest, ApprovalResult } from '../src/approval.js';
import { Context, createIdentity } from '../src/context.js';
import { FunctionModule } from '../src/decorator.js';
import {
  ACLDeniedError,
  ApprovalDeniedError,
  ApprovalPendingError,
} from '../src/errors.js';
import { Executor } from '../src/executor.js';
import { ExtensionManager } from '../src/extensions.js';
import { Middleware } from '../src/middleware/index.js';
import { Registry } from '../src/registry/registry.js';

// ---------------------------------------------------------------------------
// Module implementations
// ---------------------------------------------------------------------------

const PermissiveInput = Type.Object({}, { additionalProperties: true });
const PermissiveOutput = Type.Object({}, { additionalProperties: true });

function createDestructiveModule(): FunctionModule {
  return new FunctionModule({
    moduleId: 'admin.delete_user',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'Delete user data',
    tags: ['admin', 'destructive'],
    annotations: {
      readonly: false,
      destructive: true,
      idempotent: false,
      requiresApproval: true,
      openWorld: true,
      streaming: false,
      cacheable: false,
      cacheTtl: 0,
      cacheKeyFields: null,
      paginated: false,
      paginationStyle: 'cursor' as const,
    },
    execute: (inputs) => ({ deleted: true, user_id: inputs['user_id'] }),
  });
}

function createSafeModule(): FunctionModule {
  return new FunctionModule({
    moduleId: 'data.read',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'Read data',
    annotations: {
      readonly: true,
      destructive: false,
      idempotent: false,
      requiresApproval: false,
      openWorld: true,
      streaming: false,
      cacheable: false,
      cacheTtl: 0,
      cacheKeyFields: null,
      paginated: false,
      paginationStyle: 'cursor' as const,
    },
    execute: () => ({ data: 'safe' }),
  });
}

class RecordingMiddleware extends Middleware {
  beforeCalls: string[] = [];
  afterCalls: string[] = [];
  errorCalls: string[] = [];

  override before(moduleId: string, _inputs: Record<string, unknown>, _context: Context): Record<string, unknown> | null {
    this.beforeCalls.push(moduleId);
    return null;
  }

  override after(moduleId: string, _inputs: Record<string, unknown>, _output: Record<string, unknown>, _context: Context): Record<string, unknown> | null {
    this.afterCalls.push(moduleId);
    return null;
  }

  override onError(moduleId: string, _inputs: Record<string, unknown>, _error: Error, _context: Context): Record<string, unknown> | null {
    this.errorCalls.push(moduleId);
    return null;
  }
}

function createTestRegistry(): Registry {
  const reg = new Registry();
  reg.register('admin.delete_user', createDestructiveModule());
  reg.register('data.read', createSafeModule());
  return reg;
}

// ---------------------------------------------------------------------------
// ACL + Approval interaction
// ---------------------------------------------------------------------------

describe('ApprovalWithACL', () => {
  it('ACL deny fires before approval gate', async () => {
    const registry = createTestRegistry();
    const acl = new ACL([{ callers: ['*'], targets: ['admin.*'], effect: 'deny', description: '', conditions: null } as ACLRule]);

    let approvalCalled = false;
    const handler = new CallbackApprovalHandler(async () => {
      approvalCalled = true;
      return createApprovalResult({ status: 'approved' });
    });
    const executor = new Executor({ registry, acl, approvalHandler: handler });

    await expect(executor.call('admin.delete_user', { user_id: '123' })).rejects.toThrow(ACLDeniedError);
    expect(approvalCalled).toBe(false);
  });

  it('ACL allows but approval denies', async () => {
    const registry = createTestRegistry();
    const acl = new ACL([{ callers: ['*'], targets: ['admin.*'], effect: 'allow', description: '', conditions: null } as ACLRule]);

    const executor = new Executor({ registry, acl, approvalHandler: new AlwaysDenyHandler() });
    await expect(executor.call('admin.delete_user', { user_id: '123' })).rejects.toThrow(ApprovalDeniedError);
  });

  it('ACL allows and approval approves', async () => {
    const registry = createTestRegistry();
    const acl = new ACL([{ callers: ['*'], targets: ['*'], effect: 'allow', description: '', conditions: null } as ACLRule]);

    const executor = new Executor({ registry, acl, approvalHandler: new AutoApproveHandler() });
    const result = await executor.call('admin.delete_user', { user_id: '123' });
    expect(result['deleted']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Approval + Middleware interaction
// ---------------------------------------------------------------------------

describe('ApprovalWithMiddleware', () => {
  it('middleware runs after approval passes', async () => {
    const registry = createTestRegistry();
    const mw = new RecordingMiddleware();
    const executor = new Executor({
      registry,
      middlewares: [mw],
      approvalHandler: new AutoApproveHandler(),
    });
    const result = await executor.call('admin.delete_user', { user_id: '123' });
    expect(result['deleted']).toBe(true);
    expect(mw.beforeCalls).toContain('admin.delete_user');
    expect(mw.afterCalls).toContain('admin.delete_user');
  });

  it('middleware not reached when approval denied', async () => {
    const registry = createTestRegistry();
    const mw = new RecordingMiddleware();
    const executor = new Executor({
      registry,
      middlewares: [mw],
      approvalHandler: new AlwaysDenyHandler(),
    });
    await expect(executor.call('admin.delete_user', { user_id: '123' })).rejects.toThrow(ApprovalDeniedError);
    expect(mw.beforeCalls).toHaveLength(0);
    expect(mw.afterCalls).toHaveLength(0);
  });

  it('safe module with middleware and handler still works normally', async () => {
    const registry = createTestRegistry();
    const mw = new RecordingMiddleware();
    const executor = new Executor({
      registry,
      middlewares: [mw],
      approvalHandler: new AlwaysDenyHandler(),
    });
    const result = await executor.call('data.read');
    expect(result['data']).toBe('safe');
    expect(mw.beforeCalls).toContain('data.read');
    expect(mw.afterCalls).toContain('data.read');
  });
});

// ---------------------------------------------------------------------------
// Callback with identity
// ---------------------------------------------------------------------------

describe('ApprovalCallback', () => {
  it('callback receives identity from context', async () => {
    const registry = createTestRegistry();
    const captured: ApprovalRequest[] = [];
    const handler = new CallbackApprovalHandler(async (request: ApprovalRequest) => {
      captured.push(request);
      return createApprovalResult({ status: 'approved', approvedBy: 'callback' });
    });
    const executor = new Executor({ registry, approvalHandler: handler });
    const identity = createIdentity('user-42', 'user', ['admin']);
    const ctx = Context.create(executor, identity);

    await executor.call('admin.delete_user', { user_id: '123' }, ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0].context.identity).not.toBeNull();
    expect(captured[0].context.identity!.id).toBe('user-42');
    expect(captured[0].context.identity!.roles).toContain('admin');
  });

  it('callback can make conditional decisions', async () => {
    const registry = createTestRegistry();
    const handler = new CallbackApprovalHandler(async (request: ApprovalRequest) => {
      if (request.context.identity && request.context.identity.roles.includes('admin')) {
        return createApprovalResult({ status: 'approved', approvedBy: 'policy' });
      }
      return createApprovalResult({ status: 'rejected', reason: 'Admin role required' });
    });
    const executor = new Executor({ registry, approvalHandler: handler });

    // Admin user → approved
    const adminCtx = Context.create(executor, createIdentity('admin-1', 'user', ['admin']));
    const result = await executor.call('admin.delete_user', { user_id: '123' }, adminCtx);
    expect(result['deleted']).toBe(true);

    // Regular user → denied
    const userCtx = Context.create(executor, createIdentity('user-1', 'user', ['viewer']));
    try {
      await executor.call('admin.delete_user', { user_id: '123' }, userCtx);
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalDeniedError);
      expect((e as ApprovalDeniedError).message).toContain('Admin role required');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase B flow
// ---------------------------------------------------------------------------

describe('ApprovalPhaseB', () => {
  it('pending then resume with token', async () => {
    const registry = createTestRegistry();
    let callCount = 0;

    const handler: ApprovalHandler = {
      async requestApproval(_request: ApprovalRequest) {
        callCount++;
        return createApprovalResult({ status: 'pending', approvalId: 'pending-tok-1' });
      },
      async checkApproval(approvalId: string) {
        if (approvalId === 'pending-tok-1') {
          return createApprovalResult({ status: 'approved', approvedBy: 'reviewer' });
        }
        return createApprovalResult({ status: 'rejected' });
      },
    };

    const executor = new Executor({ registry, approvalHandler: handler });

    // First call → pending
    try {
      await executor.call('admin.delete_user', { user_id: '123' });
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalPendingError);
      expect((e as ApprovalPendingError).approvalId).toBe('pending-tok-1');
    }
    expect(callCount).toBe(1);

    // Resume with token → approved
    const result = await executor.call('admin.delete_user', {
      user_id: '123',
      _approval_token: 'pending-tok-1',
    });
    expect(result['deleted']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ExtensionManager wiring
// ---------------------------------------------------------------------------

describe('ApprovalExtensionManager', () => {
  it('wires approval handler via ExtensionManager', async () => {
    const registry = createTestRegistry();
    const em = new ExtensionManager();
    em.register('approval_handler', new AutoApproveHandler());

    const executor = new Executor({ registry });
    em.apply(registry, executor);

    const result = await executor.call('admin.delete_user', { user_id: '123' });
    expect(result['deleted']).toBe(true);
  });

  it('ExtensionManager with deny handler blocks execution', async () => {
    const registry = createTestRegistry();
    const em = new ExtensionManager();
    em.register('approval_handler', new AlwaysDenyHandler());

    const executor = new Executor({ registry });
    em.apply(registry, executor);

    await expect(executor.call('admin.delete_user', { user_id: '123' })).rejects.toThrow(ApprovalDeniedError);
  });
});

// ---------------------------------------------------------------------------
// Public API imports
// ---------------------------------------------------------------------------

describe('ApprovalImports', () => {
  it('all types importable from apcore package', async () => {
    const apcore = await import('../src/index.js');
    expect(apcore.AlwaysDenyHandler).toBeDefined();
    expect(apcore.AutoApproveHandler).toBeDefined();
    expect(apcore.CallbackApprovalHandler).toBeDefined();
    expect(apcore.createApprovalRequest).toBeDefined();
    expect(apcore.createApprovalResult).toBeDefined();
    expect(apcore.ApprovalError).toBeDefined();
    expect(apcore.ApprovalDeniedError).toBeDefined();
    expect(apcore.ApprovalTimeoutError).toBeDefined();
    expect(apcore.ApprovalPendingError).toBeDefined();
  });
});
