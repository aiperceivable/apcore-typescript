import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { AsyncTaskManager, TaskStatus } from '../src/async-task.js';
import type { TaskInfo } from '../src/async-task.js';
import { Executor } from '../src/executor.js';
import { FunctionModule } from '../src/decorator.js';
import { Registry } from '../src/registry/registry.js';

function createRegistry(): Registry {
  const registry = new Registry();

  const simpleModule = new FunctionModule({
    execute: (inputs) => ({ value: (inputs['x'] as number) ?? 0 }),
    moduleId: 'test.simple',
    inputSchema: Type.Object({ x: Type.Optional(Type.Number()) }),
    outputSchema: Type.Object({ value: Type.Number() }),
    description: 'Simple module',
  });

  const failingModule = new FunctionModule({
    execute: () => { throw new Error('intentional failure'); },
    moduleId: 'test.failing',
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    description: 'Failing module',
  });

  const slowModule = new FunctionModule({
    execute: async (inputs) => {
      const ms = (inputs['delay'] as number) ?? 1000;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { done: true };
    },
    moduleId: 'test.slow',
    inputSchema: Type.Object({ delay: Type.Optional(Type.Number()) }),
    outputSchema: Type.Object({ done: Type.Boolean() }),
    description: 'Slow module',
  });

  registry.register('test.simple', simpleModule);
  registry.register('test.failing', failingModule);
  registry.register('test.slow', slowModule);

  return registry;
}

function createManager(maxConcurrent: number = 10): { manager: AsyncTaskManager; executor: Executor } {
  const registry = createRegistry();
  const executor = new Executor({ registry });
  const manager = new AsyncTaskManager(executor, maxConcurrent);
  return { manager, executor };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TaskStatus', () => {
  it('has correct enum values', () => {
    expect(TaskStatus.PENDING).toBe('pending');
    expect(TaskStatus.RUNNING).toBe('running');
    expect(TaskStatus.COMPLETED).toBe('completed');
    expect(TaskStatus.FAILED).toBe('failed');
    expect(TaskStatus.CANCELLED).toBe('cancelled');
  });
});

describe('AsyncTaskManager', () => {
  describe('submit and status transitions', () => {
    it('submits a task and transitions to COMPLETED', async () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.simple', { x: 42 });

      const info = manager.getStatus(taskId);
      expect(info).not.toBeNull();
      expect(info!.moduleId).toBe('test.simple');

      await wait(100);

      const completed = manager.getStatus(taskId);
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe(TaskStatus.COMPLETED);
      expect(completed!.result).toEqual({ value: 42 });
      expect(completed!.startedAt).not.toBeNull();
      expect(completed!.completedAt).not.toBeNull();
      expect(completed!.error).toBeNull();
    });

    it('returns a unique task id', () => {
      const { manager } = createManager();
      const id1 = manager.submit('test.simple', { x: 1 });
      const id2 = manager.submit('test.simple', { x: 2 });
      expect(id1).not.toBe(id2);
    });
  });

  describe('task failure', () => {
    it('sets status to FAILED with error message', async () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.failing', {});

      await wait(100);

      const info = manager.getStatus(taskId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe(TaskStatus.FAILED);
      expect(info!.error).toContain('intentional failure');
      expect(info!.completedAt).not.toBeNull();
      expect(info!.result).toBeNull();
    });
  });

  describe('task cancellation', () => {
    it('cancels a running task', async () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.slow', { delay: 60000 });

      await wait(100);

      const info = manager.getStatus(taskId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe(TaskStatus.RUNNING);

      const cancelled = manager.cancel(taskId);
      expect(cancelled).toBe(true);

      const after = manager.getStatus(taskId);
      expect(after).not.toBeNull();
      expect(after!.status).toBe(TaskStatus.CANCELLED);
      expect(after!.completedAt).not.toBeNull();
    });

    it('returns false for nonexistent task', () => {
      const { manager } = createManager();
      const result = manager.cancel('no-such-id');
      expect(result).toBe(false);
    });

    it('returns false for already completed task', async () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.simple', { x: 1 });
      await wait(100);

      expect(manager.getStatus(taskId)!.status).toBe(TaskStatus.COMPLETED);

      const result = manager.cancel(taskId);
      expect(result).toBe(false);
    });
  });

  describe('concurrency limit', () => {
    it('limits concurrent executions to maxConcurrent', async () => {
      const { manager } = createManager(2);

      const taskIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        taskIds.push(manager.submit('test.slow', { delay: 60000 }));
      }

      await wait(200);

      const running = manager.listTasks(TaskStatus.RUNNING);
      const pending = manager.listTasks(TaskStatus.PENDING);

      expect(running.length).toBeLessThanOrEqual(2);
      expect(running.length + pending.length).toBe(4);

      // Cleanup: cancel all (synchronous, no need to await)
      for (const id of taskIds) {
        manager.cancel(id);
      }
    });
  });

  describe('getResult', () => {
    it('returns result for completed task', async () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.simple', { x: 99 });
      await wait(100);

      const result = manager.getResult(taskId);
      expect(result).toEqual({ value: 99 });
    });

    it('throws for unknown task', () => {
      const { manager } = createManager();
      expect(() => manager.getResult('no-such-task')).toThrow('Task not found');
    });

    it('throws for non-completed task', () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.slow', { delay: 60000 });

      expect(() => manager.getResult(taskId)).toThrow('not completed');

      manager.cancel(taskId);
    });
  });

  describe('getStatus', () => {
    it('returns null for unknown task', () => {
      const { manager } = createManager();
      expect(manager.getStatus('nonexistent')).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('returns all tasks', async () => {
      const { manager } = createManager();
      manager.submit('test.simple', { x: 1 });
      manager.submit('test.simple', { x: 2 });
      await wait(100);

      const all = manager.listTasks();
      expect(all.length).toBe(2);
    });

    it('filters tasks by status', async () => {
      const { manager } = createManager();
      manager.submit('test.simple', { x: 1 });
      manager.submit('test.failing', {});
      await wait(100);

      const completed = manager.listTasks(TaskStatus.COMPLETED);
      const failed = manager.listTasks(TaskStatus.FAILED);
      expect(completed.length).toBe(1);
      expect(failed.length).toBe(1);
    });
  });

  describe('max tasks limit', () => {
    it('throws when task limit is exceeded', () => {
      const { manager } = createManager();
      // Create a manager with a small limit
      const registry = createRegistry();
      const executor = new Executor({ registry });
      const limitedManager = new AsyncTaskManager(executor, 10, 3);

      limitedManager.submit('test.simple', { x: 1 });
      limitedManager.submit('test.simple', { x: 2 });
      limitedManager.submit('test.simple', { x: 3 });

      expect(() => limitedManager.submit('test.simple', { x: 4 })).toThrow(
        'Task limit reached (3)',
      );
    });

    it('allows submissions after cleanup frees slots', async () => {
      const registry = createRegistry();
      const executor = new Executor({ registry });
      const limitedManager = new AsyncTaskManager(executor, 10, 2);

      limitedManager.submit('test.simple', { x: 1 });
      limitedManager.submit('test.simple', { x: 2 });

      await wait(100);
      limitedManager.cleanup(0);

      // Should succeed after cleanup
      const taskId = limitedManager.submit('test.simple', { x: 3 });
      expect(taskId).toBeDefined();
    });
  });

  describe('double release fix', () => {
    it('does not corrupt concurrency counter when cancelling a queued task', async () => {
      // Use maxConcurrent=1 so the second task queues behind the first.
      // Delay/wait values are intentionally generous (500ms task / 700ms
      // settle) so the PENDING assertion below is robust under heavy
      // test-suite load — Node's setTimeout is best-effort and
      // `wait(20)` cumulative can stretch well past 50ms when many
      // test files run in parallel.
      const registry = createRegistry();
      const executor = new Executor({ registry });
      const mgr = new AsyncTaskManager(executor, 1);

      // Submit a long-enough task to fill the single slot
      const firstId = mgr.submit('test.slow', { delay: 500 });
      await wait(10);

      // Submit a second task -- it will be waiting in the queue
      const queuedId = mgr.submit('test.slow', { delay: 500 });
      await wait(10);

      // The queued task should still be PENDING (firstId has ~480ms left)
      expect(mgr.getStatus(queuedId)!.status).toBe(TaskStatus.PENDING);

      // Cancel the queued task while it's waiting for a slot
      mgr.cancel(queuedId);

      // Wait for the first task to complete, which releases the slot
      // and wakes the cancelled queued task. The queued task should
      // see cancelled=true and return; finally releases the slot once.
      await wait(700);

      // The running count should be 0 (not negative from double release)
      const runningCount = (mgr as unknown as { _runningCount: number })._runningCount;
      expect(runningCount).toBe(0);

      // Also verify the first task completed successfully
      expect(mgr.getStatus(firstId)!.status).toBe(TaskStatus.COMPLETED);
      expect(mgr.getStatus(queuedId)!.status).toBe(TaskStatus.CANCELLED);
    });
  });

  describe('cleanup', () => {
    it('removes old completed tasks', async () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.simple', { x: 1 });
      await wait(100);

      expect(manager.getStatus(taskId)!.status).toBe(TaskStatus.COMPLETED);

      const removed = manager.cleanup(0);
      expect(removed).toBe(1);
      expect(manager.getStatus(taskId)).toBeNull();
    });

    it('preserves recent tasks', async () => {
      const { manager } = createManager();
      manager.submit('test.simple', { x: 1 });
      await wait(100);

      const removed = manager.cleanup(3600);
      expect(removed).toBe(0);
      expect(manager.listTasks().length).toBe(1);
    });

    it('preserves running tasks', async () => {
      const { manager } = createManager();
      const taskId = manager.submit('test.slow', { delay: 60000 });
      await wait(100);

      const removed = manager.cleanup(0);
      expect(removed).toBe(0);

      manager.cancel(taskId);
    });
  });
});
