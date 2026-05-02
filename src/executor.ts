/**
 * Executor and related utilities for apcore.
 *
 * Async-only execution pipeline. Python's call() + call_async() merge into one async call().
 * Timeout uses Promise.race instead of threading.
 */

import type { ACL } from './acl.js';
import type { ApprovalHandler } from './approval.js';
import type { Config } from './config.js';
import { Context } from './context.js';
import { ExecutionCancelledError } from './cancel.js';
import {
  InvalidInputError,
  ModuleError,
  ModuleTimeoutError,
} from './errors.js';
import { AfterMiddleware, BeforeMiddleware, Middleware, RetrySignal } from './middleware/index.js';
import { MiddlewareChainError, MiddlewareManager } from './middleware/manager.js';
import type { Module, ModuleAnnotations, PreflightCheckResult, PreflightResult } from './module.js';
import { createPreflightResult } from './module.js';
import { MODULE_ID_PATTERN } from './registry/registry.js';
import type { Registry } from './registry/registry.js';
import type { PipelineContext, PipelineTrace, StrategyInfo } from './pipeline.js';
import { ExecutionStrategy, PipelineEngine, PipelineAbortError, PipelineStepError, StrategyNotFoundError } from './pipeline.js';
import {
  BuiltinACLCheck,
  BuiltinApprovalGate,
  buildStandardStrategy,
  buildInternalStrategy,
  buildTestingStrategy,
  buildPerformanceStrategy,
  buildMinimalStrategy,
} from './builtin-steps.js';
import type { StandardStrategyDeps } from './builtin-steps.js';
import type { ToggleState } from './sys-modules/toggle.js';
import { propagateError } from './utils/error-propagation.js';

export const REDACTED_VALUE: string = '***REDACTED***';

/** Well-known context.data keys used internally by the runtime. */
export const CTX_GLOBAL_DEADLINE = '_apcore.executor.global_deadline';
export const CTX_TRACING_SPANS = '_apcore.mw.tracing.spans';

export function redactSensitive(
  data: Record<string, unknown>,
  schemaDict: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = JSON.parse(JSON.stringify(data));
  redactFields(redacted, schemaDict);
  redactSecretPrefix(redacted);
  return redacted;
}

function redactFields(data: Record<string, unknown>, schemaDict: Record<string, unknown>): void {
  const properties = schemaDict['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return;

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!(fieldName in data)) continue;
    const value = data[fieldName];

    if (fieldSchema['x-sensitive'] === true) {
      if (value !== null && value !== undefined) {
        data[fieldName] = REDACTED_VALUE;
      }
      continue;
    }

    if (fieldSchema['type'] === 'object' && 'properties' in fieldSchema && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      redactFields(value as Record<string, unknown>, fieldSchema);
      continue;
    }

    if (fieldSchema['type'] === 'array' && 'items' in fieldSchema && Array.isArray(value)) {
      const itemsSchema = fieldSchema['items'] as Record<string, unknown>;
      if (itemsSchema['x-sensitive'] === true) {
        for (let i = 0; i < value.length; i++) {
          if (value[i] !== null && value[i] !== undefined) {
            value[i] = REDACTED_VALUE;
          }
        }
      } else if (itemsSchema['type'] === 'object' && 'properties' in itemsSchema) {
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            redactFields(item as Record<string, unknown>, itemsSchema);
          }
        }
      }
    }
  }
}

function redactSecretPrefix(data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (key.startsWith('_secret_') && value !== null && value !== undefined) {
      data[key] = REDACTED_VALUE;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      redactSecretPrefix(value as Record<string, unknown>);
    }
  }
}

const MAX_MERGE_DEPTH = 32;

export function deepMergeChunk(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  depth = 0,
): void {
  if (depth >= MAX_MERGE_DEPTH) return;
  for (const [key, value] of Object.entries(overlay)) {
    if (
      key in base &&
      base[key] != null &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key]) &&
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      deepMergeChunk(
        base[key] as Record<string, unknown>,
        value as Record<string, unknown>,
        depth + 1,
      );
    } else {
      base[key] = value;
    }
  }
}

export class Executor {
  private _registry: Registry;
  private _middlewareManager: MiddlewareManager;
  private _acl: ACL | null;
  private _config: Config | null;
  private _approvalHandler: ApprovalHandler | null;
  private _toggleState: ToggleState | null;
  private _strategy: ExecutionStrategy;
  private _pipelineEngine: PipelineEngine;

  /** Global strategy registry for name-based resolution. */
  private static _strategyRegistry = new Map<string, ExecutionStrategy>();

  constructor(options: {
    registry: Registry;
    strategy?: ExecutionStrategy | string | null;
    middlewares?: Middleware[] | null;
    acl?: ACL | null;
    config?: Config | null;
    approvalHandler?: ApprovalHandler | null;
    toggleState?: ToggleState | null;
  }) {
    this._registry = options.registry;
    this._middlewareManager = new MiddlewareManager();
    this._acl = options.acl ?? null;
    this._config = options.config ?? null;
    this._approvalHandler = options.approvalHandler ?? null;
    this._toggleState = options.toggleState ?? null;

    if (options.middlewares) {
      for (const mw of options.middlewares) {
        this._middlewareManager.add(mw);
      }
    }

    // Resolve strategy option (default to standard)
    const strategyOpt = options.strategy;
    if (strategyOpt === undefined || strategyOpt === null) {
      // Default to standard strategy (pipeline-first)
      this._strategy = buildStandardStrategy(this._buildStrategyDeps());
    } else if (typeof strategyOpt === 'string') {
      // Resolve by name from the global registry
      const resolved = Executor._strategyRegistry.get(strategyOpt);
      if (resolved === undefined) {
        // Try built-in factory names
        const deps = this._buildStrategyDeps();
        const builtinFactories: Record<string, (d: StandardStrategyDeps) => ExecutionStrategy> = {
          standard: buildStandardStrategy,
          internal: buildInternalStrategy,
          testing: buildTestingStrategy,
          performance: buildPerformanceStrategy,
          minimal: buildMinimalStrategy,
        };
        const factory = builtinFactories[strategyOpt];
        if (factory !== undefined) {
          this._strategy = factory(deps);
        } else {
          throw new StrategyNotFoundError(`Strategy '${strategyOpt}' not found in registry`);
        }
      } else {
        this._strategy = resolved;
      }
    } else {
      // ExecutionStrategy instance
      this._strategy = strategyOpt;
    }

    this._pipelineEngine = new PipelineEngine();
  }

  /** Build the dependency bag for strategy factories. */
  private _buildStrategyDeps(): StandardStrategyDeps {
    return {
      config: this._config,
      registry: this._registry,
      acl: this._acl,
      approvalHandler: this._approvalHandler,
      middlewareManager: this._middlewareManager,
      toggleState: this._toggleState,
    };
  }

  // -----------------------------------------------------------------------
  // Static strategy registry (introspection - Task 4)
  // -----------------------------------------------------------------------

  /** Register a named strategy in the global registry. */
  static registerStrategy(name: string, strategy: ExecutionStrategy): void {
    Executor._strategyRegistry.set(name, strategy);
  }

  /** List info for all registered strategies. */
  static listStrategies(): StrategyInfo[] {
    return [...Executor._strategyRegistry.values()].map(s => s.info());
  }

  /** Describe the pipeline of the executor's current strategy. */
  describePipeline(): StrategyInfo {
    return this._strategy.info();
  }

  /** Get the current execution strategy. */
  get currentStrategy(): ExecutionStrategy {
    return this._strategy;
  }

  static fromRegistry(
    registry: Registry,
    middlewares?: Middleware[] | null,
    acl?: ACL | null,
    config?: Config | null,
    approvalHandler?: ApprovalHandler | null,
  ): Executor {
    return new Executor({ registry, middlewares, acl, config, approvalHandler });
  }

  get registry(): Registry {
    return this._registry;
  }

  get middlewares(): Middleware[] {
    return this._middlewareManager.snapshot();
  }

  /** Set the access control provider. Updates both the executor field and the strategy's ACL step. */
  setAcl(acl: ACL): void {
    this._acl = acl;
    let found = false;
    for (const step of this._strategy.steps) {
      if (step.name === 'acl_check' && step instanceof BuiltinACLCheck) {
        step.setAcl(acl);
        found = true;
        break;
      }
    }
    if (!found) {
      console.warn(
        '[apcore:executor] setAcl() called but current strategy has no BuiltinACLCheck step — ACL will not be enforced',
      );
    }
  }

  /** Set the approval handler. Updates both the executor field and the strategy's approval step. */
  setApprovalHandler(handler: ApprovalHandler): void {
    this._approvalHandler = handler;
    let found = false;
    for (const step of this._strategy.steps) {
      if (step.name === 'approval_gate' && step instanceof BuiltinApprovalGate) {
        step.setApprovalHandler(handler);
        found = true;
        break;
      }
    }
    if (!found) {
      console.warn(
        '[apcore:executor] setApprovalHandler() called but current strategy has no BuiltinApprovalGate step — approval will not be enforced',
      );
    }
  }

  use(middleware: Middleware): Executor {
    this._middlewareManager.add(middleware);
    return this;
  }

  useBefore(callback: (moduleId: string, inputs: Record<string, unknown>, context: Context) => Record<string, unknown> | null): Executor {
    this._middlewareManager.add(new BeforeMiddleware(callback));
    return this;
  }

  useAfter(callback: (moduleId: string, inputs: Record<string, unknown>, output: Record<string, unknown>, context: Context) => Record<string, unknown> | null): Executor {
    this._middlewareManager.add(new AfterMiddleware(callback));
    return this;
  }

  remove(middleware: Middleware): boolean {
    return this._middlewareManager.remove(middleware);
  }

  async call(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    versionHint?: string | null,
  ): Promise<Record<string, unknown>> {
    this._validateModuleId(moduleId);

    const ctx = context != null ? context : Context.create(this);
    const pipeCtx: PipelineContext = {
      moduleId,
      inputs: inputs ?? {},
      context: ctx,
      module: null,
      validatedInputs: null,
      output: null,
      validatedOutput: null,
      stream: false,
      outputStream: null,
      strategy: this._strategy,
      trace: null,
      versionHint: versionHint ?? null,
    };

    // Loop iterates only when a RetrySignal is returned from middleware
    // onError; every other path returns or throws on the first attempt
    // (sync finding A-D-017).
    while (true) {
      try {
        const [output, _trace] = await this._pipelineEngine.run(this._strategy, pipeCtx);
        return (output ?? {}) as Record<string, unknown>;
      } catch (exc) {
        if (exc instanceof ExecutionCancelledError) throw exc;
        // PipelineStepError is the engine-level contract (§1.1). Unwrap the cause
        // so the executor's public API surfaces the original typed error.
        const unwrapped = exc instanceof PipelineStepError
          ? (exc.cause instanceof Error ? exc.cause : exc)
          : exc;
        // MiddlewareChainError wraps the original; unwrap it so callers see the
        // real error class/code instead of a generic MODULE_EXECUTE_ERROR.
        const ctxObj = pipeCtx.context;
        const underlying = unwrapped instanceof MiddlewareChainError
          ? unwrapped.original
          : (unwrapped as Error);
        const wrapped = propagateError(underlying, moduleId, ctxObj);
        const executedMw = pipeCtx.executedMiddlewares;
        if (executedMw && executedMw.length > 0) {
          const recovery = await this._middlewareManager.executeOnError(
            moduleId, pipeCtx.inputs, wrapped as Error, ctxObj, executedMw as Middleware[],
          );
          if (recovery instanceof RetrySignal) {
            this._resetPipeCtxForRetry(pipeCtx, recovery.inputs);
            continue;
          }
          if (recovery !== null) return recovery;
        }
        throw wrapped;
      }
    }
  }

  /**
   * Reset PipelineContext for another attempt triggered by a RetrySignal.
   *
   * Preserves the top-level Context (so retry counters in context.data carry
   * across attempts) while clearing per-run fields that the next attempt
   * will re-populate. (sync finding A-D-017)
   */
  private _resetPipeCtxForRetry(
    pipeCtx: PipelineContext,
    newInputs: Record<string, unknown>,
  ): void {
    pipeCtx.inputs = newInputs;
    pipeCtx.validatedInputs = null;
    pipeCtx.module = null;
    pipeCtx.output = null;
    pipeCtx.validatedOutput = null;
    pipeCtx.executedMiddlewares = [];
  }

  /**
   * Alias for call(). Provided for compatibility with MCP bridge packages
   * that may call callAsync() by convention.
   */
  async callAsync(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    versionHint?: string | null,
  ): Promise<Record<string, unknown>> {
    return this.call(moduleId, inputs, context, versionHint);
  }

  /**
   * Execute a module through the pipeline strategy and return both the output
   * and a full execution trace. Requires a strategy to be set (either on the
   * executor or passed via options).
   */
  async callWithTrace(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    options?: { strategy?: ExecutionStrategy | null } | null,
  ): Promise<[Record<string, unknown>, PipelineTrace]> {
    const strategy = options?.strategy ?? this._strategy;

    const ctx = context ?? Context.create(this);
    const pipelineCtx: PipelineContext = {
      moduleId,
      inputs: inputs ?? {},
      context: ctx,
      module: null,
      validatedInputs: null,
      output: null,
      validatedOutput: null,
      stream: false,
      outputStream: null,
      strategy,
      trace: null,
    };

    try {
      const [output, trace] = await this._pipelineEngine.run(strategy, pipelineCtx);
      return [(output ?? {}) as Record<string, unknown>, trace];
    } catch (exc) {
      // Unwrap PipelineStepError so callers see the original typed cause, consistent
      // with call() behaviour (§1.1 engine-level contract vs public API surface).
      if (exc instanceof PipelineStepError && exc.cause instanceof Error) {
        throw exc.cause;
      }
      throw exc;
    }
  }

  /**
   * Streaming execution pipeline. If the module exposes a stream() async generator,
   * yields each chunk. Otherwise falls back to call() and yields a single chunk.
   *
   * Pipeline: context -> safety -> lookup -> ACL -> validate inputs -> before-middleware
   *   -> stream (or fallback to execute) -> validate accumulated output -> after-middleware
   *
   * Note: In the streaming path, after-middleware runs on the accumulated output for
   * validation/side-effects but its return value is not yielded since chunks were already
   * emitted. In the non-streaming fallback, after-middleware can transform the output.
   */
  /**
   * Streaming execution pipeline using split-pipeline design.
   *
   * Phase 1: Pipeline runs all steps with ctx.stream=true. BuiltinExecute detects
   *   stream mode and sets ctx.outputStream if module has stream().
   * Phase 2: Iterate stream, accumulate chunks and yield each.
   * Phase 3: Run output_validation + middleware_after on accumulated output.
   *
   * If the module has no stream(), the pipeline executes normally and yields ctx.output.
   */
  async *stream(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    versionHint?: string | null,
  ): AsyncGenerator<Record<string, unknown>> {
    this._validateModuleId(moduleId);

    const ctx = context != null ? context : Context.create(this);
    const pipeCtx: PipelineContext = {
      moduleId,
      inputs: inputs ?? {},
      context: ctx,
      module: null,
      validatedInputs: null,
      output: null,
      validatedOutput: null,
      stream: true,
      outputStream: null,
      strategy: this._strategy,
      trace: null,
      versionHint: versionHint ?? null,
    };

    // Phase 1: Run the full pipeline. BuiltinExecute detects ctx.stream=true.
    try {
      await this._pipelineEngine.run(this._strategy, pipeCtx);
    } catch (exc) {
      if (exc instanceof ExecutionCancelledError) throw exc;
      const ctxObj = pipeCtx.context;
      // Unwrap PipelineStepError to expose the original typed cause (§1.1).
      const unwrapped = exc instanceof PipelineStepError
        ? (exc.cause instanceof Error ? exc.cause : exc)
        : exc;
      const wrapped = propagateError(unwrapped as Error, moduleId, ctxObj);
      if (pipeCtx.executedMiddlewares && pipeCtx.executedMiddlewares.length > 0) {
        const recovery = await this._middlewareManager.executeOnError(
          moduleId, pipeCtx.inputs, wrapped as Error, ctxObj, pipeCtx.executedMiddlewares as Middleware[],
        );
        // RetrySignal is not supported in stream mode — re-running a stream
        // mid-flight is not well-defined. Fall through to throwing the wrapped
        // error so the caller sees a normal failure (sync finding A-D-017).
        if (recovery !== null && !(recovery instanceof RetrySignal)) {
          yield recovery;
          return;
        }
      }
      throw wrapped;
    }

    // If no outputStream, pipeline already executed normally — yield single result
    if (pipeCtx.outputStream == null) {
      yield (pipeCtx.output ?? {}) as Record<string, unknown>;
      return;
    }

    // Phase 2: Iterate stream, accumulate chunks
    const outputStream = pipeCtx.outputStream as AsyncGenerator<Record<string, unknown>>;
    const accumulated: Record<string, unknown> = {};
    // Read the canonical deadline slot written by BuiltinContextCreation
    // (ms-since-epoch). The earlier `pipeCtx.context.globalDeadline` read was
    // always null in the executor pipeline path because that field is a
    // separate context attribute that the pipeline never populates — and the
    // subsequent `Date.now() / 1000` divisor pretended the value was epoch
    // seconds. (sync finding A-D-202.)
    const globalDeadline =
      (pipeCtx.context?.data?.[CTX_GLOBAL_DEADLINE] as number | undefined) ?? null;
    try {
      for await (const chunk of outputStream) {
        // Enforce global_deadline between chunks — matches apcore-python
        // executor.py:872-879 (sync finding A-D-014). The slot is stored as
        // ms-since-epoch (Date.now() + globalTimeout in BuiltinContextCreation),
        // so compare against Date.now() directly.
        if (globalDeadline !== null && Date.now() > globalDeadline) {
          throw new ModuleTimeoutError(moduleId, 0);
        }
        deepMergeChunk(accumulated, chunk as Record<string, unknown>);
        yield chunk;
      }
    } catch (exc) {
      if (exc instanceof ExecutionCancelledError) throw exc;
      const ctxObj = pipeCtx.context;
      const wrapped = propagateError(exc as Error, moduleId, ctxObj);
      if (pipeCtx.executedMiddlewares && pipeCtx.executedMiddlewares.length > 0) {
        const recovery = await this._middlewareManager.executeOnError(
          moduleId, pipeCtx.inputs, wrapped as Error, ctxObj, pipeCtx.executedMiddlewares as Middleware[],
        );
        // RetrySignal not supported mid-stream (sync finding A-D-017).
        if (recovery !== null && !(recovery instanceof RetrySignal)) {
          yield recovery;
          return;
        }
      }
      throw wrapped;
    }

    // Phase 3: Output validation + middleware_after on accumulated result
    pipeCtx.output = accumulated;
    const postSteps = this._strategy.steps.filter(
      (s) => s.name === 'output_validation' || s.name === 'middleware_after' || s.name === 'return_result',
    );
    if (postSteps.length > 0) {
      const postStrategy = new ExecutionStrategy('post_stream', postSteps);
      try {
        await this._pipelineEngine.run(postStrategy, pipeCtx);
      } catch (exc) {
        if (exc instanceof ExecutionCancelledError) throw exc;
        // Chunks are already delivered to the caller and cannot be recalled.
        // Swallow the phase-3 error and log a warning — matches apcore-python
        // executor.py:920 which emits an ApCoreEvent("apcore.stream.post_validation_failed")
        // and does NOT re-raise (sync finding A-D-012).
        // TODO: emit ApCoreEvent via injected EventEmitter when Executor gains
        // an optional eventEmitter constructor field (pending architectural wiring).
        const ctxObj = pipeCtx.context;
        const unwrappedPost = exc instanceof PipelineStepError
          ? (exc.cause instanceof Error ? exc.cause : exc)
          : exc;
        const wrapped = propagateError(unwrappedPost as Error, moduleId, ctxObj);
        console.warn(
          `[apcore:executor] stream phase-3 failure for '${moduleId}' (chunks already delivered): ${wrapped.message}`,
        );
        if (pipeCtx.executedMiddlewares && pipeCtx.executedMiddlewares.length > 0) {
          await this._middlewareManager.executeOnError(
            moduleId,
            pipeCtx.inputs,
            wrapped as Error,
            ctxObj,
            pipeCtx.executedMiddlewares as Middleware[],
          );
        }
        // Do not rethrow — phase-3 errors are swallowed per spec.
      }
    }
  }

  /**
   * Non-destructive preflight check using pipeline dry_run mode.
   *
   * Runs all pure steps (context creation, call chain guard, module lookup,
   * ACL, input validation). Steps with pure=false (approval, middleware,
   * execute) are automatically skipped. Returns a PreflightResult.
   */
  async validate(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
  ): Promise<PreflightResult> {
    const effectiveInputs = inputs ?? {};
    const checks: PreflightCheckResult[] = [];

    // Check 0: module_id format (before pipeline)
    if (!MODULE_ID_PATTERN.test(moduleId)) {
      checks.push({
        check: 'module_id', passed: false,
        error: { code: 'INVALID_INPUT', message: `Invalid module ID: "${moduleId}"` },
      });
      return createPreflightResult(checks);
    }
    checks.push({ check: 'module_id', passed: true });

    // Run pipeline in dry_run mode — pure=false steps are skipped
    const pipeCtx: PipelineContext = {
      moduleId,
      inputs: effectiveInputs,
      context: context ?? Context.create(this),
      module: null,
      validatedInputs: null,
      output: null,
      validatedOutput: null,
      stream: false,
      outputStream: null,
      strategy: this._strategy,
      trace: null,
      dryRun: true,
    };

    let trace: PipelineTrace | null = null;
    try {
      const [, t] = await this._pipelineEngine.run(this._strategy, pipeCtx);
      trace = t;
    } catch (e) {
      // Step raised a domain error (ModuleNotFoundError, ACLDeniedError, etc.)
      if (e instanceof PipelineAbortError) {
        trace = e.pipelineTrace;
      } else {
        // Unwrap PipelineStepError to expose the original typed cause (§1.1).
        const underlying = e instanceof PipelineStepError
          ? (e.cause instanceof Error ? e.cause : e)
          : e;
        const errorDict = (underlying instanceof ModuleError)
          ? { code: underlying.code, message: underlying.message }
          : { code: (underlying as Error).constructor?.name ?? 'Error', message: String(underlying) };
        const code = (underlying instanceof ModuleError) ? underlying.code : (underlying as Error).constructor?.name ?? 'Error';

        let checkName: string;
        if (code === 'MODULE_NOT_FOUND') checkName = 'module_lookup';
        else if (code === 'ACL_DENIED') checkName = 'acl';
        else if (code === 'SCHEMA_VALIDATION_ERROR' || code === 'INVALID_INPUT') checkName = 'schema';
        else if (code === 'CALL_DEPTH_EXCEEDED' || code === 'CIRCULAR_CALL' || code === 'CALL_FREQUENCY_EXCEEDED') checkName = 'call_chain';
        else checkName = 'unknown';

        checks.push({ check: checkName, passed: false, error: errorDict });
      }
    }

    // Convert pipeline trace to PreflightResult checks
    if (trace !== null) {
      checks.push(...this._traceToChecks(trace));
    }

    // Detect requires_approval
    let requiresApproval = false;
    if (pipeCtx.module != null) {
      requiresApproval = this._needsApproval(pipeCtx.module as Record<string, unknown>);
    }

    // Module-level preflight (optional)
    if (pipeCtx.module != null) {
      const mod = pipeCtx.module as Record<string, unknown>;
      const modWithPreflight = mod as { preflight?: Module['preflight'] };
      if (typeof modWithPreflight.preflight === 'function') {
        try {
          const preflightWarnings = modWithPreflight.preflight(effectiveInputs, pipeCtx.context);
          if (Array.isArray(preflightWarnings) && preflightWarnings.length > 0) {
            checks.push({ check: 'module_preflight', passed: true, warnings: preflightWarnings });
          } else {
            checks.push({ check: 'module_preflight', passed: true });
          }
        } catch (exc: unknown) {
          const excName = exc instanceof Error ? exc.constructor.name : 'Error';
          const excMsg = exc instanceof Error ? exc.message : String(exc);
          checks.push({
            check: 'module_preflight',
            passed: true,
            warnings: [`preflight() raised ${excName}: ${excMsg}`],
          });
        }
      }
    }

    return createPreflightResult(checks, requiresApproval);
  }

  /** Map pipeline step names to PreflightResult check names. */
  private static readonly _STEP_TO_CHECK: Record<string, string> = {
    context_creation: 'context',
    call_chain_guard: 'call_chain',
    module_lookup: 'module_lookup',
    acl_check: 'acl',
    approval_gate: 'approval',
    middleware_before: 'middleware',
    input_validation: 'schema',
  };

  /** Convert PipelineTrace steps to PreflightCheckResult list. */
  private _traceToChecks(trace: PipelineTrace): PreflightCheckResult[] {
    const checks: PreflightCheckResult[] = [];
    for (const st of trace.steps) {
      if (st.skipped) continue;
      const checkName = Executor._STEP_TO_CHECK[st.name] ?? st.name;
      const passed = st.result.action !== 'abort';
      let error: Record<string, unknown> | undefined;
      if (!passed && st.result.explanation) {
        error = { code: `STEP_${st.name.toUpperCase()}_FAILED`, message: st.result.explanation };
      }
      checks.push({ check: checkName, passed, error });
    }
    return checks;
  }

  /** Validate module_id format at public entry points. */
  private _validateModuleId(moduleId: string): void {
    if (!moduleId || !MODULE_ID_PATTERN.test(moduleId)) {
      throw new InvalidInputError(
        `Invalid module ID: '${moduleId}'. Must match pattern: ${MODULE_ID_PATTERN.source}`,
      );
    }
  }

  /** Check if a module requires approval, handling both interface and dict annotations. */
  private _needsApproval(mod: Record<string, unknown>): boolean {
    const annotations = mod['annotations'];
    if (annotations == null) return false;
    if (typeof annotations !== 'object') return false;
    if ('requiresApproval' in annotations) {
      return Boolean((annotations as ModuleAnnotations).requiresApproval);
    }
    if ('requires_approval' in annotations) {
      return Boolean((annotations as Record<string, unknown>)['requires_approval']);
    }
    return false;
  }
}
