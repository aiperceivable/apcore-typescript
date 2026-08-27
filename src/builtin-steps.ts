/**
 * Built-in pipeline steps extracted from the executor's hardcoded logic.
 *
 * Each class implements the Step interface and wraps one phase of the
 * execution pipeline.  Dependencies are injected via the constructor so
 * that each step is independently testable.
 */

import type { TSchema } from '@sinclair/typebox';
import { Kind } from '@sinclair/typebox';
import type { ACL } from './acl.js';
import type { ApprovalHandler, ApprovalResult } from './approval.js';
import { createApprovalRequest, createApprovalResult } from './approval.js';
import type { Config } from './config.js';
import { getDefault } from './config-defaults.js';
import type { CancelToken } from './cancel.js';
import { ExecutionCancelledError } from './cancel.js';
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
import { type EventEmitter, createEvent } from './events/emitter.js';
import type { ExecutionPolicy, PolicyDecision } from './policy.js';
import { applyDecisionToAnnotations } from './policy.js';
import { MiddlewareChainError, type MiddlewareManager } from './middleware/manager.js';
import type { ModuleAnnotations } from './module.js';
import { DEFAULT_ANNOTATIONS } from './module.js';
import type { PipelineContext, Step, StepResult } from './pipeline.js';
import { ExecutionStrategy } from './pipeline.js';
import type { Registry } from './registry/registry.js';
import { jsonSchemaToTypeBox } from './schema/loader-pure.js';
import { SchemaValidator } from './schema/validator.js';
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

// `false`: the module-invocation boundary performs NO type coercion, under any
// host configuration (TYPE_MAPPING §17.3). A contract that declares `integer`
// receives an integer — `"42"` is a type error, not an integer spelled
// differently — because a module's contract has to mean the same thing
// regardless of which host loaded it.
const _schemaValidator = new SchemaValidator(false);

function validateSchema(schema: TSchema, data: Record<string, unknown>, direction: string): void {
  const result = _schemaValidator.validate(data, schema);
  if (result.valid) return;
  throw new SchemaValidationError(`${direction} validation failed`, result.errors as unknown as Array<Record<string, unknown>>);
}

/**
 * Read `requiresApproval` from a module's annotations.
 *
 * Exported so `Executor.governanceState()` reads the annotation through the
 * SAME predicate the approval gate uses (PROTOCOL_SPEC 6.6.5.1.1). A second
 * reading here would be a second way for the accessor to disagree with the
 * pipeline it describes.
 */
export function needsApproval(mod: Record<string, unknown> | null): boolean {
  const annotations = mod?.['annotations'];
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

function moduleIsDestructive(mod: Record<string, unknown> | null): boolean {
  const annotations = mod?.['annotations'];
  if (annotations == null || typeof annotations !== 'object') return false;
  return Boolean((annotations as Record<string, unknown>)['destructive']);
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
    // Always wrap in a child context for this module call.
    // If no parent context was provided, create a fresh root first.
    if (ctx.context == null) {
      // Issue #66: no executor arg; auto-binding happens on the next
      // executor entry. For internal child-context creation we just need a
      // fresh root.
      ctx.context = Context.create().child(ctx.moduleId);
    } else {
      ctx.context = ctx.context.child(ctx.moduleId);
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

/** Resolves the module from the registry and sets ctx.module.
 *
 * Also checks the toggle state and raises ModuleDisabledError if the module
 * has been disabled — inlined here to match the 11-step pipeline spec and
 * apcore-python/apcore-rust implementations (sync finding A-D-011).
 */
export class BuiltinModuleLookup implements Step {
  readonly name = 'module_lookup';
  readonly description = 'Resolve module from registry, enforce toggle state';
  readonly removable = false;
  readonly replaceable = false;
  readonly pure = true;
  readonly provides = ['module'] as const;

  private _registry: Registry;
  private readonly _toggleState: ToggleState;

  constructor(registry: Registry, toggleState?: ToggleState) {
    this._registry = registry;
    this._toggleState = toggleState ?? DEFAULT_TOGGLE_STATE;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const mod = this._registry.get(ctx.moduleId);
    if (mod === null) {
      throw new ModuleNotFoundError(ctx.moduleId);
    }

    // Inline toggle check — matches apcore-python builtin_steps.py:231 and
    // apcore-rust builtin_steps.rs:219 (sync finding A-D-011).
    if (this._toggleState.isDisabled(ctx.moduleId)) {
      throw new ModuleDisabledError(ctx.moduleId);
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
  private _eventEmitter: EventEmitter | null;

  constructor(acl: ACL | null, eventEmitter: EventEmitter | null = null) {
    this._acl = acl;
    this._eventEmitter = eventEmitter;
  }

  /** Update the ACL provider at runtime. */
  setAcl(acl: ACL): void {
    this._acl = acl;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    if (this._acl === null) {
      return { action: 'continue' };
    }
    const callerId = ctx.context.callerId;
    // Prefer the async ACL path so conditions registered via
    // `ACL.registerAsyncCondition()` are actually awaited. The sync evaluator
    // fails a Promise-returning condition closed, which makes a `deny` rule
    // guarded by an async condition silently NOT match — letting a later
    // catch-all `allow` win (fail-open). Mirrors apcore-python
    // `builtin_steps.py` (`hasattr(self._acl, "async_check")`); the sync
    // `check()` remains the fallback for duck-typed ACL providers.
    const aclLike = this._acl as unknown as { asyncCheck?: unknown };
    const allowed =
      typeof aclLike.asyncCheck === 'function'
        ? await this._acl.asyncCheck(callerId, ctx.moduleId, ctx.context)
        : this._acl.check(callerId, ctx.moduleId, ctx.context);
    if (!allowed) {
      // Publish a governance event on denial (canonical name proposed in
      // apcore#77). Guarded by dryRun so a validate() preflight probe never
      // emits a spurious denial event. Fires only on deny — allows are
      // high-volume and already covered by the apcore.acl.check span.
      this._emitDenied(callerId, ctx.moduleId, ctx.context, ctx.dryRun === true);
      throw new ACLDeniedError(callerId, ctx.moduleId);
    }
    return { action: 'continue' };
  }

  /** Emit `apcore.acl.denied` on the event bus (apcore#77) when live. */
  private _emitDenied(
    callerId: string | null,
    moduleId: string,
    ctx: Context,
    dryRun: boolean,
  ): void {
    if (this._eventEmitter === null || dryRun) return;
    this._eventEmitter.emit(
      createEvent('apcore.acl.denied', moduleId, 'warn', {
        module_id: moduleId,
        caller_id: callerId,
        reason: 'ACL denied',
        trace_id: ctx.traceId,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// 7. BuiltinApprovalGate
// ---------------------------------------------------------------------------

/** Handles approval flow for modules that require explicit approval.
 *
 * For modules whose annotations declare `requiresApproval=true` (or that an
 * {@link ExecutionPolicy} gates), calls the configured ApprovalHandler, emits an
 * audit event (tracing span event + optional event-bus event), and translates
 * the result into either continued execution or the appropriate ApprovalError.
 *
 * Fail-loud governance (apcore#76): when a module needs approval but no handler
 * is configured, the gate keeps the PROTOCOL_SPEC §7.4 skip behavior but warns
 * once per module. With `ExecutionPolicy(strict=true)` it fails closed instead.
 * A module whose effective `destructive` annotation is true but that no approval
 * gate covers is also warned about once per module.
 */
export class BuiltinApprovalGate implements Step {
  readonly name = 'approval_gate';
  readonly description = 'Approval handler flow';
  readonly removable = true;
  readonly replaceable = true;
  readonly requires = ['context', 'module'] as const;
  readonly pure = false;

  private _handler: ApprovalHandler | null;
  private _policy: ExecutionPolicy | null;
  private _eventEmitter: EventEmitter | null;
  private readonly _warned = new Set<string>();

  constructor(
    handler: ApprovalHandler | null,
    policy: ExecutionPolicy | null = null,
    eventEmitter: EventEmitter | null = null,
  ) {
    this._handler = handler;
    this._policy = policy;
    this._eventEmitter = eventEmitter;
  }

  /** Update the approval handler at runtime. */
  setApprovalHandler(handler: ApprovalHandler): void {
    this._handler = handler;
  }

  /** Update the execution policy at runtime. */
  setPolicy(policy: ExecutionPolicy | null): void {
    this._policy = policy;
  }

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const mod = ctx.module as Record<string, unknown> | null;
    // `_approval_token` is a protocol-level key (PROTOCOL_SPEC §7.4), not part
    // of any module's input contract. Strip it before any exit — including the
    // not-gated and no-handler-skip paths — so it never reaches input
    // validation, where `additionalProperties: false` rejected it as an
    // undeclared key, nor the module's own execute().
    const approvalToken = this._takeApprovalToken(ctx);

    let decision: PolicyDecision | null = null;
    let needs: boolean;
    let effectiveDestructive: boolean;
    if (this._policy !== null) {
      // §7.9.6: policy resolution receives the call site — the invocation
      // arguments and the Context — alongside the module ID and annotations.
      // These arguments have NOT been schema-validated: this gate is Step 5
      // and input validation is Step 7 (§12.8).
      decision = this._policy.resolve(ctx.moduleId, mod?.['annotations'] ?? null, {
        arguments: ctx.inputs ?? null,
        context: ctx.context ?? null,
      });
      needs = decision.needsApproval;
      effectiveDestructive = decision.destructive;
      if (decision.overridden) {
        this._emitPolicyAudit(decision, ctx.context);
      }
    } else {
      needs = needsApproval(mod);
      effectiveDestructive = moduleIsDestructive(mod);
    }

    if (!needs) {
      if (effectiveDestructive) {
        this._warnOnce(
          `destructive_ungated:${ctx.moduleId}`,
          `[apcore:approval] Module '${ctx.moduleId}' is annotated destructive=true but is not ` +
            'covered by the approval gate (requiresApproval is false and no policy gates ' +
            'destructive modules). Consider requiresApproval=true or ' +
            'ExecutionPolicy(gateDestructive=true). (apcore#76)',
        );
      }
      return { action: 'continue' };
    }

    if (this._handler === null) {
      if (this._policy !== null && this._policy.strict) {
        const result = createApprovalResult({
          status: 'rejected',
          reason:
            'Approval required but no ApprovalHandler is configured; ' +
            'ExecutionPolicy(strict=true) fails closed',
        });
        this._emitAudit(result, ctx.moduleId, ctx.context);
        throw new ApprovalDeniedError(result, ctx.moduleId);
      }
      this._warnOnce(
        `no_handler:${ctx.moduleId}`,
        `[apcore:approval] Module '${ctx.moduleId}' requires approval but no ApprovalHandler ` +
          'is configured; the approval gate is skipped per PROTOCOL_SPEC §7.4. Configure an ' +
          'approval handler, or ExecutionPolicy(strict=true) to fail closed. (apcore#76)',
      );
      return { action: 'continue' };
    }

    let result: ApprovalResult;

    if (approvalToken !== null) {
      result = await this._handler.checkApproval(approvalToken);
    } else {
      const annotations = mod?.['annotations'];
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

      if (decision !== null) {
        // Preserve the ApprovalRequest contract ("requiresApproval is guaranteed
        // true", PROTOCOL_SPEC §7) under policy overrides: the handler sees the
        // effective governance values, not the module's raw declaration.
        // Reaching this point means the call needs approval, so requiresApproval
        // is true by definition (covers rule overrides and gateDestructive).
        ann = applyDecisionToAnnotations(ann, decision);
      }

      const request = createApprovalRequest({
        moduleId: ctx.moduleId,
        arguments: ctx.inputs,
        context: ctx.context,
        annotations: ann,
        description: (mod?.['description'] as string) ?? null,
        tags: (mod?.['tags'] as string[]) ?? [],
      });
      result = await this._handler.requestApproval(request);
    }

    this._emitAudit(result, ctx.moduleId, ctx.context);

    if (result.status === 'approved') {
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

  /**
   * Remove `_approval_token` from `ctx.inputs` and return it, or `null` when
   * the caller sent none. `ctx.inputs` is replaced with a copy, never mutated
   * in place, so the caller's own object is left untouched.
   */
  private _takeApprovalToken(ctx: PipelineContext): string | null {
    if (!('_approval_token' in ctx.inputs)) return null;
    const rawToken = ctx.inputs['_approval_token'];
    // Security gate: reject a non-string token before it reaches the handler
    // instead of coercing it (mirrors Python/Rust rejecting with
    // GENERAL_INVALID_INPUT — the safest cross-language behavior).
    if (typeof rawToken !== 'string') {
      throw new InvalidInputError('_approval_token must be a string');
    }
    const { _approval_token: _, ...rest } = ctx.inputs;
    ctx.inputs = rest;
    return rawToken;
  }

  /** Warn once per dedup key (module/kind pair). */
  private _warnOnce(key: string, message: string): void {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(message);
  }

  /** Audit a policy-driven override: span event + optional bus event (apcore#77). */
  private _emitPolicyAudit(decision: PolicyDecision, ctx: Context): void {
    const rule = decision.rule;
    const pattern = rule ? rule.pattern : '';
    const reason = (rule ? rule.reason : null) ?? '';
    const spansStack = ctx.data[CTX_TRACING_SPANS] as
      | Array<{ events: Array<Record<string, unknown>> }>
      | undefined;
    if (spansStack && spansStack.length > 0) {
      spansStack[spansStack.length - 1].events.push({
        name: 'policy_override',
        module_id: decision.moduleId,
        pattern,
        requires_approval: decision.requiresApproval,
        destructive: decision.destructive,
        needs_approval: decision.needsApproval,
        reason,
      });
    }
    if (this._eventEmitter !== null) {
      this._eventEmitter.emit(
        createEvent('apcore.policy.override', decision.moduleId, 'info', {
          module_id: decision.moduleId,
          pattern,
          requires_approval: decision.requiresApproval,
          destructive: decision.destructive,
          needs_approval: decision.needsApproval,
          reason,
          trace_id: ctx.traceId,
        }),
      );
    }
  }

  /** Audit an approval decision: span event + optional bus event (apcore#77).
   *
   * Severity mirrors the outcome: approved/pending are `info`; rejected/timeout
   * (governance interventions) are `warn`.
   */
  private _emitAudit(result: ApprovalResult, moduleId: string, ctx: Context): void {
    const spansStack = ctx.data[CTX_TRACING_SPANS] as
      | Array<{ events: Array<Record<string, unknown>> }>
      | undefined;
    if (spansStack && spansStack.length > 0) {
      spansStack[spansStack.length - 1].events.push({
        name: 'approval_decision',
        module_id: moduleId,
        status: result.status,
        approved_by: result.approvedBy ?? '',
        reason: result.reason ?? '',
        approval_id: result.approvalId ?? '',
      });
    }
    if (this._eventEmitter !== null) {
      const severity =
        result.status === 'approved' || result.status === 'pending' ? 'info' : 'warn';
      this._eventEmitter.emit(
        createEvent('apcore.approval.decision', moduleId, severity, {
          module_id: moduleId,
          status: result.status,
          approved_by: result.approvedBy,
          reason: result.reason,
          approval_id: result.approvalId,
          trace_id: ctx.traceId,
        }),
      );
    }
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
      const [effectiveInputs, executedMiddlewares] = await this._middlewareManager.executeBefore(
        ctx.moduleId,
        ctx.inputs,
        ctx.context,
      );
      ctx.inputs = effectiveInputs;
      ctx.executedMiddlewares = executedMiddlewares;
    } catch (e) {
      if (e instanceof MiddlewareChainError) {
        // Store the executed middlewares for the executor's on_error recovery,
        // then re-raise WITHOUT running on_error here. The executor (call()/
        // callWithTrace()/stream paths) is the SOLE on_error site, so on_error
        // fires exactly once per attempt. Running it here as well would
        // double-fire stateful handlers — e.g. RetryMiddleware would
        // double-increment its counter, halving the retry budget. Mirrors
        // apcore-python builtin_steps.py BuiltinMiddlewareBefore's
        // MiddlewareChainError branch (sync finding A-D-011).
        ctx.executedMiddlewares = e.executedMiddlewares;
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

    // Streaming path: store the generator on ctx.outputStream, then skip to
    // return_result. This matches apcore-python's StepResult(action="skip_to",
    // skip_to="return_result") so PipelineTrace records steps 9/10 as skipped
    // rather than normal-continue-with-null-output (sync finding A-D-019).
    if (ctx.stream) {
      const streamFn = mod['stream'] as
        | ((
            inputs: Record<string, unknown>,
            context: Context,
          ) => AsyncGenerator<Record<string, unknown>>)
        | undefined;
      if (typeof streamFn === 'function') {
        ctx.outputStream = streamFn.call(mod, ctx.inputs, ctx.context);
        return { action: 'skip_to', skipTo: 'return_result' };
      }
      // fallback: execute normally and wrap as single-chunk
    }

    // Regular execution with timeout.
    //
    // Spec D-11 (per-module timeout): each module MAY declare its own
    // `resources.timeout` (milliseconds) via either the top-level `resources`
    // field or `annotations.resources.timeout`. The effective timeout is the
    // module value when present; otherwise the executor default. The global
    // deadline (if any) further clamps the effective timeout so the call
    // cannot outrun an outer budget.
    let timeoutMs = this._readModuleTimeoutMs(mod) ?? this._defaultTimeout;
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
      // No timeout: still race against the cancel signal so callers see a
      // typed ExecutionCancelledError instead of waiting for the module to
      // discover the cancel cooperatively (D-18, D-21).
      const cancelToken = ctx.context.cancelToken;
      if (cancelToken !== null) {
        ctx.output = await Promise.race([
          executionPromise,
          this._raceAgainstCancel(cancelToken),
        ]);
      } else {
        ctx.output = await executionPromise;
      }
    } else {
      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ModuleTimeoutError(ctx.moduleId, timeoutMs));
        }, timeoutMs);
      });
      // D-18 / D-21: race execution against both the timeout AND the caller's
      // cancel token so cancellation surfaces as a typed
      // ExecutionCancelledError mid-pipeline even if the module is sitting
      // on an await point that isn't a Web API.
      const cancelToken = ctx.context.cancelToken;
      const racers: Promise<unknown>[] = [executionPromise, timeoutPromise];
      if (cancelToken !== null) {
        racers.push(this._raceAgainstCancel(cancelToken));
      }
      ctx.output = (await Promise.race(racers).finally(() => {
        clearTimeout(timer!);
      })) as Record<string, unknown>;
    }

    return { action: 'continue' };
  }

  /**
   * Build a Promise that rejects with ExecutionCancelledError as soon as the
   * given CancelToken's underlying AbortSignal fires. Used to race against
   * the module's executionPromise so cancellation interrupts even if the
   * module isn't awaiting a Web API directly. (D-18, D-21)
   */
  /**
   * Read the module's declared `resources.timeout` (D-11) in milliseconds.
   * Returns `null` when not declared. Supports two equivalent locations
   * (module-level `resources` or `annotations.resources`) for parity with
   * the other SDKs.
   */
  private _readModuleTimeoutMs(mod: Record<string, unknown>): number | null {
    // A declared numeric timeout is honoured; a declared NEGATIVE timeout is an
    // invalid input and MUST raise GENERAL_INVALID_INPUT (spec Edge Cases;
    // parity with apcore-python builtin_steps.py:620). A non-numeric / absent
    // value is treated as "not declared" → null (caller falls back to default).
    const readNumber = (val: unknown): number | null => {
      if (typeof val !== 'number' || !Number.isFinite(val)) return null;
      if (val < 0) {
        throw new InvalidInputError(`Negative timeout: ${val}`);
      }
      return val;
    };

    const directResources = mod['resources'];
    if (directResources != null && typeof directResources === 'object') {
      const t = readNumber((directResources as Record<string, unknown>)['timeout']);
      if (t !== null) return t;
    }
    const ann = mod['annotations'];
    if (ann != null && typeof ann === 'object') {
      const annResources = (ann as Record<string, unknown>)['resources'];
      if (annResources != null && typeof annResources === 'object') {
        const t = readNumber((annResources as Record<string, unknown>)['timeout']);
        if (t !== null) return t;
      }
    }
    return null;
  }

  private _raceAgainstCancel(cancelToken: CancelToken): Promise<never> {
    if (cancelToken.signal.aborted) {
      return Promise.reject(new ExecutionCancelledError());
    }
    return new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        cancelToken.signal.removeEventListener('abort', onAbort);
        reject(new ExecutionCancelledError());
      };
      cancelToken.signal.addEventListener('abort', onAbort, { once: true });
    });
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
    const transformed = await this._middlewareManager.executeAfter(
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
  /** Optional ExecutionPolicy with governance overrides for the Step 5 gate (apcore#76). */
  policy?: ExecutionPolicy | null;
  /**
   * Optional EventEmitter. When provided, the ACL step publishes
   * apcore.acl.denied and the approval gate publishes apcore.approval.decision
   * / apcore.policy.override governance events (apcore#77).
   */
  eventEmitter?: EventEmitter | null;
}

/** Build the standard 11-step execution strategy matching PROTOCOL_SPEC §5 pipeline.
 *
 * Toggle-state check is inlined inside BuiltinModuleLookup (step 3), matching
 * apcore-python and apcore-rust 11-step implementations (sync finding A-D-011).
 */
export function buildStandardStrategy(deps: StandardStrategyDeps): ExecutionStrategy {
  return new ExecutionStrategy('standard', [
    new BuiltinContextCreation(deps.config),
    new BuiltinCallChainGuard(deps.config),
    new BuiltinModuleLookup(deps.registry, deps.toggleState ?? undefined),
    new BuiltinACLCheck(deps.acl, deps.eventEmitter ?? null),
    new BuiltinApprovalGate(deps.approvalHandler, deps.policy ?? null, deps.eventEmitter ?? null),
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
    new BuiltinModuleLookup(deps.registry, deps.toggleState ?? undefined),
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
    new BuiltinModuleLookup(deps.registry, deps.toggleState ?? undefined),
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
 * Retains toggle state, ACL, approval, and validation for correctness.
 * Toggle-state check is inlined in BuiltinModuleLookup (sync finding A-D-011).
 */
export function buildPerformanceStrategy(deps: StandardStrategyDeps): ExecutionStrategy {
  return new ExecutionStrategy('performance', [
    new BuiltinContextCreation(deps.config),
    new BuiltinCallChainGuard(deps.config),
    new BuiltinModuleLookup(deps.registry, deps.toggleState ?? undefined),
    new BuiltinACLCheck(deps.acl, deps.eventEmitter ?? null),
    new BuiltinApprovalGate(deps.approvalHandler, deps.policy ?? null, deps.eventEmitter ?? null),
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
    // The per-instance ToggleState must be threaded through here too — the
    // other four preset builders pass it, and omitting it silently falls back
    // to DEFAULT_TOGGLE_STATE, so `apcore.disable(module)` on one instance
    // leaks into every other instance using the `minimal` preset (issue #71).
    new BuiltinModuleLookup(deps.registry, deps.toggleState ?? undefined),
    new BuiltinExecute(deps.config),
    new BuiltinReturnResult(),
  ]);
}
