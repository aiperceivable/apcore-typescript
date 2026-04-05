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

  constructor(name: string, steps: Step[]) {
    this.name = name;
    this._steps = [...steps];
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
  }

  get steps(): readonly Step[] {
    return this._steps;
  }

  /** Insert a step after the named anchor step. */
  insertAfter(anchor: string, step: Step): void {
    if (this._steps.some((s) => s.name === step.name)) {
      throw new StepNameDuplicateError(`Step '${step.name}' already exists`);
    }
    for (let i = 0; i < this._steps.length; i++) {
      if (this._steps[i].name === anchor) {
        this._steps.splice(i + 1, 0, step);
        return;
      }
    }
    throw new StepNotFoundError(`Anchor step '${anchor}' not found`);
  }

  /** Insert a step before the named anchor step. */
  insertBefore(anchor: string, step: Step): void {
    if (this._steps.some((s) => s.name === step.name)) {
      throw new StepNameDuplicateError(`Step '${step.name}' already exists`);
    }
    for (let i = 0; i < this._steps.length; i++) {
      if (this._steps[i].name === anchor) {
        this._steps.splice(i, 0, step);
        return;
      }
    }
    throw new StepNotFoundError(`Anchor step '${anchor}' not found`);
  }

  /** Remove a step by name. Raises if the step is not removable. */
  remove(stepName: string): void {
    for (let i = 0; i < this._steps.length; i++) {
      if (this._steps[i].name === stepName) {
        if (!this._steps[i].removable) {
          throw new StepNotRemovableError(
            `Step '${stepName}' is not removable`,
          );
        }
        this._steps.splice(i, 1);
        return;
      }
    }
    throw new StepNotFoundError(`Step '${stepName}' not found`);
  }

  /** Replace a step by name. Raises if the step is not replaceable. */
  replace(stepName: string, newStep: Step): void {
    for (let i = 0; i < this._steps.length; i++) {
      if (this._steps[i].name === stepName) {
        if (!this._steps[i].replaceable) {
          throw new StepNotReplaceableError(
            `Step '${stepName}' is not replaceable`,
          );
        }
        this._steps[i] = newStep;
        return;
      }
    }
    throw new StepNotFoundError(`Step '${stepName}' not found`);
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
      description: this.stepNames().join(' \u2192 '),
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
        // Not ignored: record and raise
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
        throw exc;
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

      // ⑥ Handle abort / skip_to
      if (result.action === 'continue') {
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
        const targetIdx = steps.findIndex(
          (s, i) => i > idx && s.name === target,
        );
        if (targetIdx === -1) {
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
