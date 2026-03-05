/**
 * apcore - Schema-driven module development framework.
 */

// Core
export { CancelToken, ExecutionCancelledError } from './cancel.js';
export { Context, createIdentity } from './context.js';
export type { Identity, ContextFactory } from './context.js';
export { Registry, REGISTRY_EVENTS, MODULE_ID_PATTERN, MAX_MODULE_ID_LENGTH, RESERVED_WORDS } from './registry/registry.js';
export type { Discoverer, ModuleValidator } from './registry/registry.js';
export { Executor, redactSensitive, REDACTED_VALUE } from './executor.js';

// Module types
export { DEFAULT_ANNOTATIONS } from './module.js';
export type { ModuleAnnotations, ModuleExample, ValidationResult, Module } from './module.js';

// Config
export { Config } from './config.js';

// Approval
export {
  createApprovalRequest,
  createApprovalResult,
  AlwaysDenyHandler,
  AutoApproveHandler,
  CallbackApprovalHandler,
} from './approval.js';
export type { ApprovalRequest, ApprovalResult, ApprovalHandler } from './approval.js';

// Errors
export {
  ModuleError,
  ConfigNotFoundError,
  ConfigError,
  ACLRuleError,
  ACLDeniedError,
  ApprovalError,
  ApprovalDeniedError,
  ApprovalTimeoutError,
  ApprovalPendingError,
  ModuleNotFoundError,
  ModuleTimeoutError,
  SchemaValidationError,
  SchemaNotFoundError,
  SchemaParseError,
  SchemaCircularRefError,
  CallDepthExceededError,
  CircularCallError,
  CallFrequencyExceededError,
  InvalidInputError,
  FuncMissingTypeHintError,
  FuncMissingReturnTypeError,
  BindingInvalidTargetError,
  BindingModuleNotFoundError,
  BindingCallableNotFoundError,
  BindingNotCallableError,
  BindingSchemaMissingError,
  BindingFileInvalidError,
  CircularDependencyError,
  ModuleLoadError,
  ModuleExecuteError,
  InternalError,
  ErrorCodes,
} from './errors.js';
export type { ErrorCode, ErrorOptions } from './errors.js';

// ACL
export { ACL } from './acl.js';
export type { ACLRule, AuditEntry, AuditLogger } from './acl.js';

// Middleware
export { Middleware, MiddlewareManager, MiddlewareChainError, BeforeMiddleware, AfterMiddleware, LoggingMiddleware, RetryMiddleware } from './middleware/index.js';
export type { RetryConfig } from './middleware/index.js';

// Decorator
export { module, FunctionModule, normalizeResult, makeAutoId } from './decorator.js';

// Extensions
export { ExtensionManager } from './extensions.js';
export type { ExtensionPoint } from './extensions.js';

// Async tasks
export { AsyncTaskManager, TaskStatus } from './async-task.js';
export type { TaskInfo } from './async-task.js';

// Bindings
export { BindingLoader } from './bindings.js';

// Utils
export { matchPattern, calculateSpecificity } from './utils/pattern.js';
export { normalizeToCanonicalId } from './utils/normalize.js';
export { guardCallChain, DEFAULT_MAX_CALL_DEPTH, DEFAULT_MAX_MODULE_REPEAT } from './utils/call-chain.js';
export { propagateError } from './utils/error-propagation.js';

// Error Code Registry
export { ErrorCodeRegistry, ErrorCodeCollisionError, FRAMEWORK_ERROR_CODE_PREFIXES } from './error-code-registry.js';

// Version
export { negotiateVersion, VersionIncompatibleError } from './version.js';

// Schema
export { SchemaLoader, jsonSchemaToTypeBox } from './schema/loader.js';
export { SchemaValidator } from './schema/validator.js';
export { SchemaExporter } from './schema/exporter.js';
export { SchemaStrategy, ExportProfile } from './schema/types.js';
export type { SchemaDefinition, ResolvedSchema, SchemaValidationErrorDetail, SchemaValidationResult } from './schema/types.js';
export { RefResolver } from './schema/ref-resolver.js';
export { toStrictSchema, applyLlmDescriptions, stripExtensions } from './schema/strict.js';

// Registry types
export type { ModuleDescriptor, DiscoveredModule, DependencyInfo } from './registry/types.js';

// Observability
export { TracingMiddleware, StdoutExporter, InMemoryExporter, OTLPExporter, createSpan } from './observability/tracing.js';
export type { Span, SpanExporter } from './observability/tracing.js';
export { MetricsCollector, MetricsMiddleware } from './observability/metrics.js';
export { ContextLogger, ObsLoggingMiddleware } from './observability/context-logger.js';

// Trace Context
export { TraceContext } from './trace-context.js';
export type { TraceParent } from './trace-context.js';

export const VERSION = '0.8.0';
