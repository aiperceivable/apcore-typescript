/**
 * Async task manager for background module execution.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Context } from './context.js';
import type { Executor } from './executor.js';

export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface TaskInfo {
  readonly taskId: string;
  readonly moduleId: string;
  readonly status: TaskStatus;
  readonly submittedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
}

type InternalTaskInfo = { -readonly [K in keyof TaskInfo]: TaskInfo[K] };

interface InternalTask {
  info: InternalTaskInfo;
  promise: Promise<void>;
  cancelled: boolean;
  resolve: () => void;
}

/**
 * Manages background execution of modules via Promises.
 *
 * Uses a simple counter-based concurrency limiter instead of a semaphore.
 */
export class AsyncTaskManager {
  private readonly _executor: Executor;
  private readonly _maxConcurrent: number;
  private readonly _maxTasks: number;
  private readonly _tasks: Map<string, InternalTask> = new Map();
  private _runningCount: number = 0;
  private readonly _waitQueue: Array<() => void> = [];

  constructor(executor: Executor, maxConcurrent: number = 10, maxTasks: number = 1000) {
    this._executor = executor;
    this._maxConcurrent = maxConcurrent;
    this._maxTasks = maxTasks;
  }

  /**
   * Submit a module for background execution.
   *
   * Returns the generated task_id. Async to satisfy the cross-SDK protocol contract.
   */
  async submit(
    moduleId: string,
    inputs: Record<string, unknown>,
    context?: Context | null,
  ): Promise<string> {
    if (this._tasks.size >= this._maxTasks) {
      throw new Error(`Task limit reached (${this._maxTasks})`);
    }
    const taskId = uuidv4();
    const info: InternalTaskInfo = {
      taskId,
      moduleId,
      status: TaskStatus.PENDING,
      submittedAt: Date.now() / 1000,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };

    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const internal: InternalTask = {
      info,
      promise,
      cancelled: false,
      resolve: resolvePromise,
    };

    this._tasks.set(taskId, internal);
    this._enqueue(taskId, moduleId, inputs, context ?? null);
    return taskId;
  }

  /**
   * Return the TaskInfo for a task, or null if not found.
   */
  getStatus(taskId: string): TaskInfo | null {
    const internal = this._tasks.get(taskId);
    return internal ? { ...internal.info } : null;
  }

  /**
   * Return the result of a completed task.
   *
   * Throws if the task is not found or not in COMPLETED status.
   */
  getResult(taskId: string): Record<string, unknown> {
    const internal = this._tasks.get(taskId);
    if (!internal) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (internal.info.status !== TaskStatus.COMPLETED) {
      throw new Error(`Task ${taskId} is not completed (status=${internal.info.status})`);
    }
    return internal.info.result!;
  }

  /**
   * Cancel a running or pending task.
   *
   * Sets the cancelled flag and updates status immediately.
   * The underlying execution may still be in-flight but its result
   * will be discarded when it completes.
   *
   * Returns true if the task was successfully marked as cancelled.
   * Async to satisfy the cross-SDK protocol contract.
   */
  async cancel(taskId: string): Promise<boolean> {
    const internal = this._tasks.get(taskId);
    if (!internal) return false;

    const { info } = internal;
    if (info.status !== TaskStatus.PENDING && info.status !== TaskStatus.RUNNING) {
      return false;
    }

    internal.cancelled = true;
    info.status = TaskStatus.CANCELLED;
    info.completedAt = Date.now() / 1000;
    return true;
  }

  /**
   * Return all tasks, optionally filtered by status.
   */
  listTasks(status?: TaskStatus): TaskInfo[] {
    const tasks = [...this._tasks.values()];
    const filtered = status ? tasks.filter(t => t.info.status === status) : tasks;
    return filtered.map(t => ({ ...t.info }));
  }

  /**
   * Remove terminal-state tasks older than maxAgeSeconds seconds.
   *
   * Terminal states: COMPLETED, FAILED, CANCELLED.
   * Returns the number of tasks removed.
   */
  cleanup(maxAgeSeconds: number = 3600): number {
    const terminal = new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]);
    const now = Date.now() / 1000;
    let removed = 0;

    for (const [taskId, internal] of this._tasks.entries()) {
      if (!terminal.has(internal.info.status)) continue;
      const refTime = internal.info.completedAt ?? internal.info.submittedAt;
      if ((now - refTime) >= maxAgeSeconds) {
        this._tasks.delete(taskId);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Cancel all pending and running tasks and wait for them to settle.
   */
  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [taskId, task] of this._tasks) {
      if (task.info.status === TaskStatus.PENDING || task.info.status === TaskStatus.RUNNING) {
        void this.cancel(taskId);
        promises.push(task.promise);
      }
    }
    await Promise.allSettled(promises);
  }

  /**
   * Acquire a concurrency slot. Resolves when a slot is available.
   */
  private _acquireSlot(): Promise<void> {
    if (this._runningCount < this._maxConcurrent) {
      this._runningCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waitQueue.push(() => {
        this._runningCount++;
        resolve();
      });
    });
  }

  /**
   * Release a concurrency slot and notify the next waiter.
   */
  private _releaseSlot(): void {
    this._runningCount--;
    if (this._waitQueue.length > 0) {
      const next = this._waitQueue.shift()!;
      next();
    }
  }

  /**
   * Enqueue the task for execution under the concurrency limit.
   */
  private _enqueue(
    taskId: string,
    moduleId: string,
    inputs: Record<string, unknown>,
    context: Context | null,
  ): void {
    const run = async (): Promise<void> => {
      const internal = this._tasks.get(taskId);
      if (!internal) return;

      try {
        await this._acquireSlot();

        // Check if cancelled while waiting for a slot
        if (internal.cancelled) {
          return; // finally block handles releaseSlot + resolve
        }

        internal.info.status = TaskStatus.RUNNING;
        internal.info.startedAt = Date.now() / 1000;

        const result = await this._executor.call(moduleId, inputs, context);

        // Check if cancelled during execution
        if (internal.cancelled) {
          return; // finally block handles releaseSlot + resolve
        }

        internal.info.status = TaskStatus.COMPLETED;
        internal.info.completedAt = Date.now() / 1000;
        internal.info.result = result;
      } catch (err) {
        if (!internal.cancelled) {
          internal.info.status = TaskStatus.FAILED;
          internal.info.completedAt = Date.now() / 1000;
          internal.info.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        this._releaseSlot();
        internal.resolve();
      }
    };

    // Fire and forget -- errors are captured inside run()
    run().catch((err) => {
      console.warn('[apcore:async-task] Unexpected error in task runner:', err);
    });
  }
}
