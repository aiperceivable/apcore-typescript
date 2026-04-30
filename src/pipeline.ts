/**
 * Execution pipeline types for configurable step-based module invocation.
 */

import type { Context } from './context.js';
import { ModuleError } from './errors.js';
import type { ErrorOptions } from './errors.js';
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

  /** PipelineContext fields this step reads (e.g. "module", "context"). Advisory only. */
  readonly requires?: readonly string[];
  /** PipelineContext fields this step writes (e.g. "output", "validated_inputs"). Advisory only. */
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

// ---------------------------------------------------------------------------
// ExecutionStrategy
// ---------------------------------------------------------------------------

/** An ordered sequence of steps that defines how a module is executed. */
export class ExecutionStrategy {
  readonly name: string;
  private _steps: Step[];
  private _nameToIdx: Map<string, number>;

  constructor(name: string, steps: Step[]) {
    this.name = name;
    this._steps = [...steps];
    this._nameToIdx = new Map();
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
      throw new StepNameDuplicateError(
        `Duplicate step names: ${[...dupes].join(', ')}`,
      );
    }
    this._rebuildIndex();
    this._validateDependencies();
  }

  /** Rebuild the O(1) name→index map. Call after any mutation (§1.5). */
  private _rebuildIndex(): void {
    this._nameToIdx = new Map(this._steps.map((s, i) => [s.name, i]));
  }

  /** Warn if any step's requires are not provided by a preceding step. */
  private _validateDependencies(): void {
    const provided = new Set<string>();
    for (const step of this._steps) {
      const requires = step.requires ?? [];
      for (const req of requires) {
        if (!provided.has(req)) {
          console.warn(
            `[apcore:pipeline] Step '${step.name}' requires '${req}', but no preceding step provides it. This may cause runtime errors.`,
          );
        }
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
      throw new StepNotRemovableError(
        `Step '${stepName}' is not removable`,
      );
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
      throw new StepNotReplaceableError(
        `Step '${stepName}' is not replaceable`,
      );
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
      throw new StepNotReplaceableError(
        `Step '${stepName}' is not replaceable`,
      );
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
  /** Run every step in the strategy against ctx, respecting flow-control actions (continue, skip_to, abort). */
  async run(
    strategy: ExecutionStrategy,
    ctx: PipelineContext,
  ): Promise<[unknown, PipelineTrace]> {
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

      // ① match_modules filter
      if (stepMatchModules !== null) {
        const matched = stepMatchModules.some((pattern) =>
          matchPattern(pattern, ctx.moduleId),
        );
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

      // ② dry_run filter: skip steps with side effects
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

      // ③ Execute with per-step timeout
      const stepStart = performance.now();
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
        // ④ ignore_errors: log and continue
        if (stepIgnoreErrors) {
          console.warn(
            `[apcore:pipeline] Step '${step.name}' failed (ignored):`,
            exc instanceof Error ? exc.message : String(exc),
          );
          trace.steps.push({
            name: step.name,
            durationMs,
            result: {
              action: 'continue',
              explanation: exc instanceof Error ? exc.message : String(exc),
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
            explanation: exc instanceof Error ? exc.message : String(exc),
          },
          skipped: false,
          decisionPoint: false,
        });
        trace.totalDurationMs = performance.now() - pipelineStart;
        const cause = exc instanceof Error ? exc : new Error(String(exc));
        throw new PipelineStepError(step.name, cause, trace);
      }

      const durationMs = performance.now() - stepStart;

      // ⑤ Record trace
      trace.steps.push({
        name: step.name,
        durationMs,
        result,
        skipped: false,
        decisionPoint: result.confidence != null,
      });

      // ⑥ Handle abort / skip_to / continue
      if (result.action === 'continue') {
        // Snapshot output for run_until predicates (§1.4)
        stepOutputs[step.name] = ctx.output != null ? { ...ctx.output } : null;

        // ⑦ run_until: evaluate predicate after each successful continue (§1.4)
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
        throw new StepNotFoundError(
          `Unknown step action: '${result.action as string}'`,
        );
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
