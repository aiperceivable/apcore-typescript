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

const TERMINAL_STATUSES = new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]);

export interface TaskInfo {
  readonly taskId: string;
  readonly moduleId: string;
  readonly status: TaskStatus;
  readonly submittedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly retryCount: number;
  readonly maxRetries: number;
}

export interface TaskStore {
  save(task: TaskInfo): void;
  get(taskId: string): TaskInfo | null;
  list(status?: TaskStatus): TaskInfo[];
  delete(taskId: string): void;
  listExpired(beforeTimestamp: number): TaskInfo[];
}

export class InMemoryTaskStore implements TaskStore {
  private readonly _data: Map<string, TaskInfo> = new Map();

  save(task: TaskInfo): void {
    this._data.set(task.taskId, task);
  }

  get(taskId: string): TaskInfo | null {
    return this._data.get(taskId) ?? null;
  }

  list(status?: TaskStatus): TaskInfo[] {
    const all = [...this._data.values()];
    return status ? all.filter(t => t.status === status) : all;
  }

  delete(taskId: string): void {
    this._data.delete(taskId);
  }

  listExpired(beforeTimestamp: number): TaskInfo[] {
    return [...this._data.values()].filter(
      t => TERMINAL_STATUSES.has(t.status) && t.completedAt !== null && t.completedAt < beforeTimestamp,
    );
  }
}

/**
 * Process-wide one-shot deprecation warning bookkeeping for {@link RetryConfig}
 * (sync finding D-08). Mirrors the cross-language convention: warn once per
 * unique deprecation key, then stay silent.
 */
const _RETRY_CONFIG_DEPRECATIONS_EMITTED: Set<string> = new Set();

function _emitRetryConfigDeprecation(key: string, message: string): void {
  if (_RETRY_CONFIG_DEPRECATIONS_EMITTED.has(key)) return;
  _RETRY_CONFIG_DEPRECATIONS_EMITTED.add(key);
  console.warn(message);
}

export class RetryConfig {
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly backoffMultiplier: number;
  readonly maxRetryDelayMs: number;

  constructor(opts: {
    maxRetries?: number;
    retryDelayMs?: number;
    backoffMultiplier?: number;
    maxRetryDelayMs?: number;
  } = {}) {
    this.maxRetries = opts.maxRetries ?? 0;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.backoffMultiplier = opts.backoffMultiplier ?? 2.0;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 60000;
  }

  /**
   * Compute the delay in milliseconds before the given retry attempt.
   *
   * Canonical cross-language name (sync finding D-08). Mirrors
   * `RetryConfig.compute_delay_ms` in apcore-python and
   * `RetryConfig::compute_delay_ms` in apcore-rust.
   */
  computeDelayMs(attempt: number): number {
    return Math.min(
      this.retryDelayMs * Math.pow(this.backoffMultiplier, attempt),
      this.maxRetryDelayMs,
    );
  }

  /**
   * @deprecated Use {@link RetryConfig.computeDelayMs} instead. Will be removed
   * in the next minor release. Sync finding D-08 — the canonical cross-language
   * method name is `computeDelayMs` (Python `compute_delay_ms`,
   * Rust `compute_delay_ms`).
   */
  computeDelay(attempt: number): number {
    _emitRetryConfigDeprecation(
      'RetryConfig.computeDelay',
      '[apcore] RetryConfig.computeDelay is deprecated; use computeDelayMs',
    );
    return this.computeDelayMs(attempt);
  }
}

export interface ReaperHandle {
  stop(): Promise<void>;
}

type MutableTaskInfo = { -readonly [K in keyof TaskInfo]: TaskInfo[K] };

interface InternalTask {
  promise: Promise<void>;
  cancelled: boolean;
  resolve: () => void;
}

interface AsyncTaskManagerOptions {
  executor: Executor;
  store?: TaskStore;
  maxConcurrent?: number;
  maxTasks?: number;
}

/**
 * Manages background execution of modules via Promises.
 *
 * Uses a simple counter-based concurrency limiter instead of a semaphore.
 */
export class AsyncTaskManager {
  private readonly _executor: Executor;
  private readonly _store: TaskStore;
  private readonly _maxConcurrent: number;
  private readonly _maxTasks: number;
  private readonly _internal: Map<string, InternalTask> = new Map();
  private _runningCount: number = 0;
  private readonly _waitQueue: Array<() => void> = [];
  private _reaper: ReaperHandle | null = null;

  constructor(opts: AsyncTaskManagerOptions) {
    this._executor = opts.executor;
    this._store = opts.store ?? new InMemoryTaskStore();
    this._maxConcurrent = opts.maxConcurrent ?? 10;
    this._maxTasks = opts.maxTasks ?? 1000;
  }

  get store(): TaskStore {
    return this._store;
  }

  /**
   * Submit a module for background execution.
   *
   * Returns the generated task_id. Async to satisfy the cross-SDK protocol contract.
   */
  async submit(
    moduleId: string,
    inputs: Record<string, unknown>,
    opts?: { context?: Context | null; retry?: RetryConfig },
  ): Promise<string> {
    if (this._internal.size >= this._maxTasks) {
      throw new Error(`Task limit reached (${this._maxTasks})`);
    }
    const taskId = uuidv4();
    const retry = opts?.retry ?? null;
    const info: MutableTaskInfo = {
      taskId,
      moduleId,
      status: TaskStatus.PENDING,
      submittedAt: Date.now() / 1000,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      retryCount: 0,
      maxRetries: retry?.maxRetries ?? 0,
    };

    this._store.save(info);

    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const internal: InternalTask = {
      promise,
      cancelled: false,
      resolve: resolvePromise,
    };

    this._internal.set(taskId, internal);
    this._enqueue(taskId, moduleId, inputs, opts?.context ?? null, retry);
    return taskId;
  }

  /**
   * Return the TaskInfo for a task, or null if not found.
   */
  getStatus(taskId: string): TaskInfo | null {
    const info = this._store.get(taskId);
    return info ? { ...info } : null;
  }

  /**
   * Return the result of a completed task.
   *
   * Throws if the task is not found or not in COMPLETED status.
   */
  getResult(taskId: string): Record<string, unknown> {
    const info = this._store.get(taskId);
    if (!info) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (info.status !== TaskStatus.COMPLETED) {
      throw new Error(`Task ${taskId} is not completed (status=${info.status})`);
    }
    return info.result!;
  }

  /**
   * Cancel a running or pending task.
   *
   * Returns true if the task was successfully marked as cancelled.
   */
  async cancel(taskId: string): Promise<boolean> {
    const info = this._store.get(taskId) as MutableTaskInfo | null;
    if (!info) return false;

    if (info.status !== TaskStatus.PENDING && info.status !== TaskStatus.RUNNING) {
      return false;
    }

    const internal = this._internal.get(taskId);
    if (!internal) return false;

    internal.cancelled = true;
    info.status = TaskStatus.CANCELLED;
    info.completedAt = Date.now() / 1000;
    this._store.save(info);
    return true;
  }

  /**
   * Return all tasks, optionally filtered by status.
   */
  listTasks(status?: TaskStatus): TaskInfo[] {
    return this._store.list(status).map(t => ({ ...t }));
  }

  /**
   * Remove terminal-state tasks older than maxAgeSeconds seconds.
   *
   * Returns the number of tasks removed.
   */
  cleanup(maxAgeSeconds: number = 3600): number {
    const threshold = Date.now() / 1000 - maxAgeSeconds;
    let removed = 0;

    for (const task of this._store.list()) {
      if (!TERMINAL_STATUSES.has(task.status)) continue;
      const refTime = task.completedAt ?? task.submittedAt;
      if (refTime <= threshold) {
        this._store.delete(task.taskId);
        this._internal.delete(task.taskId);
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
    for (const task of this._store.list()) {
      if (task.status === TaskStatus.PENDING || task.status === TaskStatus.RUNNING) {
        const internal = this._internal.get(task.taskId);
        void this.cancel(task.taskId);
        if (internal) promises.push(internal.promise);
      }
    }
    if (this._reaper) {
      await this._reaper.stop();
    }
    await Promise.allSettled(promises);
  }

  /**
   * Start a background reaper that periodically deletes expired terminal tasks.
   *
   * Returns a handle to stop the reaper. Throws if a reaper is already running.
   */
  startReaper(opts: { ttlSeconds?: number; sweepIntervalMs?: number } = {}): ReaperHandle {
    if (this._reaper !== null) {
      throw new Error('[apcore:async-task] Reaper already running; call stop() before starting again');
    }

    const ttlSeconds = opts.ttlSeconds ?? 3600;
    const sweepIntervalMs = opts.sweepIntervalMs ?? 300000;

    let stopped = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });

    const sweep = (): void => {
      if (stopped) return;
      const threshold = Date.now() / 1000 - ttlSeconds;
      const expired = this._store.listExpired(threshold);
      for (const task of expired) {
        this._store.delete(task.taskId);
        this._internal.delete(task.taskId);
      }
      if (!stopped) {
        timeoutHandle = setTimeout(sweep, sweepIntervalMs);
      }
    };

    timeoutHandle = setTimeout(sweep, sweepIntervalMs);

    const handle: ReaperHandle = {
      stop: async (): Promise<void> => {
        stopped = true;
        this._reaper = null;
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        resolveStop();
        await stopPromise;
      },
    };

    this._reaper = handle;
    return handle;
  }

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

  private _releaseSlot(): void {
    this._runningCount--;
    if (this._waitQueue.length > 0) {
      const next = this._waitQueue.shift()!;
      next();
    }
  }

  private _enqueue(
    taskId: string,
    moduleId: string,
    inputs: Record<string, unknown>,
    context: Context | null,
    retry: RetryConfig | null,
  ): void {
    const run = async (): Promise<void> => {
      const internal = this._internal.get(taskId);
      if (!internal) return;

      // slotHeld tracks whether we currently hold a concurrency slot.
      // We release it during backoff waits so other tasks can run.
      let slotHeld = false;

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          await this._acquireSlot();
          slotHeld = true;

          if (internal.cancelled) return;

          const info = this._store.get(taskId) as MutableTaskInfo | null;
          if (!info) return;

          info.status = TaskStatus.RUNNING;
          info.startedAt = Date.now() / 1000;
          this._store.save(info);

          let execError: unknown = null;
          let succeeded = false;

          try {
            const result = await this._executor.call(moduleId, inputs, context);
            if (!internal.cancelled) {
              info.status = TaskStatus.COMPLETED;
              info.completedAt = Date.now() / 1000;
              info.result = result;
              this._store.save(info);
              succeeded = true;
            }
          } catch (err) {
            execError = err;
          }

          this._releaseSlot();
          slotHeld = false;

          if (succeeded || internal.cancelled) return;

          if (retry && info.retryCount < retry.maxRetries) {
            const delay = retry.computeDelayMs(info.retryCount);
            info.retryCount += 1;
            info.status = TaskStatus.PENDING;
            info.startedAt = null;
            info.completedAt = null;
            this._store.save(info);

            await new Promise<void>((resolve) => setTimeout(resolve, delay));

            if (internal.cancelled) return;
            // Loop continues: re-acquire slot and retry
          } else {
            info.status = TaskStatus.FAILED;
            info.completedAt = Date.now() / 1000;
            info.error = execError instanceof Error ? execError.message : String(execError);
            this._store.save(info);
            return;
          }
        }
      } finally {
        if (slotHeld) this._releaseSlot();
        internal.resolve();
      }
    };

    run().catch((err) => {
      console.warn('[apcore:async-task] Unexpected error in task runner:', err);
    });
  }
}
