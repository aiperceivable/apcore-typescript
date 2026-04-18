/**
 * Error hierarchy for apcore.
 */

export interface ErrorOptions {
  cause?: Error;
  traceId?: string;
  retryable?: boolean | null;
  aiGuidance?: string | null;
  userFixable?: boolean | null;
  suggestion?: string | null;
}

export class ModuleError extends Error {
  static readonly DEFAULT_RETRYABLE: boolean | null = null;

  readonly code: string;
  readonly details: Record<string, unknown>;
  override readonly cause?: Error;
  readonly traceId?: string;
  readonly timestamp: string;
  readonly retryable: boolean | null;
  readonly aiGuidance: string | null;
  readonly userFixable: boolean | null;
  readonly suggestion: string | null;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    cause?: Error,
    traceId?: string,
    retryable?: boolean | null,
    aiGuidance?: string | null,
    userFixable?: boolean | null,
    suggestion?: string | null,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ModuleError';
    this.code = code;
    this.details = details ?? {};
    this.cause = cause;
    this.traceId = traceId;
    this.timestamp = new Date().toISOString();
    this.retryable =
      retryable !== undefined
        ? retryable
        : (this.constructor as typeof ModuleError).DEFAULT_RETRYABLE;
    this.aiGuidance = aiGuidance ?? null;
    this.userFixable = userFixable ?? null;
    this.suggestion = suggestion ?? null;
  }

  override toString(): string {
    return `[${this.code}] ${this.message}`;
  }

  toJSON(): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      code: this.code,
      message: this.message,
    };
    if (Object.keys(this.details).length > 0) {
      obj.details = this.details;
    }
    if (this.cause !== undefined) {
      obj.cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    }
    if (this.traceId !== undefined) {
      obj.traceId = this.traceId;
    }
    obj.timestamp = this.timestamp;
    if (this.retryable !== null) {
      obj.retryable = this.retryable;
    }
    if (this.aiGuidance !== null) {
      obj.aiGuidance = this.aiGuidance;
    }
    if (this.userFixable !== null) {
      obj.userFixable = this.userFixable;
    }
    if (this.suggestion !== null) {
      obj.suggestion = this.suggestion;
    }
    return obj;
  }
}

export class ConfigNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(configPath: string, options?: ErrorOptions) {
    super(
      'CONFIG_NOT_FOUND',
      `Configuration file not found: ${configPath}`,
      { configPath },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigNotFoundError';
  }
}

export class ConfigError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string, options?: ErrorOptions) {
    super(
      'CONFIG_INVALID',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigError';
  }
}

export class ACLRuleError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string, options?: ErrorOptions) {
    super(
      'ACL_RULE_ERROR',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ACLRuleError';
  }
}

export class ACLDeniedError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(callerId: string | null, targetId: string, options?: ErrorOptions) {
    super(
      'ACL_DENIED',
      `Access denied: ${callerId} -> ${targetId}`,
      { callerId, targetId },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        `Access denied for '${callerId}' calling '${targetId}'. Verify the caller has the required role or permission, or try an alternative module with similar functionality.`,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ACLDeniedError';
  }

  get callerId(): string | null {
    return this.details['callerId'] as string | null;
  }

  get targetId(): string {
    return this.details['targetId'] as string;
  }
}

export class ModuleNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(moduleId: string, options?: ErrorOptions) {
    super(
      'MODULE_NOT_FOUND',
      `Module not found: ${moduleId}`,
      { moduleId },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        `Module '${moduleId}' does not exist in the registry. Verify the module ID spelling. Use system.manifest.full to list available modules.`,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ModuleNotFoundError';
  }
}

export class ModuleDisabledError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(moduleId: string, options?: ErrorOptions) {
    super(
      'MODULE_DISABLED',
      `Module is disabled: ${moduleId}`,
      { moduleId },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        `Module '${moduleId}' is currently disabled. Use system.control.toggle_feature to re-enable it, or find an alternative module.`,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ModuleDisabledError';
  }
}

export class ModuleTimeoutError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = true;

  constructor(moduleId: string, timeoutMs: number, options?: ErrorOptions) {
    super(
      'MODULE_TIMEOUT',
      `Module ${moduleId} timed out after ${timeoutMs}ms`,
      { moduleId, timeoutMs },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        `Module '${moduleId}' timed out after ${timeoutMs}ms. Consider: 1) Breaking the operation into smaller steps. 2) Reducing the input data size. 3) Asking the user if a longer timeout is acceptable.`,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ModuleTimeoutError';
  }

  get moduleId(): string {
    return this.details['moduleId'] as string;
  }

  get timeoutMs(): number {
    return this.details['timeoutMs'] as number;
  }
}

export class SchemaValidationError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(
    message: string = 'Schema validation failed',
    errors?: Array<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(
      'SCHEMA_VALIDATION_ERROR',
      message,
      { errors: errors ?? [] },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        'Input validation failed. Review the error details to identify which fields have invalid values, then correct them or ask the user for valid input.',
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'SchemaValidationError';
  }
}

export class SchemaNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(schemaId: string, options?: ErrorOptions) {
    super(
      'SCHEMA_NOT_FOUND',
      `Schema not found: ${schemaId}`,
      { schemaId },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'SchemaNotFoundError';
  }
}

export class SchemaParseError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string, options?: ErrorOptions) {
    super(
      'SCHEMA_PARSE_ERROR',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'SchemaParseError';
  }
}

export class SchemaCircularRefError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(refPath: string, options?: ErrorOptions) {
    super(
      'SCHEMA_CIRCULAR_REF',
      `Circular reference detected: ${refPath}`,
      { refPath },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'SchemaCircularRefError';
  }
}

export class CallDepthExceededError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(depth: number, maxDepth: number, callChain: string[], options?: ErrorOptions) {
    super(
      'CALL_DEPTH_EXCEEDED',
      `Call depth ${depth} exceeds maximum ${maxDepth}`,
      { depth, maxDepth, callChain },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        `Call depth ${depth} exceeds maximum ${maxDepth}. Simplify the module call chain or restructure to reduce nesting depth.`,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'CallDepthExceededError';
  }

  get currentDepth(): number {
    return this.details['depth'] as number;
  }

  get maxDepth(): number {
    return this.details['maxDepth'] as number;
  }
}

export class CircularCallError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(moduleId: string, callChain: string[], options?: ErrorOptions) {
    super(
      'CIRCULAR_CALL',
      `Circular call detected for module ${moduleId}`,
      { moduleId, callChain },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        'A circular call was detected in the module call chain. Review the call_chain in error details and restructure to eliminate the cycle.',
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'CircularCallError';
  }

  get moduleId(): string {
    return this.details['moduleId'] as string;
  }
}

export class CallFrequencyExceededError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(
    moduleId: string,
    count: number,
    maxRepeat: number,
    callChain: string[],
    options?: ErrorOptions,
  ) {
    super(
      'CALL_FREQUENCY_EXCEEDED',
      `Module ${moduleId} called ${count} times, max is ${maxRepeat}`,
      { moduleId, count, maxRepeat, callChain },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'CallFrequencyExceededError';
  }

  get moduleId(): string {
    return this.details['moduleId'] as string;
  }

  get count(): number {
    return this.details['count'] as number;
  }

  get maxRepeat(): number {
    return this.details['maxRepeat'] as number;
  }
}

export class InvalidInputError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string = 'Invalid input', options?: ErrorOptions) {
    super(
      'GENERAL_INVALID_INPUT',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'InvalidInputError';
  }
}

export class BindingInvalidTargetError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(target: string, options?: ErrorOptions) {
    super(
      'BINDING_INVALID_TARGET',
      `Invalid binding target '${target}'. Expected format: 'module.path:callable_name'.`,
      { target },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingInvalidTargetError';
  }
}

export class BindingModuleNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(modulePath: string, options?: ErrorOptions) {
    super(
      'BINDING_MODULE_NOT_FOUND',
      `Cannot import module '${modulePath}'.`,
      { modulePath },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingModuleNotFoundError';
  }
}

export class BindingCallableNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(callableName: string, modulePath: string, options?: ErrorOptions) {
    super(
      'BINDING_CALLABLE_NOT_FOUND',
      `Cannot find callable '${callableName}' in module '${modulePath}'.`,
      { callableName, modulePath },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingCallableNotFoundError';
  }
}

export class BindingNotCallableError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(target: string, options?: ErrorOptions) {
    super(
      'BINDING_NOT_CALLABLE',
      `Resolved target '${target}' is not callable.`,
      { target },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingNotCallableError';
  }
}

export class BindingSchemaInferenceFailedError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(
    target: string,
    moduleId?: string,
    filePath?: string,
    remediation?: string,
    options?: ErrorOptions,
  ) {
    const loc = filePath ? `${filePath}: ` : '';
    const modPart = moduleId ? `binding '${moduleId}' ` : '';
    const rem =
      remediation ??
      'no schema source detected. Provide one of: target input/output as TypeBox schemas, zod schemas, ' +
        'class-validator-decorated DTO, or use the typia adapter. ' +
        'Alternatively specify input_schema/output_schema explicitly.';
    super(
      'BINDING_SCHEMA_INFERENCE_FAILED',
      `${loc}${modPart}auto schema inference failed for target '${target}'. ${rem} See DECLARATIVE_CONFIG_SPEC.md §6`,
      { target, moduleId, filePath },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingSchemaInferenceFailedError';
  }
}

/**
 * Deprecated alias for {@link BindingSchemaInferenceFailedError}.
 * Per DECLARATIVE_CONFIG_SPEC.md §7.1, the canonical name is
 * BindingSchemaInferenceFailedError. Scheduled for removal in 0.20.0;
 * emits a one-shot deprecation warning on first construction.
 *
 * @deprecated Use {@link BindingSchemaInferenceFailedError}.
 */
let _bindingSchemaMissingWarned = false;
export class BindingSchemaMissingError extends BindingSchemaInferenceFailedError {
  constructor(
    target: string,
    moduleId?: string,
    filePath?: string,
    remediation?: string,
    options?: ErrorOptions,
  ) {
    super(target, moduleId, filePath, remediation, options);
    if (!_bindingSchemaMissingWarned) {
      _bindingSchemaMissingWarned = true;
      console.warn(
        '[apcore:errors] BindingSchemaMissingError is deprecated and scheduled for removal in 0.20.0. ' +
          'Use BindingSchemaInferenceFailedError instead (DECLARATIVE_CONFIG_SPEC.md §7.1).',
      );
    }
  }
}

export class BindingSchemaModeConflictError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(moduleId: string, modesListed: string[], filePath?: string, options?: ErrorOptions) {
    const loc = filePath ? `${filePath}: ` : '';
    super(
      'BINDING_SCHEMA_MODE_CONFLICT',
      `${loc}binding '${moduleId}' specifies multiple schema modes (${modesListed.join(', ')}). ` +
        'Choose one. See DECLARATIVE_CONFIG_SPEC.md §3.4',
      { moduleId, modesListed, filePath },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingSchemaModeConflictError';
  }
}

/**
 * Raised when auto_schema: strict is requested but the inferred schema contains
 * features incompatible with strict mode (e.g., `anyOf`, `oneOf`, recursive `$ref`).
 * See DECLARATIVE_CONFIG_SPEC.md §6.2.
 */
export class BindingStrictSchemaIncompatibleError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(
    moduleId: string,
    featuresListed: string[],
    filePath?: string,
    line?: number,
    options?: ErrorOptions,
  ) {
    const loc = filePath ? (line !== undefined ? `${filePath}:${line}: ` : `${filePath}: `) : '';
    super(
      'BINDING_STRICT_SCHEMA_INCOMPATIBLE',
      `${loc}binding '${moduleId}' uses auto_schema: strict but inferred schema ` +
        `contains incompatible features: ${featuresListed.join(', ')}. ` +
        'See DECLARATIVE_CONFIG_SPEC.md §6.2',
      { moduleId, featuresListed, filePath, line },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingStrictSchemaIncompatibleError';
  }
}

/**
 * Raised when a binding entry field violates a configured policy limit
 * (e.g., description exceeds policy.max_description_length).
 * See DECLARATIVE_CONFIG_SPEC.md §7.1 and §9.
 */
export class BindingPolicyViolationError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(
    moduleId: string,
    fieldName: string,
    policyPath: string,
    reason: string,
    limitValue: unknown,
    filePath?: string,
    line?: number,
    options?: ErrorOptions,
  ) {
    const loc = filePath ? (line !== undefined ? `${filePath}:${line}: ` : `${filePath}: `) : '';
    super(
      'BINDING_POLICY_VIOLATION',
      `${loc}binding '${moduleId}' field '${fieldName}' violates policy ` +
        `'${policyPath}': ${reason} (configured limit: ${String(limitValue)}). ` +
        'Adjust the limit in apcore.yaml or shorten the value.',
      { moduleId, fieldName, policyPath, reason, limitValue, filePath, line },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingPolicyViolationError';
  }
}

/**
 * Raised when a function parameter has no type annotation or a forward
 * reference cannot be resolved during auto-schema inference.
 */
export class FuncMissingTypeHintError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(functionName: string, parameterName: string, options?: ErrorOptions) {
    super(
      'FUNC_MISSING_TYPE_HINT',
      `Parameter '${parameterName}' in function '${functionName}' has no type annotation. ` +
        `Add a type hint like '${parameterName}: string'.`,
      { functionName, parameterName },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'FuncMissingTypeHintError';
  }
}

/**
 * Raised when a function has no return type annotation during auto-schema
 * inference.
 */
export class FuncMissingReturnTypeError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(functionName: string, options?: ErrorOptions) {
    super(
      'FUNC_MISSING_RETURN_TYPE',
      `Function '${functionName}' has no return type annotation. Add a return type like ': Promise<Record<string, unknown>>'.`,
      { functionName },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'FuncMissingReturnTypeError';
  }
}

export class BindingFileInvalidError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(filePath: string, reason: string, options?: ErrorOptions) {
    super(
      'BINDING_FILE_INVALID',
      `Invalid binding file '${filePath}': ${reason}`,
      { filePath, reason },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'BindingFileInvalidError';
  }
}

export class CircularDependencyError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(cyclePath: string[], options?: ErrorOptions) {
    super(
      'CIRCULAR_DEPENDENCY',
      `Circular dependency detected: ${cyclePath.join(' -> ')}`,
      { cyclePath },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'CircularDependencyError';
  }
}

export class ModuleLoadError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(moduleId: string, reason: string, options?: ErrorOptions) {
    super(
      'MODULE_LOAD_ERROR',
      `Failed to load module '${moduleId}': ${reason}`,
      { moduleId, reason },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ModuleLoadError';
  }
}

export class DependencyNotFoundError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(moduleId: string, dependencyId: string, options?: ErrorOptions) {
    super(
      'DEPENDENCY_NOT_FOUND',
      `Module '${moduleId}' has unsatisfied required dependency '${dependencyId}'`,
      { moduleId, dependencyId },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        `Module '${moduleId}' declares a required dependency on '${dependencyId}', but no such module is registered. Either register '${dependencyId}' before loading '${moduleId}', mark the dependency as optional, or remove it.`,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'DependencyNotFoundError';
  }
}

export class DependencyVersionMismatchError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(
    moduleId: string,
    dependencyId: string,
    required: string,
    actual: string,
    options?: ErrorOptions,
  ) {
    super(
      'DEPENDENCY_VERSION_MISMATCH',
      `Module '${moduleId}' requires dependency '${dependencyId}' version '${required}', but registered version is '${actual}'`,
      { moduleId, dependencyId, required, actual },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance ??
        `Module '${moduleId}' declares dependency '${dependencyId}' with version constraint '${required}', but the registered version is '${actual}'. Either upgrade the dependency, relax the constraint, or register a compatible version.`,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'DependencyVersionMismatchError';
  }
}

export class ReloadFailedError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = true;

  constructor(moduleId: string, reason: string, options?: ErrorOptions) {
    super(
      'RELOAD_FAILED',
      `Failed to reload module '${moduleId}': ${reason}`,
      { moduleId, reason },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ReloadFailedError';
  }
}

export class ModuleExecuteError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = null;

  constructor(moduleId: string, reason: string, options?: ErrorOptions) {
    super(
      'MODULE_EXECUTE_ERROR',
      `Failed to execute module '${moduleId}': ${reason}`,
      { moduleId, reason },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ModuleExecuteError';
  }
}

export class InternalError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = true;

  constructor(message: string = 'Internal error', options?: ErrorOptions) {
    super(
      'GENERAL_INTERNAL_ERROR',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'InternalError';
  }
}

/**
 * Base error for all approval-related errors.
 * Carries the full ApprovalResult for inspection by callers.
 */
export class ApprovalError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  readonly result: unknown;

  constructor(
    code: string,
    message: string,
    result: unknown,
    moduleId?: string,
    options?: ErrorOptions,
  ) {
    super(
      code,
      message,
      { moduleId: moduleId ?? null },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ApprovalError';
    this.result = result;
  }

  get moduleId(): string | null {
    return this.details['moduleId'] as string | null;
  }

  get reason(): string | null {
    const r = this.result as Record<string, unknown> | null;
    return (r?.['reason'] as string) ?? null;
  }
}

export class ApprovalDeniedError extends ApprovalError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(result: unknown, moduleId: string = '', options?: ErrorOptions) {
    const reason = (result as Record<string, unknown>)?.['reason'] as string | undefined;
    let msg = `Approval denied for module '${moduleId}'`;
    if (reason) {
      msg += `: ${reason}`;
    }
    super('APPROVAL_DENIED', msg, result, moduleId, options);
    this.name = 'ApprovalDeniedError';
  }
}

export class ApprovalTimeoutError extends ApprovalError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = true;

  constructor(result: unknown, moduleId: string = '', options?: ErrorOptions) {
    super(
      'APPROVAL_TIMEOUT',
      `Approval timed out for module '${moduleId}'`,
      result,
      moduleId,
      options,
    );
    this.name = 'ApprovalTimeoutError';
  }
}

export class ApprovalPendingError extends ApprovalError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(result: unknown, moduleId: string = '', options?: ErrorOptions) {
    const approvalId = (result as Record<string, unknown>)?.['approvalId'] as string | undefined;
    super(
      'APPROVAL_PENDING',
      `Approval pending for module '${moduleId}'`,
      result,
      moduleId,
      options,
    );
    this.name = 'ApprovalPendingError';
    this.details['approvalId'] = approvalId ?? null;
  }

  get approvalId(): string | null {
    return this.details['approvalId'] as string | null;
  }
}

export class ConfigNamespaceDuplicateError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(namespace: string, options?: ErrorOptions) {
    super(
      'CONFIG_NAMESPACE_DUPLICATE',
      `Namespace already registered: '${namespace}'`,
      { namespace },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigNamespaceDuplicateError';
  }
}

export class ConfigNamespaceReservedError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(namespace: string, options?: ErrorOptions) {
    super(
      'CONFIG_NAMESPACE_RESERVED',
      `Namespace is reserved and cannot be registered: '${namespace}'`,
      { namespace },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigNamespaceReservedError';
  }
}

export class ConfigEnvPrefixConflictError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(envPrefix: string, options?: ErrorOptions) {
    super(
      'CONFIG_ENV_PREFIX_CONFLICT',
      `Environment variable prefix already in use or reserved: '${envPrefix}'`,
      { envPrefix },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigEnvPrefixConflictError';
  }
}

export class ConfigEnvMapConflictError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(envVar: string, owner: string, options?: ErrorOptions) {
    super(
      'CONFIG_ENV_MAP_CONFLICT',
      `Environment variable '${envVar}' is already mapped by '${owner}'`,
      { envVar, owner },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigEnvMapConflictError';
  }
}

export class ConfigMountError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string, options?: ErrorOptions) {
    super(
      'CONFIG_MOUNT_ERROR',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigMountError';
  }
}

export class ConfigBindError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string, options?: ErrorOptions) {
    super(
      'CONFIG_BIND_ERROR',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigBindError';
  }
}

export class ErrorFormatterDuplicateError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(adapterName: string, options?: ErrorOptions) {
    super(
      'ERROR_FORMATTER_DUPLICATE',
      `Error formatter already registered for adapter: '${adapterName}'`,
      { adapterName },
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ErrorFormatterDuplicateError';
  }
}

/**
 * All framework error codes as constants.
 * Use these instead of hardcoding error code strings.
 */
export const ErrorCodes = Object.freeze({
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NAMESPACE_DUPLICATE: 'CONFIG_NAMESPACE_DUPLICATE',
  CONFIG_NAMESPACE_RESERVED: 'CONFIG_NAMESPACE_RESERVED',
  CONFIG_ENV_PREFIX_CONFLICT: 'CONFIG_ENV_PREFIX_CONFLICT',
  CONFIG_MOUNT_ERROR: 'CONFIG_MOUNT_ERROR',
  CONFIG_BIND_ERROR: 'CONFIG_BIND_ERROR',
  CONFIG_ENV_MAP_CONFLICT: 'CONFIG_ENV_MAP_CONFLICT' as const,
  ERROR_FORMATTER_DUPLICATE: 'ERROR_FORMATTER_DUPLICATE',
  ACL_RULE_ERROR: 'ACL_RULE_ERROR',
  ACL_DENIED: 'ACL_DENIED',
  MODULE_NOT_FOUND: 'MODULE_NOT_FOUND',
  MODULE_DISABLED: 'MODULE_DISABLED',
  MODULE_TIMEOUT: 'MODULE_TIMEOUT',
  MODULE_LOAD_ERROR: 'MODULE_LOAD_ERROR',
  RELOAD_FAILED: 'RELOAD_FAILED',
  EXECUTION_CANCELLED: 'EXECUTION_CANCELLED',
  MODULE_EXECUTE_ERROR: 'MODULE_EXECUTE_ERROR',
  SCHEMA_VALIDATION_ERROR: 'SCHEMA_VALIDATION_ERROR',
  SCHEMA_NOT_FOUND: 'SCHEMA_NOT_FOUND',
  SCHEMA_PARSE_ERROR: 'SCHEMA_PARSE_ERROR',
  SCHEMA_CIRCULAR_REF: 'SCHEMA_CIRCULAR_REF',
  CALL_DEPTH_EXCEEDED: 'CALL_DEPTH_EXCEEDED',
  CIRCULAR_CALL: 'CIRCULAR_CALL',
  CALL_FREQUENCY_EXCEEDED: 'CALL_FREQUENCY_EXCEEDED',
  GENERAL_INVALID_INPUT: 'GENERAL_INVALID_INPUT',
  GENERAL_INTERNAL_ERROR: 'GENERAL_INTERNAL_ERROR',
  FUNC_MISSING_TYPE_HINT: 'FUNC_MISSING_TYPE_HINT',
  FUNC_MISSING_RETURN_TYPE: 'FUNC_MISSING_RETURN_TYPE',
  BINDING_INVALID_TARGET: 'BINDING_INVALID_TARGET',
  BINDING_MODULE_NOT_FOUND: 'BINDING_MODULE_NOT_FOUND',
  BINDING_CALLABLE_NOT_FOUND: 'BINDING_CALLABLE_NOT_FOUND',
  BINDING_NOT_CALLABLE: 'BINDING_NOT_CALLABLE',
  BINDING_SCHEMA_MISSING: 'BINDING_SCHEMA_MISSING',
  BINDING_SCHEMA_INFERENCE_FAILED: 'BINDING_SCHEMA_INFERENCE_FAILED',
  BINDING_SCHEMA_MODE_CONFLICT: 'BINDING_SCHEMA_MODE_CONFLICT',
  BINDING_STRICT_SCHEMA_INCOMPATIBLE: 'BINDING_STRICT_SCHEMA_INCOMPATIBLE',
  BINDING_POLICY_VIOLATION: 'BINDING_POLICY_VIOLATION',
  BINDING_FILE_INVALID: 'BINDING_FILE_INVALID',
  CIRCULAR_DEPENDENCY: 'CIRCULAR_DEPENDENCY',
  MIDDLEWARE_CHAIN_ERROR: 'MIDDLEWARE_CHAIN_ERROR',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  VERSION_INCOMPATIBLE: 'VERSION_INCOMPATIBLE',
  ERROR_CODE_COLLISION: 'ERROR_CODE_COLLISION',
  GENERAL_NOT_IMPLEMENTED: 'GENERAL_NOT_IMPLEMENTED',
  DEPENDENCY_NOT_FOUND: 'DEPENDENCY_NOT_FOUND',
  DEPENDENCY_VERSION_MISMATCH: 'DEPENDENCY_VERSION_MISMATCH',
} as const);

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
