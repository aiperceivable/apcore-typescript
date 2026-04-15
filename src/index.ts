/**
 * apcore - Schema-driven module standard.
 */

// Client
export { APCore } from './client.js';
export type { APCoreOptions, ModuleOptions } from './client.js';

// Core
export { CancelToken, ExecutionCancelledError } from './cancel.js';
export { Context, createIdentity } from './context.js';
export { ContextKey } from './context-key.js';
export {
  TRACING_SPANS,
  TRACING_SAMPLED,
  METRICS_STARTS,
  LOGGING_START,
  REDACTED_OUTPUT,
  RETRY_COUNT_BASE,
} from './context-keys.js';
export type { Identity, ContextFactory } from './context.js';
export { Registry, REGISTRY_EVENTS, MODULE_ID_PATTERN, MAX_MODULE_ID_LENGTH, RESERVED_WORDS } from './registry/registry.js';
export type { Discoverer, ModuleValidator } from './registry/registry.js';
export { Executor, redactSensitive, REDACTED_VALUE, CTX_GLOBAL_DEADLINE, CTX_TRACING_SPANS } from './executor.js';

// Module types
export { DEFAULT_ANNOTATIONS, createAnnotations, annotationsToJSON, annotationsFromJSON, createPreflightResult } from './module.js';
export type { ModuleAnnotations, ModuleExample, ModuleDescription, ValidationResult, PreflightCheckResult, PreflightResult, Module } from './module.js';

// Config
export { Config, discoverConfigFile } from './config.js';

// Error Formatter
export { ErrorFormatterRegistry } from './error-formatter.js';
export type { ErrorFormatter } from './error-formatter.js';

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
  ModuleDisabledError,
  ModuleTimeoutError,
  SchemaValidationError,
  SchemaNotFoundError,
  SchemaParseError,
  SchemaCircularRefError,
  CallDepthExceededError,
  CircularCallError,
  CallFrequencyExceededError,
  InvalidInputError,
  BindingInvalidTargetError,
  BindingModuleNotFoundError,
  BindingCallableNotFoundError,
  BindingNotCallableError,
  BindingSchemaMissingError,
  BindingFileInvalidError,
  CircularDependencyError,
  ModuleLoadError,
  ReloadFailedError,
  ModuleExecuteError,
  InternalError,
  ConfigNamespaceDuplicateError,
  ConfigNamespaceReservedError,
  ConfigEnvPrefixConflictError,
  ConfigEnvMapConflictError,
  ConfigMountError,
  ConfigBindError,
  ErrorFormatterDuplicateError,
  ErrorCodes,
} from './errors.js';
export type { ErrorCode, ErrorOptions } from './errors.js';

// ACL
export { ACL } from './acl.js';
export type { ACLRule, AuditEntry, AuditLogger } from './acl.js';

// Middleware
export { Middleware, MiddlewareManager, MiddlewareChainError, BeforeMiddleware, AfterMiddleware, LoggingMiddleware, RetryMiddleware, ErrorHistoryMiddleware, PlatformNotifyMiddleware } from './middleware/index.js';
export type { RetryConfig } from './middleware/index.js';

// Decorator
export { module, FunctionModule } from './decorator.js';

// Extensions
export { ExtensionManager } from './extensions.js';
export type { ExtensionPoint } from './extensions.js';

// Events
export { EventEmitter, createEvent, WebhookSubscriber, A2ASubscriber } from './events/index.js';
export type { ApCoreEvent, EventSubscriber } from './events/index.js';

// System Modules
export {
  registerSysModules,
  registerSubscriberType,
  unregisterSubscriberType,
  resetSubscriberRegistry,
  ToggleState,
  DEFAULT_TOGGLE_STATE,
  isModuleDisabled,
  checkModuleDisabled,
  classifyHealthStatus,
  UpdateConfigModule, // public: sys-module class needed for custom registration
} from './sys-modules/index.js';
export type { SysModulesContext } from './sys-modules/index.js';

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
export { toStrictSchema } from './schema/strict.js';

// Registry types
export type { ModuleDescriptor, DiscoveredModule, DependencyInfo } from './registry/types.js';

// Registry conflicts
export { detectIdConflicts } from './registry/conflicts.js';
export type { ConflictResult, ConflictType, ConflictSeverity } from './registry/conflicts.js';

// Observability
export { TracingMiddleware, StdoutExporter, InMemoryExporter, OTLPExporter, createSpan } from './observability/tracing.js';
export type { Span, SpanExporter } from './observability/tracing.js';
export { MetricsCollector, MetricsMiddleware } from './observability/metrics.js';
export { ContextLogger, ObsLoggingMiddleware } from './observability/context-logger.js';
export { ErrorHistory } from './observability/error-history.js';
export type { ErrorEntry } from './observability/error-history.js';
export { UsageCollector, UsageMiddleware } from './observability/usage.js';
export { computeModuleErrorRate, estimateP99FromHistogram, matchesModuleId, METRIC_CALLS_TOTAL, METRIC_DURATION_SECONDS } from './observability/metrics-utils.js';
export type { UsageRecord, CallerUsageSummary, HourlyBucket, ModuleUsageSummary, ModuleUsageDetail } from './observability/usage.js';

// Trace Context
export { TraceContext } from './trace-context.js';
export type { TraceParent } from './trace-context.js';

// Pipeline
export { ExecutionStrategy, PipelineEngine, PipelineAbortError, StepNotFoundError, StepNotRemovableError, StepNotReplaceableError, StepNameDuplicateError, StrategyNotFoundError } from './pipeline.js';
export type { Step, StepResult, PipelineContext, StepTrace, PipelineTrace, StrategyInfo } from './pipeline.js';

// Built-in Steps
export {
  BuiltinContextCreation,
  BuiltinCallChainGuard,
  BuiltinModuleLookup,
  BuiltinACLCheck,
  BuiltinApprovalGate,
  BuiltinInputValidation,
  BuiltinMiddlewareBefore,
  BuiltinExecute,
  BuiltinOutputValidation,
  BuiltinMiddlewareAfter,
  BuiltinReturnResult,
  buildStandardStrategy,
  buildInternalStrategy,
  buildTestingStrategy,
  buildPerformanceStrategy,
  buildMinimalStrategy,
} from './builtin-steps.js';
export type { StandardStrategyDeps } from './builtin-steps.js';

// Pipeline Configuration
export { registerStepType, unregisterStepType, registeredStepTypes, buildStrategyFromConfig } from './pipeline-config.js';

export { VERSION } from './generated/version.js';
