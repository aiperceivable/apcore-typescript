/**
 *  Execution pipeline types for configurable step-based module invocation.
 */

import type { Context } from './context.js';
import { ModuleError } from './errors.js';
import type { ErrorOptions } from './errors.js';
import { MiddlewareChainError } from './middleware/manager.js';
import { matchPattern } from './utils/pattern.js';

// ---------------------------------------------------------------------------
// Step interface
// ---------------------------------------------------------------------------

/** A single unit of work in the execution pipeline. */
export interface Step {
  readonly name: string;
  readonly description: string;
  readonly removable: boolean;
  readonly replaceable: boolean;

  /** Glob patterns for module IDs this step applies to. null/undefined = all. */
  readonly matchModules?: string[] | null;
  /** True = step failure logs warning and continues. False = step failure aborts pipeline. */
  readonly ignoreErrors?: boolean;
  /** True = no side effects. Safe to run during validate() (dry_run mode). */
  readonly pure?: boolean;
  /** Per-step timeout in milliseconds. 0 = no per-step timeout. */
  readonly timeoutMs?: number;

  /**
   * PipelineContext fields this step reads (e.g. "module", "context").
   *
   * ENFORCED, not advisory: {@link ExecutionStrategy} validates the pair at
   * construction and throws {@link PipelineDependencyError} when a `requires`
   * entry is not in the union of `seedProvides` and the `provides` of every
   * preceding step. `docs/features/middleware-system.md` § Configuration
   * safety states that as a MUST. The "Advisory only" these two comments used
   * to carry described the pre-#33 `console.warn`; it was left behind when
   * that warn became a throw in #33, and corrected in apcore#89.
   *
   * Declared by the step IMPLEMENTATION. `pipeline.configure` cannot set it —
   * see `CONFIGURABLE_STEP_FIELDS` in `pipeline-config.ts`.
   */
  readonly requires?: readonly string[];
  /**
   * PipelineContext fields this step writes (e.g. "output",
   * "validated_inputs"). Enforced and implementation-declared, exactly as
   * {@link Step.requires} above.
   */
  readonly provides?: readonly string[];

  execute(ctx: PipelineContext): Promise<StepResult>;
}

// ---------------------------------------------------------------------------
// StepResult
// ---------------------------------------------------------------------------

/** Result returned by a pipeline step execution. */
export interface StepResult {
  action: 'continue' | 'skip_to' | 'abort';
  skipTo?: string | null;
  explanation?: string | null;
  confidence?: number | null;
  alternatives?: string[] | null;
}

// ---------------------------------------------------------------------------
// PipelineState
// ---------------------------------------------------------------------------

/** Snapshot passed to runUntil predicates after each step completes (§1.4). */
export interface PipelineState {
  readonly stepName: string;
  readonly outputs: Record<string, unknown>;
  readonly context: PipelineContext;
}

// ---------------------------------------------------------------------------
// StepMiddleware (Issue #33 §2.2)
// ---------------------------------------------------------------------------

/**
 * Middleware interface for intercepting pipeline step lifecycle (Issue #33 §2.2).
 *
 * Each method is optional. The PipelineEngine invokes them in this order
 * around every step:
 *
 *   beforeStep → step.execute → afterStep   (success path)
 *   beforeStep → step.execute → onStepError (failure path)
 *
 * Ordering is the **onion model**, identical to the module-level middleware
 * chain and pinned by the `pipeline_step_middleware` conformance fixture:
 *
 *   - `beforeStep`  runs in REGISTRATION order.
 *   - `afterStep`   runs in REVERSE registration order.
 *   - `onStepError` runs in REVERSE registration order.
 *
 * `beforeStep` is an OBSERVATION hook: a `Step` is `execute(ctx)`, so there
 * is no step-inputs parameter for a middleware to replace and the return
 * value carries no meaning. Input rewriting is the module-level
 * `Middleware.before` contract. A `beforeStep` that throws aborts the chain
 * (the step body does NOT run), is wrapped in `MiddlewareChainError`, and
 * triggers `onStepError` on the already-executed middlewares only.
 *
 * `onStepError` MAY return a non-null recovery value to suppress the error
 * and continue the pipeline. Returning `null` (or `undefined`) lets the next
 * handler try; if none recovers, the original error propagates. The FIRST
 * middleware to return non-null wins and short-circuits the rest.
 *
 * All methods may be sync or async. The engine awaits any thenable return
 * value (mirroring Issue #42's middleware fix) so plain functions returning
 * a Promise are not silently dropped.
 */
export interface StepMiddleware {
  /**
   * Invoked before a step's `execute()` runs, in registration order.
   * Observation only — the return value is ignored by the engine.
   */
  beforeStep?(stepName: string, state: PipelineState): void | Promise<void>;
  /**
   * Invoked after a step's `execute()` completes successfully, in reverse
   * registration order (onion model).
   */
  afterStep?(stepName: string, state: PipelineState, result: unknown): void | Promise<void>;
  /**
   * Invoked in reverse registration order when a step's `execute()` throws.
   * Return non-null to recover — the engine treats the value as the step's
   * recovery output, short-circuits the remaining handlers, fires `afterStep`
   * to close the onion, and continues. Return null/undefined to let the next
   * middleware try, or — if no middleware recovers — to propagate the error
   * (subject to the step's `ignoreErrors`).
   *
   * ALSO invoked when a `beforeStep` hook threw — but there it is OBSERVATION
   * AND CLEANUP ONLY, and the two paths MUST NOT be conflated. On that path
   * every already-entered middleware is notified (no short-circuit), the
   * returned value is DISCARDED, `afterStep` does NOT fire, the step's
   * `ignoreErrors` does NOT apply, and `MiddlewareChainError` propagates
   * regardless. Honouring a recovery there would advance the pipeline past a
   * step whose body never ran — `acl_check` and `approval_gate` are in that
   * sequence, so it is a silent authorization bypass. See
   * docs/features/middleware-system.md → "A `before_step` failure terminates
   * the step — it is not recoverable".
   *
   * Per the spec this hook MUST NOT raise: an exception thrown here is logged
   * and iteration continues with the next handler.
   */
  onStepError?(
    stepName: string,
    state: PipelineState,
    error: Error,
  ): unknown | null | Promise<unknown | null>;
}

/**
 * Detect a thenable (Promise-like) without calling `.then`.
 *
 * Mirrors the Issue #42 fix in MiddlewareManager: handlers may not be
 * declared `async` but still return a Promise; treating those values as
 * sync would silently drop their effects.
 */
function _isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

async function _maybeAwait<T>(value: T | PromiseLike<T>): Promise<T> {
  if (_isThenable(value)) {
    return await (value as PromiseLike<T>);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// PipelineContext
// ---------------------------------------------------------------------------

/** Holds all state flowing through the pipeline. */
export interface PipelineContext {
  moduleId: string;
  inputs: Record<string, unknown>;
  context: Context;
  module?: unknown | null;
  validatedInputs?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  validatedOutput?: Record<string, unknown> | null;
  stream?: boolean;
  outputStream?: AsyncGenerator | null;
  strategy?: ExecutionStrategy | null;
  trace?: PipelineTrace | null;

  /** True during validate(). PipelineEngine skips steps with pure=false. */
  dryRun?: boolean;
  /** Passed through to module_lookup for version negotiation. */
  versionHint?: string | null;
  /** Tracks which middleware ran, enabling on_error recovery chain. */
  executedMiddlewares?: unknown[];
  /** When set, pipeline halts after the first step where predicate returns true (§1.4). */
  runUntil?: ((state: PipelineState) => boolean) | null;
}

// ---------------------------------------------------------------------------
// StepTrace
// ---------------------------------------------------------------------------

/** Records execution details for a single step. */
export interface StepTrace {
  name: string;
  durationMs: number;
  result: StepResult;
  skipped: boolean;
  decisionPoint: boolean;
  /** Reason the step was skipped: "no_match", "dry_run", or "error_ignored". */
  skipReason?: string | null;
}

// ---------------------------------------------------------------------------
// PipelineTrace
// ---------------------------------------------------------------------------

/** Records execution details for the entire pipeline run. */
export interface PipelineTrace {
  moduleId: string;
  strategyName: string;
  steps: StepTrace[];
  totalDurationMs: number;
  success: boolean;
}

// ---------------------------------------------------------------------------
// StrategyInfo
// ---------------------------------------------------------------------------

/** AI-introspectable description of an execution strategy. */
export interface StrategyInfo {
  name: string;
  stepCount: number;
  stepNames: string[];
  description: string;
}

/**
 * What is actually gating an executor's registry (PROTOCOL_SPEC 6.6.5).
 *
 * Eight plain observations plus one derived flag. `acl != null` is not the
 * answer to "what is gating this registry": the ACL and approval gates are
 * pipeline *steps*, and the `internal`, `testing` and `minimal` strategies all
 * remove them — so an executor can hold an ACL that no step ever consults.
 *
 * Returned by {@link Executor.governanceState}. Pure data: reading it enforces
 * nothing and changes nothing.
 */
export interface GovernanceState {
  /** At least one `system.control.*` module is in the registry. */
  controlModulesRegistered: boolean;
  /** At least one read-only `system.*` module is in the registry. */
  readModulesRegistered: boolean;
  /** An ACL object is attached to the executor. */
  aclConfigured: boolean;
  /** The running strategy contains the built-in ACL gate, matched by TYPE. */
  builtinAclGateWired: boolean;
  /** An ApprovalHandler is attached. */
  approvalHandlerConfigured: boolean;
  /** The running strategy contains the built-in approval gate, matched by TYPE. */
  builtinApprovalGateWired: boolean;
  /** An ExecutionPolicy with `strict = true` is attached. */
  policyStrict: boolean;
  /**
   * Every registered `system.control.*` module declares `requiresApproval`.
   *
   * Required by the derived flag because the two gates are not symmetric
   * (PROTOCOL_SPEC 6.6.5.1.1): `acl_check` evaluates every call, but
   * `approval_gate` resolves per module and returns before consulting the
   * handler when the module does not need approval. `false` when no control
   * module is registered.
   */
  allControlModulesRequireApproval: boolean;
  /**
   * Control modules are registered and no recognised built-in gate engages.
   *
   * Reports the **absence of a gate**, never the presence of protection: a
   * wired ACL that permits every call still yields `false`. And `true` does not
   * mean the call will succeed — a custom step, custom middleware or an
   * upstream gateway is invisible here by construction.
   */
  unprotectedControlSurface: boolean;
}

// ---------------------------------------------------------------------------
// ExecutionStrategy
// ---------------------------------------------------------------------------

/**
 * Optional configuration for {@link ExecutionStrategy}.
 *
 * `seedProvides` lists pipeline-context fields that are guaranteed to be
 * populated by an external caller before the first step runs. They count
 * as "already provided" during dependency validation (Issue #33 §2.1) so
 * that legitimate sub-strategies — for example the post-stream strategy
 * built from {@link Step}s of a parent strategy — do not raise spurious
 * `PipelineDependencyError`s. Use sparingly; prefer adding the missing
 * upstream step when possible.
 */
export interface ExecutionStrategyOptions {
  /** Names of pipeline-context fields the caller will pre-populate. */
  readonly seedProvides?: readonly string[];
}

/** An ordered sequence of steps that defines how a module is executed. */
export class ExecutionStrategy {
  readonly name: string;
  private _steps: Step[];
  private _nameToIdx: Map<string, number>;
  private readonly _seedProvides: ReadonlySet<string>;

  constructor(name: string, steps: Step[], options?: ExecutionStrategyOptions) {
    this.name = name;
    this._steps = [...steps];
    this._nameToIdx = new Map();
    this._seedProvides = new Set(options?.seedProvides ?? []);
    // Validate unique step names
    const names = this._steps.map((s) => s.name);
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) {
        dupes.add(n);
      }
      seen.add(n);
    }
    if (dupes.size > 0) {
      throw new StepNameDuplicateError(`Duplicate step names: ${[...dupes].join(', ')}`);
    }
    this._rebuildIndex();
    this._validateDependencies();
  }

  /** Rebuild the O(1) name→index map. Call after any mutation (§1.5). */
  private _rebuildIndex(): void {
    this._nameToIdx = new Map(this._steps.map((s, i) => [s.name, i]));
  }

  /**
   * Fail-fast: throw `PipelineDependencyError` if any step's `requires` are not
   * provided by a preceding step (Issue #33 §2.1).
   *
   * Previously this method emitted a `console.warn` and let construction
   * succeed; that allowed misconfigured strategies to run partway and fail
   * with a confusing runtime error. Throwing at construction surfaces the
   * problem immediately and tells the caller which step / field is missing.
   */
  private _validateDependencies(): void {
    const provided = new Set<string>(this._seedProvides);
    for (const step of this._steps) {
      const requires = step.requires ?? [];
      const missing: string[] = [];
      for (const req of requires) {
        if (!provided.has(req)) {
          missing.push(req);
        }
      }
      if (missing.length > 0) {
        throw new PipelineDependencyError(step.name, missing);
      }
      for (const p of step.provides ?? []) {
        provided.add(p);
      }
    }
  }

  get steps(): readonly Step[] {
    return this._steps;
  }

  /** Return the index of a step by name, or undefined if not found. O(1). */
  findStepIndex(name: string): number | undefined {
    return this._nameToIdx.get(name);
  }

  /** Insert a step after the named anchor step. */
  insertAfter(anchor: string, step: Step): void {
    if (this._nameToIdx.has(step.name)) {
      throw new StepNameDuplicateError(`Step '${step.name}' already exists`);
    }
    const anchorIdx = this._nameToIdx.get(anchor);
    if (anchorIdx === undefined) {
      throw new StepNotFoundError(`Anchor step '${anchor}' not found`);
    }
    this._steps.splice(anchorIdx + 1, 0, step);
    this._rebuildIndex();
    this._validateDependencies();
  }

  /** Insert a step before the named anchor step. */
  insertBefore(anchor: string, step: Step): void {
    if (this._nameToIdx.has(step.name)) {
      throw new StepNameDuplicateError(`Step '${step.name}' already exists`);
    }
    const anchorIdx = this._nameToIdx.get(anchor);
    if (anchorIdx === undefined) {
      throw new StepNotFoundError(`Anchor step '${anchor}' not found`);
    }
    this._steps.splice(anchorIdx, 0, step);
    this._rebuildIndex();
    this._validateDependencies();
  }

  /** Remove a step by name. Raises if the step is not removable. */
  remove(stepName: string): void {
    const idx = this._nameToIdx.get(stepName);
    if (idx === undefined) {
      throw new StepNotFoundError(`Step '${stepName}' not found`);
    }
    if (!this._steps[idx].removable) {
      throw new StepNotRemovableError(`Step '${stepName}' is not removable`);
    }
    this._steps.splice(idx, 1);
    this._rebuildIndex();
  }

  /** Replace a step by name. Raises if the step is not replaceable. */
  replace(stepName: string, newStep: Step): void {
    const idx = this._nameToIdx.get(stepName);
    if (idx === undefined) {
      throw new StepNotFoundError(`Step '${stepName}' not found`);
    }
    if (!this._steps[idx].replaceable) {
      throw new StepNotReplaceableError(`Step '${stepName}' is not replaceable`);
    }
    this._steps[idx] = newStep;
    this._rebuildIndex();
  }

  /**
   * Replace a step by name using replace semantics (§1.2).
   *
   * Calling configureStep twice with the same stepName always leaves exactly
   * one step at that position — idempotent, never duplicates.
   */
  configureStep(stepName: string, newStep: Step): void {
    const idx = this._nameToIdx.get(stepName);
    if (idx === undefined) {
      throw new PipelineStepNotFoundError(stepName);
    }
    if (!this._steps[idx].replaceable) {
      throw new StepNotReplaceableError(`Step '${stepName}' is not replaceable`);
    }
    // Guard: reject if newStep.name already exists at a different position.
    // Allowing it would silently produce duplicate names in _steps and corrupt
    // _nameToIdx (the second entry for that name would shadow the first).
    if (newStep.name !== stepName && this._nameToIdx.has(newStep.name)) {
      throw new StepNameDuplicateError(
        `Step '${newStep.name}' already exists at a different position`,
      );
    }
    this._steps[idx] = newStep;
    this._rebuildIndex();
  }

  /** Return the ordered list of step names. */
  stepNames(): string[] {
    return this._steps.map((s) => s.name);
  }

  /** Return an AI-introspectable description of this strategy. */
  info(): StrategyInfo {
    return {
      name: this.name,
      stepCount: this._steps.length,
      stepNames: this.stepNames(),
      description: this.stepNames().join(' → '),
    };
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Raised when a pipeline is aborted at a step. */
export class PipelineAbortError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  readonly step: string;
  readonly explanation: string | null;
  readonly alternatives: string[] | null;
  readonly pipelineTrace: PipelineTrace | null;

  constructor(
    step: string,
    explanation?: string | null,
    alternatives?: string[] | null,
    trace?: PipelineTrace | null,
    options?: ErrorOptions,
  ) {
    super(
      'PIPELINE_ABORT',
      `Pipeline aborted at step '${step}': ${explanation ?? 'no explanation'}`,
      { step },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'PipelineAbortError';
    this.step = step;
    this.explanation = explanation ?? null;
    this.alternatives = alternatives ?? null;
    this.pipelineTrace = trace ?? null;
  }
}

/** Raised when a referenced step does not exist. */
export class StepNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string = '', options?: ErrorOptions) {
    super(
      'STEP_NOT_FOUND',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'StepNotFoundError';
  }
}

/** Raised when attempting to remove a non-removable step. */
export class StepNotRemovableError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string = '', options?: ErrorOptions) {
    super(
      'STEP_NOT_REMOVABLE',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'StepNotRemovableError';
  }
}

/** Raised when attempting to replace a non-replaceable step. */
export class StepNotReplaceableError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string = '', options?: ErrorOptions) {
    super(
      'STEP_NOT_REPLACEABLE',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'StepNotReplaceableError';
  }
}

/** Raised when a step name already exists in the strategy. */
export class StepNameDuplicateError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string = '', options?: ErrorOptions) {
    super(
      'STEP_NAME_DUPLICATE',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'StepNameDuplicateError';
  }
}

/**
 * Raised when a pipeline step fails (fail-fast, §1.1).
 *
 * Wraps the original exception from the failing step. When ignore_errors is
 * true on the step, this error is NOT raised — execution continues instead.
 */
export class PipelineStepError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  readonly stepName: string;
  readonly pipelineTrace: PipelineTrace | null;

  constructor(
    stepName: string,
    cause?: Error | null,
    trace?: PipelineTrace | null,
    options?: ErrorOptions,
  ) {
    const causeMsg = cause?.message ?? 'unknown error';
    super(
      'PIPELINE_STEP_ERROR',
      `Pipeline step '${stepName}' failed: ${causeMsg}`,
      { stepName },
      cause ?? undefined,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'PipelineStepError';
    this.stepName = stepName;
    this.pipelineTrace = trace ?? null;
  }
}

/**
 * Raised at strategy construction when a step's declared `requires` are not
 * provided by any preceding step (Issue #33 §2.1).
 *
 * This replaces the previous `console.warn` in `_validateDependencies`. The
 * error names the offending step and the missing fields so the caller can
 * fix the strategy definition before any step runs.
 */
export class PipelineDependencyError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  readonly stepName: string;
  readonly missingRequires: string[];

  constructor(stepName: string, missingRequires: string[], options?: ErrorOptions) {
    super(
      'PIPELINE_DEPENDENCY_ERROR',
      `Pipeline step '${stepName}' requires [${missingRequires.join(
        ', ',
      )}], but no preceding step provides ${missingRequires.length === 1 ? 'it' : 'them'}.`,
      { stepName, missingRequires: [...missingRequires] },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'PipelineDependencyError';
    this.stepName = stepName;
    this.missingRequires = [...missingRequires];
  }
}

/** Raised when configureStep targets a step name that does not exist. */
export class PipelineStepNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  readonly stepName: string;

  constructor(stepName: string = '', options?: ErrorOptions) {
    super(
      'PIPELINE_STEP_NOT_FOUND',
      `Pipeline step not found: '${stepName}'`,
      { stepName },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'PipelineStepNotFoundError';
    this.stepName = stepName;
  }
}

// ---------------------------------------------------------------------------
// PipelineEngine
// ---------------------------------------------------------------------------

/** Executes an ExecutionStrategy against a PipelineContext, returning the final output and a complete execution trace. */
export class PipelineEngine {
  /**
   * Registered step-lifecycle middlewares (Issue #33 §2.2). Invoked in
   * registration order around every step's execute() call.
   */
  private readonly _stepMiddlewares: StepMiddleware[] = [];

  /** Read-only view of the registered step middlewares. */
  get stepMiddlewares(): readonly StepMiddleware[] {
    return this._stepMiddlewares;
  }

  /**
   * Register a `StepMiddleware` to intercept every step's lifecycle
   * (Issue #33 §2.2). `beforeStep` runs in registration order; `afterStep`
   * and `onStepError` run in REVERSE registration order (onion model).
   * `onStepError` is consulted until one returns a non-null recovery value.
   */
  addStepMiddleware(mw: StepMiddleware): void {
    this._stepMiddlewares.push(mw);
  }

  /**
   * Invoke `afterStep` on `middlewares` in REVERSE registration order
   * (onion model — the middleware registered last is the innermost wrapper,
   * so it unwinds first).
   */
  private async _runAfterStepHooks(
    stepName: string,
    state: PipelineState,
    result: unknown,
    middlewares: readonly StepMiddleware[],
  ): Promise<void> {
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i];
      if (mw.afterStep) {
        await _maybeAwait(mw.afterStep(stepName, state, result));
      }
    }
  }

  /**
   * Invoke `onStepError` on `middlewares` in REVERSE registration order and
   * return the FIRST non-null recovery value, short-circuiting the remaining
   * handlers. Returns `null` when nobody recovers.
   *
   * `middlewares` is the already-executed slice, so a failure inside a
   * `beforeStep` hook never notifies middlewares that never ran.
   *
   * Per docs/features/middleware-system.md, `onStepError` MUST NOT raise:
   * an exception from a handler is logged and iteration continues.
   */
  private async _runStepErrorHooks(
    stepName: string,
    state: PipelineState,
    error: Error,
    middlewares: readonly StepMiddleware[],
  ): Promise<unknown> {
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i];
      if (!mw.onStepError) continue;
      let ret: unknown;
      try {
        ret = await _maybeAwait(mw.onStepError(stepName, state, error));
      } catch (e) {
        console.warn(
          `[apcore:pipeline] StepMiddleware.onStepError threw for step '${stepName}':`,
          e,
        );
        continue;
      }
      if (ret != null) return ret;
    }
    return null;
  }

  /**
   * Invoke `onStepError` on `middlewares` in REVERSE registration order for
   * OBSERVATION AND CLEANUP ONLY, discarding every return value.
   *
   * This is the `beforeStep`-failure unwind. It is deliberately NOT
   * `_runStepErrorHooks`: that method stops at the first non-null return
   * because it is shopping for a recovery value, and there is no recovery to
   * be had here (docs/features/middleware-system.md → "A `before_step` failure
   * terminates the step — it is not recoverable"). Short-circuiting would also
   * strand the cleanup of every middleware registered before the one that
   * happened to return something, so EVERY middleware that entered
   * `beforeStep` is notified. Pinned by `pipeline_step_middleware.json` →
   * `before_step_failure_recovery_is_discarded.expected.on_step_error_invoked`,
   * which lists both middlewares even though the inner one returns a recovery.
   *
   * Matches apcore-rust, which iterates `middlewares[..before_executed].rev()`
   * and drops the result.
   */
  private async _runStepCleanupHooks(
    stepName: string,
    state: PipelineState,
    error: Error,
    middlewares: readonly StepMiddleware[],
  ): Promise<void> {
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i];
      if (!mw.onStepError) continue;
      try {
        await _maybeAwait(mw.onStepError(stepName, state, error));
      } catch (e) {
        console.warn(
          `[apcore:pipeline] StepMiddleware.onStepError threw while unwinding a ` +
            `failed beforeStep for step '${stepName}':`,
          e,
        );
      }
    }
  }

  /**
   * Publish an `onStepError` recovery value as the step's output.
   *
   * `docs/features/middleware-system.md` → "Normative Rules": *"Returning a
   * non-null/non-None/`Some(...)` value MUST be treated as recovery output …
   * the recovery value becomes the step's output."* Pinned by
   * `pipeline_step_middleware.json` →
   * `on_step_error_recovery_short_circuits.expected.step_output`.
   *
   * ONLY the STEP-BODY failure path may call this. A `beforeStep` failure is
   * NOT recoverable — its `onStepError` return value is discarded rather than
   * published, because the step body never ran and publishing it would let the
   * pipeline advance past `acl_check` / `approval_gate`. See the
   * `chainError !== null` branch in `run()` and the fixture case
   * `before_step_failure_recovery_is_discarded`.
   *
   * This SDK previously treated the recovery value as informational and left
   * `ctx.output` untouched, which made it the only SDK violating that MUST —
   * apcore-python assigns `ctx.output = recovery` and apcore-rust
   * `ctx.output = Some(value)`.
   *
   * `PipelineContext.output` is `Record<string, unknown> | null`, so only a
   * plain object can be represented. Arrays and scalars still suppress the
   * error and still reach `afterStep`; they just cannot become the output.
   * This matches apcore-python, which assigns only when the recovery
   * `isinstance(recovery, dict)`.
   */
  private static _applyRecoveryOutput(ctx: PipelineContext, recovery: unknown): void {
    if (typeof recovery === 'object' && recovery !== null && !Array.isArray(recovery)) {
      ctx.output = recovery as Record<string, unknown>;
    }
  }

  /** Run every step in the strategy against ctx, respecting flow-control actions (continue, skip_to, abort). */
  async run(strategy: ExecutionStrategy, ctx: PipelineContext): Promise<[unknown, PipelineTrace]> {
    const pipelineStart = performance.now();
    const steps = strategy.steps;
    const trace: PipelineTrace = {
      moduleId: ctx.moduleId,
      strategyName: strategy.name,
      steps: [],
      totalDurationMs: 0,
      success: false,
    };
    ctx.trace = trace;

    const stepOutputs: Record<string, unknown> = {};

    let idx = 0;
    while (idx < steps.length) {
      const step = steps[idx];

      // Read declarations (optional fields, backward compat via ?? defaults)
      const stepMatchModules = step.matchModules ?? null;
      const stepIgnoreErrors = step.ignoreErrors ?? false;
      const stepPure = step.pure ?? false;
      const stepTimeoutMs = step.timeoutMs ?? 0;

      // 1 match_modules filter
      if (stepMatchModules !== null) {
        const matched = stepMatchModules.some((pattern) => matchPattern(pattern, ctx.moduleId));
        if (!matched) {
          trace.steps.push({
            name: step.name,
            durationMs: 0,
            result: { action: 'continue' },
            skipped: true,
            decisionPoint: false,
            skipReason: 'no_match',
          });
          idx += 1;
          continue;
        }
      }

      // 2 dry_run filter: skip steps with side effects
      if (ctx.dryRun && !stepPure) {
        trace.steps.push({
          name: step.name,
          durationMs: 0,
          result: { action: 'continue' },
          skipped: true,
          decisionPoint: false,
          skipReason: 'dry_run',
        });
        idx += 1;
        continue;
      }

      // 3 Execute with per-step timeout, wrapped in StepMiddleware hooks (§2.2)
      const stepStart = performance.now();
      const stepState: PipelineState = {
        stepName: step.name,
        outputs: stepOutputs,
        context: ctx,
      };

      // 4 a beforeStep hooks (registration order). Observation only — the
      //     return value is deliberately discarded: a Step is execute(ctx),
      //     so there is no step-inputs parameter to replace.
      //
      //     A hook that throws aborts the chain (the step body does NOT run),
      //     is wrapped in MiddlewareChainError — mirroring the module-level
      //     contract — and triggers onStepError on the already-executed
      //     middlewares only, in reverse order.
      const executedStepMws: StepMiddleware[] = [];
      let chainError: MiddlewareChainError | null = null;
      for (const mw of this._stepMiddlewares) {
        executedStepMws.push(mw);
        if (!mw.beforeStep) continue;
        try {
          await _maybeAwait(mw.beforeStep(step.name, stepState));
        } catch (e) {
          chainError = new MiddlewareChainError(
            e instanceof Error ? e : new Error(String(e)),
            [...executedStepMws],
          );
          break;
        }
      }

      if (chainError !== null) {
        const durationMs = performance.now() - stepStart;
        // A `beforeStep` failure TERMINATES the step — it is NOT recoverable
        // (docs/features/middleware-system.md → "A `before_step` failure
        // terminates the step — it is not recoverable").
        //
        // `onStepError` still runs, in reverse order, over the middlewares that
        // had already entered `beforeStep` — but for OBSERVATION AND CLEANUP
        // ONLY, hence `_runStepCleanupHooks` rather than `_runStepErrorHooks`.
        // Whatever it returns is deliberately DISCARDED: it must not become the
        // step's output (no `_applyRecoveryOutput`) and it must not let the
        // pipeline advance (no `idx += 1; continue`).
        //
        // Honouring it would advance the pipeline past a step whose body never
        // ran. The built-in strategy places `acl_check` and `approval_gate` in
        // that sequence, so a middleware able to make its own `beforeStep`
        // throw and then return a value from `onStepError` would skip the ACL
        // check or the approval gate outright — a silent authorization bypass
        // reachable from an extension point that carries no authority.
        //
        // This is NOT the module-level contract despite the shared vocabulary:
        // a module-level recovery TERMINATES the call and *is* the return
        // value, whereas a step-level recovery RESUMES a pipeline.
        await this._runStepCleanupHooks(step.name, stepState, chainError, executedStepMws);

        // `afterStep` MUST NOT fire: no step body ran, so there is nothing to
        // close over, and the onion is already torn (some middlewares entered
        // `beforeStep`, others never did).
        //
        // The step's `ignoreErrors` MUST NOT apply either — note that
        // `stepIgnoreErrors` is deliberately not consulted anywhere on this
        // path. `ignoreErrors` declares that THIS STEP's failure is tolerable;
        // a broken middleware chain is not a step failure. The error is also
        // NOT re-wrapped in PipelineStepError: MiddlewareChainError propagates
        // as-is, carrying the original error on `.original`.
        trace.steps.push({
          name: step.name,
          durationMs,
          result: {
            action: 'abort',
            explanation: chainError.message,
          },
          skipped: false,
          decisionPoint: false,
        });
        trace.totalDurationMs = performance.now() - pipelineStart;
        throw chainError;
      }

      let result: StepResult;
      try {
        if (stepTimeoutMs > 0) {
          let timer: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Step '${step.name}' timed out after ${stepTimeoutMs}ms`));
            }, stepTimeoutMs);
          });
          result = await Promise.race([step.execute(ctx), timeoutPromise]).finally(() => {
            clearTimeout(timer!);
          });
        } else {
          result = await step.execute(ctx);
        }
      } catch (exc) {
        const durationMs = performance.now() - stepStart;
        const cause = exc instanceof Error ? exc : new Error(String(exc));

        // 3 b onStepError hooks: reverse registration order (onion model),
        //     first non-null recovery wins and short-circuits the rest (§2.2).
        const recovery = await this._runStepErrorHooks(
          step.name,
          stepState,
          cause,
          executedStepMws,
        );

        if (recovery != null) {
          // The recovery value BECOMES the step's output (Normative Rules;
          // see _applyRecoveryOutput). It is also surfaced to afterStep hooks
          // and recorded in the trace explanation.
          PipelineEngine._applyRecoveryOutput(ctx, recovery);
          const recoveredResult: StepResult = {
            action: 'continue',
            explanation: `recovered from: ${cause.message}`,
          };
          trace.steps.push({
            name: step.name,
            durationMs,
            result: recoveredResult,
            skipped: false,
            decisionPoint: false,
            skipReason: 'error_recovered',
          });
          // afterStep hooks still fire on recovery — middlewares treat recovery
          // as a successful (post-step) outcome and may want to record metrics.
          await this._runAfterStepHooks(step.name, stepState, recovery, executedStepMws);
          // ORDER IS LOAD-BEARING: the snapshot happens AFTER the hooks.
          // `state.outputs` holds exactly the steps that completed BEFORE the
          // current one, in all three hooks (middleware-system.md → "What
          // `state.outputs` contains"), and ordering the snapshot after the
          // hook is what enforces it. A recovered step's output reaches
          // `afterStep` as the `result` argument; carrying the same value down
          // two paths is how the two drift apart. This is the RECOVERY copy of
          // the rule — the conformance fixture recovers from nothing and
          // cannot reach it, so it is pinned by
          // tests/test-pipeline-step-middleware.test.ts instead.
          stepOutputs[step.name] = ctx.output != null ? { ...ctx.output } : null;
          idx += 1;
          continue;
        }

        // 4 ignore_errors: log and continue
        if (stepIgnoreErrors) {
          console.warn(`[apcore:pipeline] Step '${step.name}' failed (ignored):`, cause.message);
          trace.steps.push({
            name: step.name,
            durationMs,
            result: {
              action: 'continue',
              explanation: cause.message,
            },
            skipped: false,
            decisionPoint: false,
            skipReason: 'error_ignored',
          });
          idx += 1;
          continue;
        }
        // Fail-fast (§1.1): wrap in PipelineStepError with step name and cause
        trace.steps.push({
          name: step.name,
          durationMs,
          result: {
            action: 'abort',
            explanation: cause.message,
          },
          skipped: false,
          decisionPoint: false,
        });
        trace.totalDurationMs = performance.now() - pipelineStart;
        throw new PipelineStepError(step.name, cause, trace);
      }

      const durationMs = performance.now() - stepStart;

      // 3 c afterStep hooks (REVERSE registration order, success path).
      //     These run BEFORE `stepOutputs[step.name]` is written below, and
      //     that order is load-bearing: `state.outputs` MUST contain exactly
      //     the steps that completed before the current one, so the current
      //     step is absent from `afterStep` too — its output is the `result`
      //     argument. Pinned by pipeline_step_middleware.json →
      //     `state_outputs_excludes_the_current_step_in_every_hook`.
      await this._runAfterStepHooks(step.name, stepState, result, executedStepMws);

      // 5 Record trace
      trace.steps.push({
        name: step.name,
        durationMs,
        result,
        skipped: false,
        decisionPoint: result.confidence != null,
      });

      // 6 Handle abort / skip_to / continue
      if (result.action === 'continue') {
        // Snapshot output for run_until predicates (§1.4)
        stepOutputs[step.name] = ctx.output != null ? { ...ctx.output } : null;

        // 7 run_until: evaluate predicate after each successful continue (§1.4)
        if (ctx.runUntil != null) {
          const state: PipelineState = {
            stepName: step.name,
            outputs: stepOutputs,
            context: ctx,
          };
          if (ctx.runUntil(state)) {
            trace.totalDurationMs = performance.now() - pipelineStart;
            trace.success = true;
            return [ctx.output ?? null, trace];
          }
        }

        idx += 1;
      } else if (result.action === 'abort') {
        trace.totalDurationMs = performance.now() - pipelineStart;
        trace.success = false;
        throw new PipelineAbortError(
          step.name,
          result.explanation ?? null,
          result.alternatives ?? null,
          trace,
        );
      } else if (result.action === 'skip_to') {
        const target = result.skipTo ?? '';
        // O(1) step index lookup (§1.5)
        const targetIdx = strategy.findStepIndex(target);
        if (targetIdx === undefined || targetIdx <= idx) {
          throw new StepNotFoundError(
            `skip_to target '${target}' not found after step '${step.name}'`,
          );
        }
        // Mark skipped steps in trace
        for (let skipIdx = idx + 1; skipIdx < targetIdx; skipIdx++) {
          trace.steps.push({
            name: steps[skipIdx].name,
            durationMs: 0,
            result: { action: 'continue' },
            skipped: true,
            decisionPoint: false,
          });
        }
        idx = targetIdx;
      } else {
        throw new StepNotFoundError(`Unknown step action: '${result.action as string}'`);
      }
    }

    trace.totalDurationMs = performance.now() - pipelineStart;
    trace.success = true;
    return [ctx.output ?? null, trace];
  }
}

/** Raised when a referenced strategy does not exist. */
export class StrategyNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string = '', options?: ErrorOptions) {
    super(
      'STRATEGY_NOT_FOUND',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'StrategyNotFoundError';
  }
}
