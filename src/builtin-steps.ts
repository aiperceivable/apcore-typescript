/**
 * Built-in pipeline steps extracted from the executor's hardcoded logic.
 *
 * Each class implements the Step interface and wraps one phase of the
 * execution pipeline.  Dependencies are injected via the constructor so
 * that each step is independently testable.
 */

import type { TSchema } from '@sinclair/typebox';
import { Kind } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ACL } from './acl.js';
import type { ApprovalHandler, ApprovalResult } from './approval.js';
import { createApprovalRequest } from './approval.js';
import type { Config } from './config.js';
import { getDefault } from './config.js';
import { Context } from './context.js';
import {
  ACLDeniedError,
  ApprovalDeniedError,
  ApprovalPendingError,
  ApprovalTimeoutError,
  InvalidInputError,
  ModuleDisabledError,
  ModuleNotFoundError,
  ModuleTimeoutError,
  SchemaValidationError,
} from './errors.js';
import { DEFAULT_TOGGLE_STATE, type ToggleState } from './sys-modules/toggle.js';
import { CTX_GLOBAL_DEADLINE, CTX_TRACING_SPANS, redactSensitive } from './executor.js';
import { MiddlewareChainError, type MiddlewareManager } from './middleware/manager.js';
import type { ModuleAnnotations } from './module.js';
import { DEFAULT_ANNOTATIONS } from './module.js';
import type { PipelineContext, Step, StepResult } from './pipeline.js';
import { ExecutionStrategy } from './pipeline.js';
import type { Registry } from './registry/registry.js';
import { jsonSchemaToTypeBox } from './schema/loader.js';
import { guardCallChain } from './utils/call-chain.js';

// ---------------------------------------------------------------------------
// Helpers (shared with executor, kept minimal)
// ---------------------------------------------------------------------------

function resolveSchema(mod: Record<string, unknown>, key: string): TSchema | null {
  const schema = mod[key] as TSchema | undefined;
  if (schema == null) return null;
  if (Kind in schema) return schema;
  const converted = jsonSchemaToTypeBox(schema as unknown as Record<string, unknown>);
  mod[key] = converted;
  return converted;
}

function validateSchema(schema: TSchema, data: Record<string, unknown>, direction: string): void {
  if (Value.Check(schema, data)) return;
  const errors: Array<Record<string, unknown>> = [];
  for (const error of Value.Errors(schema, data)) {
    errors.push({
      field: error.path || '/',
      code: String(error.type),
      message: error.message,
    });
  }
  throw new SchemaValidationError(`${direction} validation failed`, errors);
}

function needsApproval(mod: Record<string, unknown>): boolean {
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

function dictToAnnotations(dict: Record<string, unknown>): ModuleAnnotations {
  return {
    readonly: Boolean(dict['readonly'] ?? false),
    destructive: Boolean(dict['destructive'] ?? false),
    idempotent: Boolean(dict['idempotent'] ?? false),
    requiresApproval: Boolean(dict['requiresApproval'] ?? dict['requires_approval'] ?? false),
    openWorld: Boolean(dict['openWorld'] ?? dict['open_world'] ?? true),
    streaming: Boolean(dict['streaming'] ?? false),
    cacheable: Boolean(dict['cacheable'] ?? false),
    cacheTtl: Number(dict['cacheTtl'] ?? dict['cache_ttl'] ?? 0),
    cacheKeyFields: (dict['cacheKeyFields'] ?? dict['cache_key_fields'] ?? null) as string[] | null,
    paginated: Boolean(dict['paginated'] ?? false),
    paginationStyle: (dict['paginationStyle'] ?? dict['pagination_style'] ?? 'cursor') as string,
    extra: Object.freeze((dict['extra'] as Record<string, unknown>) ?? {}),
  };
}

// ---------------------------------------------------------------------------
// 1. BuiltinContextCreation
// ---------------------------------------------------------------------------

/** Creates or inherits execution Context and sets the global deadline. */
export class BuiltinContextCreation implements Step {
  readonly name = 'context_creation';
  readonly description = 'Create or inherit execution context and set global deadline';
  readonly removable = false;
  readonly replaceable = false;
  readonly pure = true;
  readonly provides = ['context'] as const;

  private _globalTimeout: number;

  constructor(config: Config | null) {
    if (config !== null) {
      this._globalTimeout =
        (config.get('executor.global_timeout') as number) ??
        (getDefault('executor.global_timeout') as number);
    } else {
      this._globalTimeout = getDefault('executor.global_timeout') as number;
    }
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    // If no context provided, create a fresh one
    if (ctx.context == null) {
      ctx.context = Context.create(null).child(ctx.moduleId);
    }

    // Set global deadline on root call only
    if (!(CTX_GLOBAL_DEADLINE in ctx.context.data) && this._globalTimeout > 0) {
      ctx.context.data[CTX_GLOBAL_DEADLINE] = Date.now() + this._globalTimeout;
    }

    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 2. BuiltinCallChainGuard
// ---------------------------------------------------------------------------

/** Validates call chain depth, repeat limits, and cancel token. */
export class BuiltinCallChainGuard implements Step {
  readonly name = 'call_chain_guard';
  readonly description = 'Call chain guard: depth, repeat limits, cancel token';
  readonly removable = true;
  readonly replaceable = true;
  readonly pure = true;
  readonly requires = ['context'] as const;

  private _maxCallDepth: number;
  private _maxModuleRepeat: number;

  constructor(config: Config | null) {
    if (config !== null) {
      this._maxCallDepth =
        (config.get('executor.max_call_depth') as number) ??
        (getDefault('executor.max_call_depth') as number);
      this._maxModuleRepeat =
        (config.get('executor.max_module_repeat') as number) ??
        (getDefault('executor.max_module_repeat') as number);
    } else {
      this._maxCallDepth = getDefault('executor.max_call_depth') as number;
      this._maxModuleRepeat = getDefault('executor.max_module_repeat') as number;
    }
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    // Check cancel token first — throw directly for error type preservation
    if (ctx.context.cancelToken !== null) {
      ctx.context.cancelToken.check();
    }

    // Call chain safety guard — throws CallDepthExceededError, CircularCallError, etc.
    guardCallChain(ctx.moduleId, ctx.context.callChain, this._maxCallDepth, this._maxModuleRepeat);

    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 3. BuiltinModuleLookup
// ---------------------------------------------------------------------------

/** Resolves the module from the registry and sets ctx.module. */
export class BuiltinModuleLookup implements Step {
  readonly name = 'module_lookup';
  readonly description = 'Resolve module from registry';
  readonly removable = false;
  readonly replaceable = false;
  readonly pure = true;
  readonly provides = ['module'] as const;

  private _registry: Registry;

  constructor(registry: Registry) {
    this._registry = registry;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const mod = this._registry.get(ctx.moduleId);
    if (mod === null) {
      throw new ModuleNotFoundError(ctx.moduleId);
    }
    ctx.module = mod;

    // Early input redaction: set context.redactedInputs BEFORE middleware
    // runs (step 6). This ensures logging middleware sees redacted data.
    if (ctx.context != null) {
      const inputSchema = resolveSchema(mod as Record<string, unknown>, 'inputSchema');
      if (inputSchema != null) {
        ctx.context.redactedInputs = redactSensitive(
          ctx.inputs,
          inputSchema as unknown as Record<string, unknown>,
        );
      } else {
        ctx.context.redactedInputs = { ...ctx.inputs };
      }
    }

    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 4. BuiltinToggleGate
// ---------------------------------------------------------------------------

/** Blocks execution if the module has been disabled via the toggle system. */
export class BuiltinToggleGate implements Step {
  readonly name = 'toggle_gate';
  readonly description = 'Block disabled modules before ACL and execution';
  readonly removable = true;
  readonly replaceable = true;
  readonly pure = true;
  readonly requires = ['context', 'module'] as const;

  private readonly _toggleState: ToggleState;

  constructor(toggleState?: ToggleState) {
    this._toggleState = toggleState ?? DEFAULT_TOGGLE_STATE;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    if (this._toggleState.isDisabled(ctx.moduleId)) {
      throw new ModuleDisabledError(ctx.moduleId);
    }
    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 6. BuiltinACLCheck
// ---------------------------------------------------------------------------

/** Enforces access control via the ACL provider. */
export class BuiltinACLCheck implements Step {
  readonly name = 'acl_check';
  readonly description = 'Access control list enforcement';
  readonly removable = true;
  readonly replaceable = true;
  readonly requires = ['context', 'module'] as const;
  readonly pure = true;

  private _acl: ACL | null;

  constructor(acl: ACL | null) {
    this._acl = acl;
  }

  /** Update the ACL provider at runtime. */
  setAcl(acl: ACL): void {
    this._acl = acl;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    if (this._acl === null) {
      return { action: 'continue' };
    }
    const allowed = this._acl.check(ctx.context.callerId, ctx.moduleId, ctx.context);
    if (!allowed) {
      throw new ACLDeniedError(ctx.context.callerId, ctx.moduleId);
    }
    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 7. BuiltinApprovalGate
// ---------------------------------------------------------------------------

/** Handles approval flow for modules that require explicit approval. */
export class BuiltinApprovalGate implements Step {
  readonly name = 'approval_gate';
  readonly description = 'Approval handler flow';
  readonly removable = true;
  readonly replaceable = true;
  readonly requires = ['context', 'module'] as const;
  readonly pure = false;

  private _handler: ApprovalHandler | null;

  constructor(handler: ApprovalHandler | null) {
    this._handler = handler;
  }

  /** Update the approval handler at runtime. */
  setApprovalHandler(handler: ApprovalHandler): void {
    this._handler = handler;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    if (this._handler === null) {
      return { action: 'continue' };
    }

    const mod = ctx.module as Record<string, unknown>;
    if (!needsApproval(mod)) {
      return { action: 'continue' };
    }

    let result: ApprovalResult;
    let cleanInputs = ctx.inputs;

    if ('_approval_token' in ctx.inputs) {
      const token = ctx.inputs['_approval_token'] as string;
      const { _approval_token: _, ...rest } = ctx.inputs;
      cleanInputs = rest;
      result = await this._handler.checkApproval(token);
    } else {
      const annotations = mod['annotations'];
      let ann: ModuleAnnotations;
      if (
        annotations != null &&
        typeof annotations === 'object' &&
        'requiresApproval' in annotations
      ) {
        ann = annotations as ModuleAnnotations;
      } else if (annotations != null && typeof annotations === 'object') {
        ann = dictToAnnotations(annotations as Record<string, unknown>);
      } else {
        ann = DEFAULT_ANNOTATIONS;
      }

      const request = createApprovalRequest({
        moduleId: ctx.moduleId,
        arguments: ctx.inputs,
        context: ctx.context,
        annotations: ann,
        description: (mod['description'] as string) ?? null,
        tags: (mod['tags'] as string[]) ?? [],
      });
      result = await this._handler.requestApproval(request);
    }

    // Emit audit event
    const spansStack = ctx.context.data[CTX_TRACING_SPANS] as
      | Array<{ events: Array<Record<string, unknown>> }>
      | undefined;
    if (spansStack && spansStack.length > 0) {
      spansStack[spansStack.length - 1].events.push({
        name: 'approval_decision',
        module_id: ctx.moduleId,
        status: result.status,
        approved_by: result.approvedBy ?? '',
        reason: result.reason ?? '',
        approval_id: result.approvalId ?? '',
      });
    }

    if (result.status === 'approved') {
      ctx.inputs = cleanInputs;
      return { action: 'continue' };
    }

    if (result.status === 'timeout') {
      throw new ApprovalTimeoutError(result, ctx.moduleId);
    }

    if (result.status === 'pending') {
      throw new ApprovalPendingError(result, ctx.moduleId);
    }

    // rejected or unknown
    throw new ApprovalDeniedError(result, ctx.moduleId);
  }
}

// ---------------------------------------------------------------------------
// 8. BuiltinInputValidation
// ---------------------------------------------------------------------------

/** Validates inputs against module schema and redacts sensitive fields. */
export class BuiltinInputValidation implements Step {
  readonly name = 'input_validation';
  readonly description = 'Schema validation and redaction for inputs';
  readonly removable = true;
  readonly replaceable = true;
  readonly pure = true;
  readonly requires = ['module'] as const;
  readonly provides = ['validated_inputs'] as const;

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const mod = ctx.module as Record<string, unknown>;
    const inputSchema = resolveSchema(mod, 'inputSchema');
    if (inputSchema == null) {
      ctx.validatedInputs = ctx.inputs;
      return { action: 'continue' };
    }

    // Throws SchemaValidationError directly for error type preservation
    validateSchema(inputSchema, ctx.inputs, 'Input');

    ctx.context.redactedInputs = redactSensitive(
      ctx.inputs,
      inputSchema as unknown as Record<string, unknown>,
    );
    ctx.validatedInputs = ctx.inputs;
    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 9. BuiltinMiddlewareBefore
// ---------------------------------------------------------------------------

/** Executes before-middleware chain via MiddlewareManager. */
export class BuiltinMiddlewareBefore implements Step {
  readonly name = 'middleware_before';
  readonly description = 'Execute before-middleware chain';
  readonly removable = true;
  readonly replaceable = false;
  readonly pure = false;

  private _middlewareManager: MiddlewareManager;

  constructor(middlewares: MiddlewareManager) {
    this._middlewareManager = middlewares;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    try {
      const [effectiveInputs, executedMiddlewares] = this._middlewareManager.executeBefore(
        ctx.moduleId,
        ctx.inputs,
        ctx.context,
      );
      ctx.inputs = effectiveInputs;
      ctx.executedMiddlewares = executedMiddlewares;
    } catch (e) {
      if (e instanceof MiddlewareChainError) {
        ctx.executedMiddlewares = e.executedMiddlewares;
        // Try on_error recovery
        const recovery = this._middlewareManager.executeOnError(
          ctx.moduleId,
          ctx.inputs,
          e.original,
          ctx.context,
          e.executedMiddlewares,
        );
        if (recovery !== null) {
          ctx.output = recovery;
          return { action: 'skip_to', skipTo: 'return_result' };
        }
        throw e.original;
      }
      throw e;
    }
    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 10. BuiltinExecute
// ---------------------------------------------------------------------------

/** Executes the module with timeout enforcement. Sets ctx.output. */
export class BuiltinExecute implements Step {
  readonly name = 'execute';
  readonly description = 'Execute module with timeout';
  readonly removable = false;
  readonly replaceable = true;
  readonly requires = ['module'] as const;
  readonly provides = ['output'] as const;
  readonly pure = false;

  private _defaultTimeout: number;

  constructor(config: Config | null) {
    if (config !== null) {
      this._defaultTimeout =
        (config.get('executor.default_timeout') as number) ??
        (getDefault('executor.default_timeout') as number);
    } else {
      this._defaultTimeout = getDefault('executor.default_timeout') as number;
    }
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const mod = ctx.module as Record<string, unknown>;

    // Cancel check before execution — throw directly for error type preservation
    if (ctx.context.cancelToken !== null) {
      ctx.context.cancelToken.check();
    }

    // Streaming path: store the generator on ctx.outputStream
    if (ctx.stream) {
      const streamFn = mod['stream'] as
        | ((
            inputs: Record<string, unknown>,
            context: Context,
          ) => AsyncGenerator<Record<string, unknown>>)
        | undefined;
      if (typeof streamFn === 'function') {
        ctx.outputStream = streamFn.call(mod, ctx.inputs, ctx.context);
        return { action: 'continue' };
      }
      // fallback: execute normally and wrap as single-chunk
    }

    // Regular execution with timeout
    let timeoutMs = this._defaultTimeout;
    const globalDeadline = ctx.context.data[CTX_GLOBAL_DEADLINE] as number | undefined;
    if (globalDeadline !== undefined) {
      const remaining = globalDeadline - Date.now();
      if (remaining <= 0) {
        throw new ModuleTimeoutError(ctx.moduleId, 0);
      }
      if (timeoutMs === 0 || remaining < timeoutMs) {
        timeoutMs = remaining;
      }
    }

    const executeFn = mod['execute'];
    if (typeof executeFn !== 'function') {
      throw new InvalidInputError(`Module '${ctx.moduleId}' has no execute method`);
    }

    const executionPromise = Promise.resolve(
      (
        executeFn as (
          inputs: Record<string, unknown>,
          context: Context,
        ) => Promise<Record<string, unknown>> | Record<string, unknown>
      ).call(mod, ctx.inputs, ctx.context),
    );

    if (timeoutMs === 0) {
      ctx.output = await executionPromise;
    } else {
      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ModuleTimeoutError(ctx.moduleId, timeoutMs));
        }, timeoutMs);
      });
      ctx.output = await Promise.race([executionPromise, timeoutPromise]).finally(() => {
        clearTimeout(timer!);
      });
    }

    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 11. BuiltinOutputValidation
// ---------------------------------------------------------------------------

/** Validates output against module schema and redacts sensitive fields. */
export class BuiltinOutputValidation implements Step {
  readonly name = 'output_validation';
  readonly description = 'Schema validation and redaction for output';
  readonly removable = true;
  readonly requires = ['module', 'output'] as const;
  readonly provides = ['validated_output'] as const;
  readonly replaceable = true;
  readonly pure = true;

  async execute(ctx: PipelineContext): Promise<StepResult> {
    // Skip when no output is available: streaming (Phase 3 handles it),
    // dry_run (execute step was skipped), etc.
    if (ctx.output == null) {
      return { action: 'continue' };
    }

    const mod = ctx.module as Record<string, unknown>;
    const output = ctx.output;

    const outputSchema = resolveSchema(mod, 'outputSchema');
    if (outputSchema == null) {
      ctx.validatedOutput = output;
      return { action: 'continue' };
    }

    // Throws SchemaValidationError directly for error type preservation
    validateSchema(outputSchema, output, 'Output');

    ctx.validatedOutput = output;

    // Store redacted output as first-class Context field (symmetric with
    // redactedInputs). Available to middleware.after() and serialize().
    if (ctx.context != null) {
      ctx.context.redactedOutput = redactSensitive(
        output,
        outputSchema as unknown as Record<string, unknown>,
      );
    }

    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 12. BuiltinMiddlewareAfter
// ---------------------------------------------------------------------------

/** Executes after-middleware chain via MiddlewareManager. */
export class BuiltinMiddlewareAfter implements Step {
  readonly name = 'middleware_after';
  readonly description = 'Execute after-middleware chain';
  readonly removable = true;
  readonly replaceable = false;
  readonly pure = false;

  private _middlewareManager: MiddlewareManager;

  constructor(middlewares: MiddlewareManager) {
    this._middlewareManager = middlewares;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    // Skip when no output is available (streaming Phase 1, dry_run, etc.)
    if (ctx.output == null) {
      return { action: 'continue' };
    }

    const output = ctx.output;
    const transformed = this._middlewareManager.executeAfter(
      ctx.moduleId,
      ctx.inputs,
      output,
      ctx.context,
    );
    ctx.output = transformed;
    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// 13. BuiltinReturnResult
// ---------------------------------------------------------------------------

/** Finalizes the pipeline result. Output is already on ctx.output. */
export class BuiltinReturnResult implements Step {
  readonly name = 'return_result';
  readonly description = 'Finalize pipeline result';
  readonly removable = false;
  readonly requires = ['output'] as const;
  readonly replaceable = false;
  readonly pure = true;

  async execute(_ctx: PipelineContext): Promise<StepResult> {
    // No-op: output is already on ctx.output from previous steps
    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// Factory: buildStandardStrategy
// ---------------------------------------------------------------------------

export interface StandardStrategyDeps {
  config: Config | null;
  registry: Registry;
  acl: ACL | null;
  approvalHandler: ApprovalHandler | null;
  middlewareManager: MiddlewareManager;
  toggleState?: ToggleState | null;
}

/** Build the standard 12-step execution strategy matching the current Executor. */
export function buildStandardStrategy(deps: StandardStrategyDeps): ExecutionStrategy {
  return new ExecutionStrategy('standard', [
    new BuiltinContextCreation(deps.config),
    new BuiltinCallChainGuard(deps.config),
    new BuiltinModuleLookup(deps.registry),
    new BuiltinToggleGate(deps.toggleState ?? undefined),
    new BuiltinACLCheck(deps.acl),
    new BuiltinApprovalGate(deps.approvalHandler),
    new BuiltinMiddlewareBefore(deps.middlewareManager),
    new BuiltinInputValidation(),
    new BuiltinExecute(deps.config),
    new BuiltinOutputValidation(),
    new BuiltinMiddlewareAfter(deps.middlewareManager),
    new BuiltinReturnResult(),
  ]);
}

/**
 * Build an internal-only strategy: skips ACL and approval gates.
 * Suitable for trusted internal service-to-service calls.
 */
export function buildInternalStrategy(deps: StandardStrategyDeps): ExecutionStrategy {
  return new ExecutionStrategy('internal', [
    new BuiltinContextCreation(deps.config),
    new BuiltinCallChainGuard(deps.config),
    new BuiltinModuleLookup(deps.registry),
    new BuiltinMiddlewareBefore(deps.middlewareManager),
    new BuiltinInputValidation(),
    new BuiltinExecute(deps.config),
    new BuiltinOutputValidation(),
    new BuiltinMiddlewareAfter(deps.middlewareManager),
    new BuiltinReturnResult(),
  ]);
}

/**
 * Build a testing strategy: standard minus ACL, approval, and call chain guard.
 * Retains middleware and validation for correctness. Fast and predictable for tests.
 */
export function buildTestingStrategy(deps: StandardStrategyDeps): ExecutionStrategy {
  return new ExecutionStrategy('testing', [
    new BuiltinContextCreation(deps.config),
    new BuiltinModuleLookup(deps.registry),
    new BuiltinMiddlewareBefore(deps.middlewareManager),
    new BuiltinInputValidation(),
    new BuiltinExecute(deps.config),
    new BuiltinOutputValidation(),
    new BuiltinMiddlewareAfter(deps.middlewareManager),
    new BuiltinReturnResult(),
  ]);
}

/**
 * Build a performance strategy: skips middleware before/after for reduced overhead.
 * Retains toggle gate, ACL, approval, and validation for correctness.
 */
export function buildPerformanceStrategy(deps: StandardStrategyDeps): ExecutionStrategy {
  return new ExecutionStrategy('performance', [
    new BuiltinContextCreation(deps.config),
    new BuiltinCallChainGuard(deps.config),
    new BuiltinModuleLookup(deps.registry),
    new BuiltinToggleGate(deps.toggleState ?? undefined),
    new BuiltinACLCheck(deps.acl),
    new BuiltinApprovalGate(deps.approvalHandler),
    new BuiltinInputValidation(),
    new BuiltinExecute(deps.config),
    new BuiltinOutputValidation(),
    new BuiltinReturnResult(),
  ]);
}

/**
 * Build a minimal strategy: context → lookup → execute → return only.
 * No safety checks, no ACL, no approval, no validation, no middleware.
 * Suitable for pre-validated internal hot paths. Use with caution.
 */
export function buildMinimalStrategy(deps: StandardStrategyDeps): ExecutionStrategy {
  return new ExecutionStrategy('minimal', [
    new BuiltinContextCreation(deps.config),
    new BuiltinModuleLookup(deps.registry),
    new BuiltinExecute(deps.config),
    new BuiltinReturnResult(),
  ]);
}
