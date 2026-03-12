/**
 * Unit tests for the approval gate in the Executor (Step 4.5).
 */

import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
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
  ApprovalDeniedError,
  ApprovalPendingError,
  ApprovalTimeoutError,
} from '../src/errors.js';
import { Executor } from '../src/executor.js';
import type { ModuleAnnotations } from '../src/module.js';
import { Registry } from '../src/registry/registry.js';

// ---------------------------------------------------------------------------
// Test module implementations
// ---------------------------------------------------------------------------

const PermissiveInput = Type.Object({}, { additionalProperties: true });
const PermissiveOutput = Type.Object({}, { additionalProperties: true });

function createApprovalRequiredModule(): FunctionModule {
  return new FunctionModule({
    moduleId: 'test.approval_required',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'Destructive operation',
    tags: ['admin'],
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
    execute: (inputs) => ({ status: 'executed' }),
  });
}

function createApprovalRequiredDictModule(): FunctionModule {
  return new FunctionModule({
    moduleId: 'test.approval_dict',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'Dict-annotated module',
    tags: ['admin'],
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
    execute: (inputs) => ({ status: 'executed' }),
  });
}

function createNoApprovalModule(): FunctionModule {
  return new FunctionModule({
    moduleId: 'test.no_approval',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'No approval needed',
    annotations: {
      readonly: false,
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
    execute: (inputs) => ({ status: 'executed' }),
  });
}

function createNoAnnotationsModule(): FunctionModule {
  return new FunctionModule({
    moduleId: 'test.no_annotations',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'No annotations',
    execute: (inputs) => ({ status: 'executed' }),
  });
}

function createAsyncApprovalModule(): FunctionModule {
  return new FunctionModule({
    moduleId: 'test.async_approval',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'Async module requiring approval',
    annotations: {
      readonly: false,
      destructive: false,
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
    execute: async (inputs) => ({ status: 'async_executed' }),
  });
}

function createSnakeCaseAnnotationsModule(): Record<string, unknown> {
  return {
    moduleId: 'test.snake_case_approval',
    inputSchema: PermissiveInput,
    outputSchema: PermissiveOutput,
    description: 'Snake-case annotated module',
    tags: ['admin'],
    annotations: {
      readonly: false,
      destructive: true,
      idempotent: false,
      requires_approval: true,
      open_world: true,
      streaming: false,
    },
    execute: (_inputs: Record<string, unknown>) => ({ status: 'executed' }),
  };
}

function createTestRegistry(): Registry {
  const reg = new Registry();
  reg.register('test.approval_required', createApprovalRequiredModule());
  reg.register('test.approval_dict', createApprovalRequiredDictModule());
  reg.register('test.no_approval', createNoApprovalModule());
  reg.register('test.no_annotations', createNoAnnotationsModule());
  reg.register('test.async_approval', createAsyncApprovalModule());
  reg.register('test.snake_case_approval', createSnakeCaseAnnotationsModule());
  return reg;
}

// ---------------------------------------------------------------------------
// call() tests
// ---------------------------------------------------------------------------

describe('ApprovalGate call()', () => {
  it('skips gate when no handler is configured', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry });
    const result = await executor.call('test.approval_required');
    expect(result['status']).toBe('executed');
  });

  it('skips gate when module does not require approval', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const result = await executor.call('test.no_approval');
    expect(result['status']).toBe('executed');
  });

  it('skips gate when module has no annotations', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const result = await executor.call('test.no_annotations');
    expect(result['status']).toBe('executed');
  });

  it('proceeds when approved', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const result = await executor.call('test.approval_required');
    expect(result['status']).toBe('executed');
  });

  it('raises ApprovalDeniedError when rejected', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    await expect(executor.call('test.approval_required')).rejects.toThrow(ApprovalDeniedError);
    try {
      await executor.call('test.approval_required');
    } catch (e) {
      expect((e as ApprovalDeniedError).code).toBe('APPROVAL_DENIED');
      expect(((e as ApprovalDeniedError).result as ApprovalResult).status).toBe('rejected');
    }
  });

  it('raises ApprovalTimeoutError on timeout', async () => {
    const registry = createTestRegistry();
    const handler = new CallbackApprovalHandler(async () =>
      createApprovalResult({ status: 'timeout' }),
    );
    const executor = new Executor({ registry, approvalHandler: handler });
    await expect(executor.call('test.approval_required')).rejects.toThrow(ApprovalTimeoutError);
    try {
      await executor.call('test.approval_required');
    } catch (e) {
      expect((e as ApprovalTimeoutError).code).toBe('APPROVAL_TIMEOUT');
    }
  });

  it('raises ApprovalPendingError with approvalId on pending', async () => {
    const registry = createTestRegistry();
    const handler = new CallbackApprovalHandler(async () =>
      createApprovalResult({ status: 'pending', approvalId: 'tok-abc' }),
    );
    const executor = new Executor({ registry, approvalHandler: handler });
    try {
      await executor.call('test.approval_required');
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalPendingError);
      expect((e as ApprovalPendingError).approvalId).toBe('tok-abc');
    }
  });

  it('triggers gate for dict-form annotations', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    await expect(executor.call('test.approval_dict')).rejects.toThrow(ApprovalDeniedError);
  });

  it('allows execution for dict-form annotations when approved', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const result = await executor.call('test.approval_dict');
    expect(result['status']).toBe('executed');
  });

  it('triggers gate for snake_case requires_approval annotations', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    await expect(executor.call('test.snake_case_approval')).rejects.toThrow(ApprovalDeniedError);
  });

  it('allows execution for snake_case annotations when approved', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const result = await executor.call('test.snake_case_approval');
    expect(result['status']).toBe('executed');
  });

  it('updates handler via setApprovalHandler', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry });

    // No handler → executes
    const result = await executor.call('test.approval_required');
    expect(result['status']).toBe('executed');

    // Set deny handler → raises
    executor.setApprovalHandler(new AlwaysDenyHandler());
    await expect(executor.call('test.approval_required')).rejects.toThrow(ApprovalDeniedError);
  });

  it('carries correct context in ApprovalRequest', async () => {
    const registry = createTestRegistry();
    const capturedRequests: ApprovalRequest[] = [];
    const handler = new CallbackApprovalHandler(async (request: ApprovalRequest) => {
      capturedRequests.push(request);
      return createApprovalResult({ status: 'approved', approvedBy: 'test' });
    });
    const executor = new Executor({ registry, approvalHandler: handler });
    await executor.call('test.approval_required', { key: 'val' });

    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.moduleId).toBe('test.approval_required');
    expect(req.arguments).toEqual({ key: 'val' });
    expect(req.annotations.requiresApproval).toBe(true);
    expect(req.annotations.destructive).toBe(true);
    expect(req.description).toBe('Destructive operation');
    expect(req.tags).toEqual(['admin']);
    expect(req.context.traceId).toBeDefined();
  });

  it('strips _approval_token and calls checkApproval without mutating caller inputs', async () => {
    const registry = createTestRegistry();
    const checkCalledWith: string[] = [];

    const handler: ApprovalHandler = {
      async requestApproval(_request: ApprovalRequest) {
        return createApprovalResult({ status: 'approved' });
      },
      async checkApproval(approvalId: string) {
        checkCalledWith.push(approvalId);
        return createApprovalResult({ status: 'approved', approvedBy: 'token-check' });
      },
    };

    const executor = new Executor({ registry, approvalHandler: handler });
    const inputs: Record<string, unknown> = { _approval_token: 'my-token', data: 'value' };
    const result = await executor.call('test.approval_required', inputs);
    expect(result['status']).toBe('executed');
    expect(checkCalledWith).toEqual(['my-token']);
    // Caller's inputs object should NOT be mutated
    expect(inputs['_approval_token']).toBe('my-token');
  });

  it('treats unknown status as denied', async () => {
    const registry = createTestRegistry();
    const handler = new CallbackApprovalHandler(async () =>
      createApprovalResult({ status: 'unknown_value' as 'approved' }),
    );
    const executor = new Executor({ registry, approvalHandler: handler });
    await expect(executor.call('test.approval_required')).rejects.toThrow(ApprovalDeniedError);
  });

  it('propagates handler exceptions', async () => {
    const registry = createTestRegistry();
    const handler = new CallbackApprovalHandler(async () => {
      throw new Error('handler crashed');
    });
    const executor = new Executor({ registry, approvalHandler: handler });
    await expect(executor.call('test.approval_required')).rejects.toThrow('handler crashed');
  });
});

// ---------------------------------------------------------------------------
// callAsync() tests
// ---------------------------------------------------------------------------

describe('ApprovalGate callAsync()', () => {
  it('skips gate when no handler configured', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry });
    const result = await executor.callAsync('test.approval_required');
    expect(result['status']).toBe('executed');
  });

  it('proceeds when approved', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const result = await executor.callAsync('test.approval_required');
    expect(result['status']).toBe('executed');
  });

  it('raises ApprovalDeniedError when rejected', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    await expect(executor.callAsync('test.approval_required')).rejects.toThrow(ApprovalDeniedError);
  });

  it('works with async module when approved', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const result = await executor.callAsync('test.async_approval');
    expect(result['status']).toBe('async_executed');
  });

  it('works with async module when denied', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    await expect(executor.callAsync('test.async_approval')).rejects.toThrow(ApprovalDeniedError);
  });

  it('handles _approval_token in async path', async () => {
    const registry = createTestRegistry();
    const checkCalledWith: string[] = [];

    const handler: ApprovalHandler = {
      async requestApproval() {
        return createApprovalResult({ status: 'approved' });
      },
      async checkApproval(approvalId: string) {
        checkCalledWith.push(approvalId);
        return createApprovalResult({ status: 'approved' });
      },
    };

    const executor = new Executor({ registry, approvalHandler: handler });
    const inputs: Record<string, unknown> = { _approval_token: 'async-tok' };
    const result = await executor.callAsync('test.approval_required', inputs);
    expect(result['status']).toBe('executed');
    expect(checkCalledWith).toEqual(['async-tok']);
  });

  it('handles dict annotations in async path', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    await expect(executor.callAsync('test.approval_dict')).rejects.toThrow(ApprovalDeniedError);
  });
});

// ---------------------------------------------------------------------------
// stream() tests
// ---------------------------------------------------------------------------

describe('ApprovalGate stream()', () => {
  it('allows streaming when approved', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of executor.stream('test.approval_required')) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]['status']).toBe('executed');
  });

  it('raises ApprovalDeniedError in stream when rejected', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    await expect(async () => {
      for await (const _ of executor.stream('test.approval_required')) {
        // should not reach here
      }
    }).rejects.toThrow(ApprovalDeniedError);
  });

  it('skips gate when module does not require approval', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of executor.stream('test.no_approval')) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]['status']).toBe('executed');
  });
});

// ---------------------------------------------------------------------------
// Audit event tests
// ---------------------------------------------------------------------------

describe('ApprovalAuditEvents', () => {
  it('emits audit log on approved', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const infoSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await executor.call('test.approval_required');
      const approvalLogs = infoSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Approval decision'),
      );
      expect(approvalLogs).toHaveLength(1);
      expect(approvalLogs[0][0]).toContain('status=approved');
      expect(approvalLogs[0][0]).toContain('approved_by=auto');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('emits audit log on denied', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    const infoSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(executor.call('test.approval_required')).rejects.toThrow(ApprovalDeniedError);
      const approvalLogs = infoSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Approval decision'),
      );
      expect(approvalLogs).toHaveLength(1);
      expect(approvalLogs[0][0]).toContain('status=rejected');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('emits audit log on pending', async () => {
    const registry = createTestRegistry();
    const handler = new CallbackApprovalHandler(async () =>
      createApprovalResult({ status: 'pending', approvalId: 'tok-123' }),
    );
    const executor = new Executor({ registry, approvalHandler: handler });
    const infoSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(executor.call('test.approval_required')).rejects.toThrow(ApprovalPendingError);
      const approvalLogs = infoSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Approval decision'),
      );
      expect(approvalLogs).toHaveLength(1);
      expect(approvalLogs[0][0]).toContain('status=pending');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('does not emit audit log when gate is skipped', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry });
    const infoSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await executor.call('test.approval_required');
      const approvalLogs = infoSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Approval decision'),
      );
      expect(approvalLogs).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('emits span event when tracing is active', async () => {
    const registry = createTestRegistry();
    const mockSpanEvents: Array<Record<string, unknown>> = [];
    const mockSpan = { events: mockSpanEvents };

    const handler = new CallbackApprovalHandler(async () =>
      createApprovalResult({ status: 'approved', approvedBy: 'test-user', reason: 'looks good' }),
    );
    const executor = new Executor({ registry, approvalHandler: handler });
    const infoSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const ctx = Context.create(executor);
      ctx.data['_apcore.mw.tracing.spans'] = [mockSpan];
      await executor.call('test.approval_required', {}, ctx);

      expect(mockSpanEvents).toHaveLength(1);
      const event = mockSpanEvents[0];
      expect(event['name']).toBe('approval_decision');
      expect(event['module_id']).toBe('test.approval_required');
      expect(event['status']).toBe('approved');
      expect(event['approved_by']).toBe('test-user');
      expect(event['reason']).toBe('looks good');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('emits span event on denied decision', async () => {
    const registry = createTestRegistry();
    const mockSpanEvents: Array<Record<string, unknown>> = [];
    const mockSpan = { events: mockSpanEvents };

    const executor = new Executor({ registry, approvalHandler: new AlwaysDenyHandler() });
    const infoSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const ctx = Context.create(executor);
      ctx.data['_apcore.mw.tracing.spans'] = [mockSpan];

      await expect(executor.call('test.approval_required', {}, ctx)).rejects.toThrow(ApprovalDeniedError);

      expect(mockSpanEvents).toHaveLength(1);
      expect(mockSpanEvents[0]['status']).toBe('rejected');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('works without tracing spans', async () => {
    const registry = createTestRegistry();
    const executor = new Executor({ registry, approvalHandler: new AutoApproveHandler() });
    const infoSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await executor.call('test.approval_required');
      expect(result['status']).toBe('executed');
    } finally {
      infoSpy.mockRestore();
    }
  });
});
