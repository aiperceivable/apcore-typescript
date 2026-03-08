/**
 * Executor and related utilities for apcore.
 *
 * Async-only execution pipeline. Python's call() + call_async() merge into one async call().
 * Timeout uses Promise.race instead of threading.
 */

import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ACL } from './acl.js';
import type { ApprovalHandler, ApprovalRequest, ApprovalResult } from './approval.js';
import { createApprovalRequest } from './approval.js';
import type { Config } from './config.js';
import { Context } from './context.js';
import { ExecutionCancelledError } from './cancel.js';
import {
  ACLDeniedError,
  ApprovalDeniedError,
  ApprovalPendingError,
  ApprovalTimeoutError,
  InvalidInputError,
  ModuleError,
  ModuleNotFoundError,
  ModuleTimeoutError,
  SchemaValidationError,
} from './errors.js';
import { AfterMiddleware, BeforeMiddleware, Middleware } from './middleware/index.js';
import { MiddlewareChainError, MiddlewareManager } from './middleware/manager.js';
import { guardCallChain } from './utils/call-chain.js';
import type { ModuleAnnotations, PreflightCheckResult, PreflightResult } from './module.js';
import { DEFAULT_ANNOTATIONS, createPreflightResult } from './module.js';
import { MODULE_ID_PATTERN } from './registry/registry.js';
import type { Registry } from './registry/registry.js';

export const REDACTED_VALUE: string = '***REDACTED***';

/** Well-known context.data keys used internally by the framework. */
export const CTX_GLOBAL_DEADLINE = '_global_deadline';
export const CTX_TRACING_SPANS = '_tracing_spans';

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

/**
 * Normalize a dict-form annotations object into a ModuleAnnotations interface.
 * Handles both camelCase and snake_case keys (parallel to Python's
 * ``ModuleAnnotations(**{k: v for k, v in annotations.items() if k in valid_fields})``).
 */
function dictToAnnotations(dict: Record<string, unknown>): ModuleAnnotations {
  return {
    readonly: Boolean(dict['readonly'] ?? false),
    destructive: Boolean(dict['destructive'] ?? false),
    idempotent: Boolean(dict['idempotent'] ?? false),
    requiresApproval: Boolean(dict['requiresApproval'] ?? dict['requires_approval'] ?? false),
    openWorld: Boolean(dict['openWorld'] ?? dict['open_world'] ?? true),
    streaming: Boolean(dict['streaming'] ?? false),
  };
}

export class Executor {
  private _registry: Registry;
  private _middlewareManager: MiddlewareManager;
  private _acl: ACL | null;
  private _config: Config | null;
  private _approvalHandler: ApprovalHandler | null;
  private _defaultTimeout: number;
  private _globalTimeout: number;
  private _maxCallDepth: number;
  private _maxModuleRepeat: number;

  constructor(options: {
    registry: Registry;
    middlewares?: Middleware[] | null;
    acl?: ACL | null;
    config?: Config | null;
    approvalHandler?: ApprovalHandler | null;
  }) {
    this._registry = options.registry;
    this._middlewareManager = new MiddlewareManager();
    this._acl = options.acl ?? null;
    this._config = options.config ?? null;
    this._approvalHandler = options.approvalHandler ?? null;

    if (options.middlewares) {
      for (const mw of options.middlewares) {
        this._middlewareManager.add(mw);
      }
    }

    if (this._config !== null) {
      this._defaultTimeout = (this._config.get('executor.default_timeout') as number) ?? 30000;
      this._globalTimeout = (this._config.get('executor.global_timeout') as number) ?? 60000;
      this._maxCallDepth = (this._config.get('executor.max_call_depth') as number) ?? 32;
      this._maxModuleRepeat = (this._config.get('executor.max_module_repeat') as number) ?? 3;
    } else {
      this._defaultTimeout = 30000;
      this._globalTimeout = 60000;
      this._maxCallDepth = 32;
      this._maxModuleRepeat = 3;
    }
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

  /** Set the access control provider. */
  setAcl(acl: ACL): void {
    this._acl = acl;
  }

  /** Set the approval handler for Step 5 gate. */
  setApprovalHandler(handler: ApprovalHandler): void {
    this._approvalHandler = handler;
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
    _versionHint?: string | null,
  ): Promise<Record<string, unknown>> {
    const { mod, effectiveInputs, ctx } = await this._prepareExecution(moduleId, inputs, context);
    return this._executeWithMiddleware(mod, moduleId, effectiveInputs, ctx);
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
  async *stream(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    _versionHint?: string | null,
  ): AsyncGenerator<Record<string, unknown>> {
    const { mod, effectiveInputs, ctx } = await this._prepareExecution(moduleId, inputs, context);
    yield* this._streamWithMiddleware(mod, moduleId, effectiveInputs, ctx);
  }

  private async *_streamWithMiddleware(
    mod: Record<string, unknown>,
    moduleId: string,
    inputs: Record<string, unknown>,
    ctx: Context,
  ): AsyncGenerator<Record<string, unknown>> {
    let effectiveInputs = inputs;
    let executedMiddlewares: Middleware[] = [];

    try {
      try {
        [effectiveInputs, executedMiddlewares] = this._middlewareManager.executeBefore(moduleId, effectiveInputs, ctx);
      } catch (e) {
        if (e instanceof MiddlewareChainError) {
          executedMiddlewares = e.executedMiddlewares;
          const recovery = this._middlewareManager.executeOnError(
            moduleId, effectiveInputs, e.original, ctx, executedMiddlewares,
          );
          if (recovery !== null) {
            yield recovery;
            return;
          }
          executedMiddlewares = [];
          throw e.original;
        }
        throw e;
      }

      // Cancel check before execution
      if (ctx.cancelToken !== null) {
        ctx.cancelToken.check();
      }

      const streamFn = mod['stream'] as
        | ((inputs: Record<string, unknown>, context: Context) => AsyncGenerator<Record<string, unknown>>)
        | undefined;

      if (typeof streamFn === 'function') {
        // Module has a stream() method: iterate and yield each chunk
        let accumulated: Record<string, unknown> = {};
        for await (const chunk of streamFn.call(mod, effectiveInputs, ctx)) {
          accumulated = { ...accumulated, ...chunk };
          yield chunk;
        }

        // Validate accumulated output against output schema
        this._validateOutput(mod, accumulated);

        // Run after-middleware on the accumulated result
        this._middlewareManager.executeAfter(moduleId, effectiveInputs, accumulated, ctx);
      } else {
        // Fallback: execute normally and yield single chunk
        let output = await this._executeWithTimeout(mod, moduleId, effectiveInputs, ctx);
        this._validateOutput(mod, output);
        output = this._middlewareManager.executeAfter(moduleId, effectiveInputs, output, ctx);
        yield output;
      }
    } catch (exc) {
      if (exc instanceof ExecutionCancelledError) throw exc;
      if (executedMiddlewares.length > 0) {
        const recovery = this._middlewareManager.executeOnError(
          moduleId, effectiveInputs, exc as Error, ctx, executedMiddlewares,
        );
        if (recovery !== null) {
          yield recovery;
          return;
        }
      }
      throw exc;
    }
  }

  /**
   * Shared pipeline: context -> global deadline -> safety -> lookup -> ACL -> approval -> validate.
   */
  private async _prepareExecution(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
  ): Promise<{ mod: Record<string, unknown>; effectiveInputs: Record<string, unknown>; ctx: Context }> {
    let effectiveInputs = inputs ?? {};
    const ctx = this._createContext(moduleId, context);

    // Set global deadline on root call only
    if (!(CTX_GLOBAL_DEADLINE in ctx.data) && this._globalTimeout > 0) {
      ctx.data[CTX_GLOBAL_DEADLINE] = Date.now() + this._globalTimeout;
    }

    this._checkSafety(moduleId, ctx);

    const mod = this._lookupModule(moduleId);
    this._checkAcl(moduleId, ctx);

    // Step 5 -- Approval Gate (strips internal keys like _approval_token)
    effectiveInputs = await this._checkApproval(mod, moduleId, effectiveInputs, ctx);

    effectiveInputs = this._validateInputs(mod, effectiveInputs, ctx);

    return { mod, effectiveInputs, ctx };
  }

  private _createContext(moduleId: string, context?: Context | null): Context {
    if (context == null) {
      return Context.create(this).child(moduleId);
    }
    return context.child(moduleId);
  }

  private _lookupModule(moduleId: string): Record<string, unknown> {
    const module = this._registry.get(moduleId);
    if (module === null) {
      throw new ModuleNotFoundError(moduleId);
    }
    return module as Record<string, unknown>;
  }

  private _checkAcl(moduleId: string, ctx: Context): void {
    if (this._acl !== null) {
      const allowed = this._acl.check(ctx.callerId, moduleId, ctx);
      if (!allowed) {
        throw new ACLDeniedError(ctx.callerId, moduleId);
      }
    }
  }

  private _validateInputs(
    mod: Record<string, unknown>,
    inputs: Record<string, unknown>,
    ctx: Context,
  ): Record<string, unknown> {
    const inputSchema = mod['inputSchema'] as TSchema | undefined;
    if (inputSchema == null) return inputs;

    this._validateSchema(inputSchema, inputs, 'Input');
    ctx.redactedInputs = redactSensitive(
      inputs,
      inputSchema as unknown as Record<string, unknown>,
    );
    return inputs;
  }

  private _validateSchema(
    schema: TSchema,
    data: Record<string, unknown>,
    direction: string,
  ): void {
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

  private async _executeWithMiddleware(
    mod: Record<string, unknown>,
    moduleId: string,
    inputs: Record<string, unknown>,
    ctx: Context,
  ): Promise<Record<string, unknown>> {
    let effectiveInputs = inputs;
    let executedMiddlewares: Middleware[] = [];

    try {
      try {
        [effectiveInputs, executedMiddlewares] = this._middlewareManager.executeBefore(moduleId, effectiveInputs, ctx);
      } catch (e) {
        if (e instanceof MiddlewareChainError) {
          executedMiddlewares = e.executedMiddlewares;
          const recovery = this._middlewareManager.executeOnError(
            moduleId, effectiveInputs, e.original, ctx, executedMiddlewares,
          );
          if (recovery !== null) return recovery;
          executedMiddlewares = [];
          throw e.original;
        }
        throw e;
      }

      // Cancel check before execution
      if (ctx.cancelToken !== null) {
        ctx.cancelToken.check();
      }

      let output = await this._executeWithTimeout(mod, moduleId, effectiveInputs, ctx);

      this._validateOutput(mod, output);

      output = this._middlewareManager.executeAfter(moduleId, effectiveInputs, output, ctx);
      return output;
    } catch (exc) {
      if (exc instanceof ExecutionCancelledError) throw exc;
      if (executedMiddlewares.length > 0) {
        const recovery = this._middlewareManager.executeOnError(
          moduleId, effectiveInputs, exc as Error, ctx, executedMiddlewares,
        );
        if (recovery !== null) return recovery;
      }
      throw exc;
    }
  }

  private _validateOutput(mod: Record<string, unknown>, output: Record<string, unknown>): void {
    const outputSchema = mod['outputSchema'] as TSchema | undefined;
    if (outputSchema != null) {
      this._validateSchema(outputSchema, output, 'Output');
    }
  }

  /**
   * Non-destructive preflight check through Steps 1-6 of the pipeline.
   * Returns a PreflightResult that is duck-type compatible with ValidationResult.
   */
  validate(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
  ): PreflightResult {
    const effectiveInputs = inputs ?? {};
    const checks: PreflightCheckResult[] = [];
    let requiresApproval = false;

    // Check 1: module_id format
    if (!MODULE_ID_PATTERN.test(moduleId)) {
      checks.push({
        check: 'module_id', passed: false,
        error: { code: 'INVALID_INPUT', message: `Invalid module ID: "${moduleId}"` },
      });
      return createPreflightResult(checks);
    }
    checks.push({ check: 'module_id', passed: true });

    // Check 2: module lookup
    const module = this._registry.get(moduleId);
    if (module === null) {
      checks.push({
        check: 'module_lookup', passed: false,
        error: { code: 'MODULE_NOT_FOUND', message: `Module not found: ${moduleId}` },
      });
      return createPreflightResult(checks);
    }
    checks.push({ check: 'module_lookup', passed: true });
    const mod = module as Record<string, unknown>;

    // Check 3: call chain safety
    const ctx = this._createContext(moduleId, context);
    try {
      this._checkSafety(moduleId, ctx);
      checks.push({ check: 'call_chain', passed: true });
    } catch (e) {
      const err = e instanceof ModuleError
        ? { code: e.code, message: e.message }
        : { code: 'CALL_CHAIN_ERROR', message: String(e) };
      checks.push({ check: 'call_chain', passed: false, error: err });
    }

    // Check 4: ACL
    if (this._acl !== null) {
      const allowed = this._acl.check(ctx.callerId, moduleId, ctx);
      if (!allowed) {
        checks.push({
          check: 'acl', passed: false,
          error: { code: 'ACL_DENIED', message: `Access denied: ${ctx.callerId} -> ${moduleId}` },
        });
      } else {
        checks.push({ check: 'acl', passed: true });
      }
    } else {
      checks.push({ check: 'acl', passed: true });
    }

    // Check 5: approval detection (report only, no handler invocation)
    if (this._needsApproval(mod)) {
      requiresApproval = true;
    }
    checks.push({ check: 'approval', passed: true });

    // Check 6: input schema validation
    const inputSchema = mod['inputSchema'] as TSchema | undefined;
    if (inputSchema != null) {
      if (Value.Check(inputSchema, effectiveInputs)) {
        checks.push({ check: 'schema', passed: true });
      } else {
        const errors: Array<Record<string, unknown>> = [];
        for (const error of Value.Errors(inputSchema, effectiveInputs)) {
          errors.push({
            field: error.path || '/',
            code: String(error.type),
            message: error.message,
          });
        }
        checks.push({
          check: 'schema', passed: false,
          error: { code: 'SCHEMA_VALIDATION_ERROR', errors },
        });
      }
    } else {
      checks.push({ check: 'schema', passed: true });
    }

    return createPreflightResult(checks, requiresApproval);
  }

  private _checkSafety(moduleId: string, ctx: Context): void {
    guardCallChain(moduleId, ctx.callChain, this._maxCallDepth, this._maxModuleRepeat);
  }

  /** Check if a module requires approval, handling both interface and dict annotations. */
  private _needsApproval(mod: Record<string, unknown>): boolean {
    const annotations = mod['annotations'];
    if (annotations == null) return false;
    if (typeof annotations !== 'object') return false;
    // ModuleAnnotations interface (camelCase)
    if ('requiresApproval' in annotations) {
      return Boolean((annotations as ModuleAnnotations).requiresApproval);
    }
    // Dict-form annotations (snake_case)
    if ('requires_approval' in annotations) {
      return Boolean((annotations as Record<string, unknown>)['requires_approval']);
    }
    return false;
  }

  /** Build an ApprovalRequest from module metadata. */
  private _buildApprovalRequest(
    mod: Record<string, unknown>,
    moduleId: string,
    inputs: Record<string, unknown>,
    ctx: Context,
  ): ApprovalRequest {
    const annotations = mod['annotations'];
    let ann: ModuleAnnotations;
    if (annotations != null && typeof annotations === 'object' && 'requiresApproval' in annotations) {
      ann = annotations as ModuleAnnotations;
    } else if (annotations != null && typeof annotations === 'object') {
      ann = dictToAnnotations(annotations as Record<string, unknown>);
    } else {
      ann = DEFAULT_ANNOTATIONS;
    }

    return createApprovalRequest({
      moduleId,
      arguments: inputs,
      context: ctx,
      annotations: ann,
      description: (mod['description'] as string) ?? null,
      tags: (mod['tags'] as string[]) ?? [],
    });
  }

  /** Map an ApprovalResult status to the appropriate action or error. */
  private _handleApprovalResult(result: ApprovalResult, moduleId: string): void {
    if (result.status === 'approved') return;
    if (result.status === 'rejected') {
      throw new ApprovalDeniedError(result, moduleId);
    }
    if (result.status === 'timeout') {
      throw new ApprovalTimeoutError(result, moduleId);
    }
    if (result.status === 'pending') {
      throw new ApprovalPendingError(result, moduleId);
    }
    // Unknown status treated as denied
    console.warn(`[apcore:executor] Unknown approval status '${result.status}' for module ${moduleId}, treating as denied`);
    throw new ApprovalDeniedError(result, moduleId);
  }

  /** Emit an audit event for the approval decision (logging + span event). */
  private _emitApprovalEvent(result: ApprovalResult, moduleId: string, ctx: Context): void {
    console.info(
      `[apcore:executor] Approval decision: module=${moduleId} status=${result.status} approved_by=${result.approvedBy} reason=${result.reason}`,
    );

    const spansStack = ctx.data[CTX_TRACING_SPANS] as Array<{ events: Array<Record<string, unknown>> }> | undefined;
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
  }

  /** Step 5: Approval gate. Returns inputs with internal keys stripped. */
  private async _checkApproval(
    mod: Record<string, unknown>,
    moduleId: string,
    inputs: Record<string, unknown>,
    ctx: Context,
  ): Promise<Record<string, unknown>> {
    if (this._approvalHandler === null) return inputs;
    if (!this._needsApproval(mod)) return inputs;

    let result: ApprovalResult;
    let cleanInputs = inputs;
    if ('_approval_token' in inputs) {
      const token = inputs['_approval_token'] as string;
      const { _approval_token: _, ...rest } = inputs;
      cleanInputs = rest;
      result = await this._approvalHandler.checkApproval(token);
    } else {
      const request = this._buildApprovalRequest(mod, moduleId, inputs, ctx);
      result = await this._approvalHandler.requestApproval(request);
    }

    this._emitApprovalEvent(result, moduleId, ctx);
    this._handleApprovalResult(result, moduleId);
    return cleanInputs;
  }

  private async _executeWithTimeout(
    mod: Record<string, unknown>,
    moduleId: string,
    inputs: Record<string, unknown>,
    ctx: Context,
  ): Promise<Record<string, unknown>> {
    let timeoutMs = this._defaultTimeout;

    // Respect global deadline: use whichever is shorter
    const globalDeadline = ctx.data[CTX_GLOBAL_DEADLINE] as number | undefined;
    if (globalDeadline !== undefined) {
      const remaining = globalDeadline - Date.now();
      if (remaining <= 0) {
        throw new ModuleTimeoutError(moduleId, 0);
      }
      if (timeoutMs === 0 || remaining < timeoutMs) {
        timeoutMs = remaining;
      }
    }

    if (timeoutMs < 0) {
      throw new InvalidInputError(`Negative timeout: ${timeoutMs}ms`);
    }

    const executeFn = mod['execute'];
    if (typeof executeFn !== 'function') {
      throw new InvalidInputError(`Module '${moduleId}' has no execute method`);
    }

    const executionPromise = Promise.resolve(
      (executeFn as (inputs: Record<string, unknown>, context: Context) => Promise<Record<string, unknown>> | Record<string, unknown>)
        .call(mod, inputs, ctx),
    );

    if (timeoutMs === 0) {
      console.warn('[apcore:executor] Timeout is 0, timeout limit disabled');
      return executionPromise;
    }

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ModuleTimeoutError(moduleId, timeoutMs));
      }, timeoutMs);
    });

    return Promise.race([executionPromise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }
}
