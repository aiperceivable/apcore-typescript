# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

## [0.21.0] - 2026-05-06

Aligns apcore-typescript with PROTOCOL_SPEC.md v0.21.0 (apcore commit
[`c191b85`](https://github.com/aiperceivable/apcore/commit/c191b85) — RFC
`docs/spec/rfc-ephemeral-modules.md` promoted to `Accepted`). Mirrors the
[apcore-python PR #26](https://github.com/aiperceivable/apcore-python/pull/26)
reference implementation.

### Added

- **`ephemeral.*` namespace reservation (PROTOCOL_SPEC §2.5 / RFC
  `rfc-ephemeral-modules`).** New exported constant
  `EPHEMERAL_NAMESPACE_PREFIX = "ephemeral."` and `isEphemeralModuleId(id)`
  helper. Filesystem discovery (`Registry._discoverDefault` /
  `Registry._discoverCustom`) rejects any module ID falling under the
  `ephemeral.*` namespace — the default-discoverer raises `InvalidInputError`
  with a message pointing the caller to `Registry.register()`, the custom
  discoverer skips the entry with a `console.warn`. The namespace is reserved
  for programmatically-registered modules synthesized at runtime
  (Agent-synthesized tools, on-the-fly composition).
- **`ModuleAnnotations.discoverable: boolean` (PROTOCOL_SPEC §4.4).**
  Defaults to `true`; declared optional on the interface so v0.20.x
  callers building literals keep compiling. When set to `false` the
  module is hidden from `Registry.list()`, `Registry.iter()`, and
  `Registry.moduleIds` — but remains callable by exact ID through
  `get()` / `has()` / `Executor.execute()`. Pass
  `Registry.list({ includeHidden: true })` (or
  `iter({ includeHidden: true })`) to enumerate every registered module
  (mirrors apcore-python's `include_hidden` kwarg). `ephemeral.*` modules
  SHOULD set `discoverable: false`.
- **Audit-event single-emit rule for `ephemeral.*` registrations.** New
  `Registry.setEventEmitter(emitter)` wires an `EventEmitter` onto the
  registry; ephemeral.* `register()` / `unregister()` calls emit exactly
  one canonical `apcore.registry.module_registered` /
  `apcore.registry.module_unregistered` event with the D-35 contextual
  payload (`caller_id` defaulting to `"@external"`, `identity` snapshot,
  `namespace_class: "ephemeral"`). The bridge in
  `sys-modules/registration.ts` short-circuits on `ephemeral.*` IDs so
  the empty-payload bridge emit does not double-fire — one registration,
  one event. Non-ephemeral modules retain the existing empty-payload
  bridge behavior verbatim.
- **`Registry.register()` / `Registry.unregister()` accept an optional
  `{ context?: Context | null }` argument** (5th positional / 2nd
  positional respectively). Forwards `Context.callerId` and
  `Context.identity` into the ephemeral.* audit-event payload. Ignored
  for non-ephemeral modules.
- **Soft-warning when an `ephemeral.*` module is registered without
  `requiresApproval: true`.** `Registry.register()` emits
  `console.warn(...)` per the RFC ("agent-synthesized modules SHOULD
  declare `requires_approval: true` so a human gates execution"). The
  registry never refuses the registration — warning only.
- **`Registry.registerInternal()` rejects `ephemeral.*` IDs.** Throws
  `InvalidInputError` with a clear pointer to `Registry.register()`.
  Per the RFC's "register_internal() interaction" rule, namespace
  prefix → registration mechanism is a 1:1 mapping: `system.*` only
  via `registerInternal()`, `ephemeral.*` only via `register()`. Mixing
  the two backdoors blurs the audit-trail distinction between
  framework-emitted (`system.*`) and caller-emitted (`ephemeral.*`)
  modules.
- **PreflightResult.predictedChanges finalized
  ([#29](https://github.com/aiperceivable/apcore-typescript/pull/29)).**
  Stage 2 of the v0.21.0 alignment, shipped to `main` ahead of this
  release: the optional `predictedChanges?: Change[]` field on
  `PreflightResult` plus the `Module.preview()` method, the `Change` /
  `PreviewResult` types, and the TypeBox `TChange` / `TPreviewResult`
  schemas (with `Type.Unsafe` + `patternProperties` for `x-*` extension
  keys per [iter-11]). v0.21.0 finalizes this surface alongside the
  Stage 3 ephemeral pilot.
- 21 new tests covering namespace reservation, filesystem-discovery
  rejection, `discoverable` filter on `list` / `iter` / `moduleIds`,
  audit-event single-emit, soft-warn on missing `requiresApproval`, and
  `registerInternal` rejection (`tests/registry/test-ephemeral-namespace.test.ts`).

### Changed

- **`Registry.discoverMultiClass` signature cleanup
  ([#28](https://github.com/aiperceivable/apcore-typescript/pull/30) /
  apcore decision-log D-06).** Already on `main` ahead of this release.
  The 4th `multiClassEnabled` argument is dropped from the canonical
  method surface; the method is now
  `discoverMultiClass(filePath, classes, extensionsRoot?)`. Per-class
  opt-in via `ClassDescriptor.multiClass?: boolean` is the sole source
  of truth — when at least one qualifying class sets `multiClass: true`,
  the discovery routine derives a distinct module ID per class;
  otherwise whole-file mode applies. Mirrors apcore commit
  [`973410b`](https://github.com/aiperceivable/apcore/commit/973410b).
  - **DEPRECATION** — the legacy 4-arg overload
    `discoverMultiClass(filePath, classes, extensionsRoot, multiClassEnabled)`
    is retained with a one-shot `console.warn` and is **functionally
    inert**. Removal scheduled for **v0.22.0**. Migration: drop the
    boolean and mark each `ClassDescriptor` with `multiClass: true`.
  - The free function `discoverMultiClass(...)` re-exported from
    `apcore-js/registry` keeps its existing 4-arg shape for internal
    callers and is unchanged.
- **`RESERVED_WORDS` unchanged.** The `ephemeral` segment is intentionally
  **not** added to `RESERVED_WORDS` because that set is consulted by
  `_validateModuleId` to *reject* IDs whose first segment matches; adding
  `ephemeral` there would block the very registration path the spec
  prescribes. The reservation is enforced through the discovery-path
  rejection and `registerInternal` rejection paths instead. Mirrors
  apcore-python's `RESERVED_WORDS` frozenset.
- Conformance test runner is **pilot-tolerant** for the rollout window —
  when `expected_serialized` / `expected_reserialized` lacks the
  `discoverable` field (the canonical fixture has not yet been updated
  per the RFC's "Conformance plan / Transitional fixture handling"), the
  field is stripped from the actual serialized output before equality
  comparison. Mirrors the apcore-python PR #26 pattern; will be removed
  once the synchronized `conformance/fixtures/annotations_extra_round_trip.json`
  update lands.

### Lifecycle

- **Caller-managed.** `ephemeral.*` modules live until the caller
  explicitly calls `Registry.unregister(moduleId)`. There is no TTL
  sweeper or background GC — TTL-driven cleanup is deferred to a v2
  follow-up if leakage is observed in practice.

## [0.20.0] - 2026-05-05

### Changed

- **Issue #28 — `Registry.discoverMultiClass` signature cleanup (apcore decision-log D-06).** The 4th `multiClassEnabled` argument is dropped from the canonical method surface; the method is now `discoverMultiClass(filePath, classes, extensionsRoot?)`. Per-class opt-in via the new `ClassDescriptor.multiClass?: boolean` field is the sole source of truth — when at least one qualifying class sets `multiClass: true`, the discovery routine derives a distinct module ID per class; otherwise whole-file mode applies. Mirrors the upstream apcore doc-side cleanup in commit [`973410b`](https://github.com/aiperceivable/apcore/commit/973410b) which removed the dead global `extensions.multi_class_discovery` config toggle.
  - **DEPRECATION:** the legacy 4-arg overload `discoverMultiClass(filePath, classes, extensionsRoot, multiClassEnabled)` is retained for backward compatibility and emits a one-shot `console.warn` deprecation notice on first use. The `multiClassEnabled` argument is **functionally inert** — the per-class `multiClass` field is read regardless of what is passed. The 4-arg overload will be removed in **v0.22.0**. Migration: drop the boolean and mark each `ClassDescriptor` you want as a separate module with `multiClass: true`.
  - The free function `discoverMultiClass(...)` re-exported from `apcore-js/registry` keeps its existing 4-arg shape for internal callers and is unchanged.

## [0.20.0] - 2026-05-05

### Added

#### Pipeline Hardening (Issue #33)

- **`StepMiddleware` interface** (Issue #33 §2.2) — Public interface in `src/pipeline.ts` exposing optional `beforeStep` / `afterStep` / `onStepError` hooks around every pipeline step. Hooks may be sync or async; the engine awaits any thenable return value (mirroring the Issue #42 fix in `MiddlewareManager`) so plain functions returning a Promise are not silently dropped. `onStepError` returning a non-null value suppresses the error and continues the pipeline — first non-null wins, later middlewares are skipped. Multiple middlewares run in registration order.
- **`PipelineEngine.addStepMiddleware(mw)`** and **`PipelineEngine.stepMiddlewares`** — Register lifecycle interceptors on the engine. Backward-compatible: pipelines with zero middlewares behave exactly as before.
- **`PipelineDependencyError`** — New error raised at `ExecutionStrategy` construction when a step's `requires` are not satisfied by a preceding step's `provides` (Issue #33 §2.1). Replaces the previous `console.warn` that allowed misconfigured strategies to fail later with a confusing runtime error. Carries `stepName` and `missingRequires` for programmatic inspection.
- **`ExecutionStrategy` constructor `seedProvides` option** — Lets callers building a sub-strategy (e.g. `Executor.stream()`'s post-stream phase) declare context fields that are guaranteed to be pre-populated, so dependency validation does not raise on legitimate use.
- **`ConfigurationError`** — New error raised by `buildStrategyFromConfig()` when YAML pipeline configuration references a non-existent step in `remove`, `configure`, `after`, or `before`, or when a custom step has neither `after` nor `before` (Issue #33 §1.2). Replaces the previous warn-and-continue behaviour. Exported from `apcore-js` for typed catches.
- **Issue #43 §1 — `StorageBackend` interface** (`src/observability/storage.ts`). Pluggable key/value storage with `save` / `get` / `list` / `delete` operations and namespace partitioning. Default `InMemoryStorageBackend` is the implicit fallback. `ErrorHistory`, `UsageCollector`, and `MetricsCollector` accept an optional `storage` constructor option so SDK consumers can wire redis, postgres, etc. without forking the collectors. Re-exported from the package root.
- **Issue #45.1 — `OverridesStore` interface** (`src/sys-modules/overrides.ts`). Pluggable persistent override store mirroring the Python `_load_overrides` / `_write_overrides` and Rust `load_overrides` / `write_override` flows. `FileOverridesStore` writes a YAML file with atomic tempfile + rename semantics; `InMemoryOverridesStore` is provided for tests. `registerSysModules` accepts `overridesStore` and applies persisted overrides on startup before registering modules. `UpdateConfigModule` and `ToggleFeatureModule` persist each successful mutation through the store. Re-exported from the package root.
- **D-15 — `Registry.discoverMultiClass` method.** New instance method on `Registry` matching the Python `Registry.discover_multi_class` and Rust trait surface. Wraps the existing free function (now also re-exported as `_discoverMultiClass` for internal scanner use) so cross-language code can call `registry.discoverMultiClass(filePath, classes, ...)` consistently.
- Granular reload via `path_filter` input in `ReloadModule` (#45.4). Supports glob-pattern bulk reload that scopes safe-unregister + re-discovery to matching module IDs and returns a `reloaded_modules` array.
- Error fingerprinting in `ErrorHistory` — dedup by `(error_code, module_id, normalized_message)` SHA-256 with UUID/ISO-timestamp/integer-ID placeholders, exported as `computeFingerprint` and `normalizeMessage` (#43 §4).
- Configurable redaction via `observability.redaction.field_patterns` / `observability.redaction.value_patterns` / `observability.redaction.replacement` Config keys, plus `RedactionConfig.fromConfig(config)` and exported `DEFAULT_REDACTION_FIELD_PATTERNS` (`_secret_*`, `apiKey`, `api_key`, `token`, `authorization`, `password`, `passwd`, `secret`). Value patterns compile case-insensitively (#43 §5).
- **Sync finding D-08 — `RetryConfig.computeDelayMs`** is the canonical cross-language method name on `RetryConfig` (mirrors apcore-python `compute_delay_ms` / apcore-rust `compute_delay_ms`). The legacy `computeDelay` alias still works but emits a one-shot deprecation warning per process (`[apcore] RetryConfig.computeDelay is deprecated; use computeDelayMs`) and will be removed in the next minor release.
- **Sync finding CRITICAL #4 — canonical `obs.redaction.*` Config keys.** `RedactionConfig.fromConfig` now reads `obs.redaction.sensitive_keys`, `obs.redaction.regex_patterns`, and `obs.redaction.replacement` first (matching apcore-python / apcore-rust) and falls back to the legacy `observability.redaction.field_patterns` / `observability.redaction.value_patterns` / `observability.redaction.replacement` keys for backwards compatibility. Reading any legacy key emits a one-shot deprecation warning pointing migrators at the canonical namespace.

### Changed

- `ExecutionStrategy._validateDependencies` now throws `PipelineDependencyError` instead of emitting `console.warn`. Strategies that declared unsatisfied `requires` will now fail to construct — fix the strategy or use the new `seedProvides` option.
- `buildStrategyFromConfig()` now throws `ConfigurationError` instead of emitting `console.warn` for missing-step / missing-anchor / missing-after-or-before configuration mistakes.

### Fixed

- Async middleware hooks (`before` / `after` / `onError`) — `MiddlewareManager` now awaits the *return value* (already implemented) and `Middleware` base method signatures admit Promise-of-X return types, so higher-order-function-wrapped (Promise-returning) handlers compose without leaking unresolved Promises into `currentInputs` / `currentOutput` / recovery values (#42).
- **Sync findings A-D-101 / A-D-102** — `Registry._registerInOrder` and `Registry._discoverCustom` now apply PROTOCOL_SPEC §2.7 ID validation (empty → pattern → length → reserved-word) and Algorithm A03 conflict detection before registering each discovered module. Invalid or conflicting IDs are skipped with a `console.warn` instead of being registered. Mirrors `apcore-python._filter_id_conflicts` and `apcore-rust::Registry::filter_id_conflicts`.
- **Sync finding A-D-202** — `Executor.stream()` now reads the global deadline from `context.data[CTX_GLOBAL_DEADLINE]` (ms-since-epoch, where `BuiltinContextCreation` writes it) and compares against `Date.now()` directly, instead of reading the unset `Context.globalDeadline` field and dividing `Date.now()` by 1000. Stream-mode global timeout now actually triggers between chunks.
- **Sync finding A-D-404** — `MiddlewareManager.executeOnError` now requires recovery values to be a `RetrySignal` or a non-null object before treating them as recovery. Arrow functions returning `undefined` (the default for handlers without an explicit return) no longer accidentally short-circuit the chain. Mirrors apcore-python's strict type check.

### Changed

- **Issue #36 — canonical event prefixes** — Four registry/health events that previously lacked the canonical `apcore.<subsystem>.<event>` prefix are now emitted under their canonical names: `module_registered` → `apcore.registry.module_registered`, `module_unregistered` → `apcore.registry.module_unregistered`, `error_threshold_exceeded` → `apcore.health.error_threshold_exceeded`, `latency_threshold_exceeded` → `apcore.health.latency_threshold_exceeded`. **DEPRECATION:** during the deprecation window each emission also produces the legacy event with `{ deprecated: true, canonical_event: <canonical> }` in its payload, so existing subscribers continue to receive events. Migrate subscribers to the canonical names; the legacy aliases will be removed in a future release. New helper `emitWithLegacy()` is exported from `apcore-js/events`.
- **Issue #45.2 — contextual audit identity** — `system.control.update_config`, `system.control.toggle_feature` and `system.control.reload_module` now extract `caller_id` (defaulting to `"@external"` when absent) and `identity` (a snapshot of `Context.identity` or `null`) from the execution `Context` and include both fields in the `apcore.config.updated`, `apcore.module.toggled`, and `apcore.module.reloaded` event payloads. New helper `extractAuditIdentity()` is exported from `apcore-js/sys-modules/audit`.
- **Sync finding A-D-104** — `Registry.watch()` is now documented as event-only on the TypeScript SDK. On a file change the module is unregistered (`onUnload` runs) and a `file_changed` event is emitted with `{ filePath }`. Unlike apcore-python (`importlib.reload`) and apcore-rust (full re-discovery), the SDK does not transparently re-import: ES modules cannot be reliably evicted from Node's loader cache without leaks. Consumers needing hot-reload must subscribe to `file_changed` and call `discover()` (or re-import) themselves. See JSDoc on `Registry.watch`.
- **Sync findings A-D-503 / A-D-504** — `EventEmitter.flush(timeoutMs)` default changes from `0` (infinite wait) to `5000` (5 s), matching apcore-python's 5 s semantic default and apcore-rust's ms unit. Pass `0` explicitly to wait indefinitely. Subscriber overflow behaviour switches from drop-and-warn to bounded back-pressure: when `_pending` is at `maxPending`, new dispatches queue and start as slots free, so events are no longer silently dropped under burst load.
- **Sync finding A-D-403** — `MiddlewareManager.executeBefore` / `executeAfter` / `executeOnError` are now `async` and `await` each middleware hook. Removes the silent-Promise-into-currentInputs trap when a `before()` or `after()` hook is async. Public callers in `Executor` and built-in steps already awaited; ad-hoc consumers calling these methods directly now need to `await` the result.

### Documentation

- **Sync finding B-002** — README now documents that `APCore.disable()` / `APCore.enable()` (and the `on`/`off` toggle event) require `sys_modules.enabled: true` in the `Config` passed to `APCore`. Quick Start gains a Config-passing variant that wires sys-modules.

### Added — PROTOCOL_SPEC hardening (Issues #32–#45)

#### Event Management Hardening (Issue #36)

- **`CircuitBreakerWrapper`** — Subscriber-level circuit breaker for `EventEmitter` with configurable failure threshold, timeout (backoff), and automatic OPEN → HALF_OPEN → CLOSED recovery. Exported from `apcore-js/events`.
- **`CircuitState`** enum — `CLOSED`, `OPEN`, `HALF_OPEN` states for `CircuitBreakerWrapper`.
- **`FileSubscriber`** — Event subscriber that appends to a log file with optional rotation (`rotate_bytes`) and format (`json`/`text`). Registered as built-in type `"file"` in the subscriber factory.
- **`StdoutSubscriber`** — Event subscriber that writes to stdout with optional level filtering. Registered as built-in type `"stdout"`.
- **`FilterSubscriber`** — Decorator subscriber filtering events by `include_events`/`exclude_events` lists. Registered as built-in type `"filter"`, accepting any `delegate_type`.
- `registerSubscriberType` / `unregisterSubscriberType` / `resetSubscriberRegistry` / `createSubscriberFromConfig` — now public, documented, and no longer marked deprecated. Custom subscriber types can be registered and used in config-driven instantiation.

#### Middleware Architecture Hardening (Issue #42)

- **`CircuitBreakerMiddleware`** — Per-`(module_id, caller_id)` circuit breaker middleware. Opens on consecutive failures beyond a configurable threshold; enters HALF_OPEN after cooldown; probes with one request and closes on success. Throws `CircuitBreakerOpenError` (code `CIRCUIT_BREAKER_OPEN`) when open.
- **`CircuitBreakerOpenError`** (code `CIRCUIT_BREAKER_OPEN`) — new error class; `DEFAULT_RETRYABLE = false`. Carries `moduleId` and `callerId` details.
- **`MiddlewareCircuitState`** enum — `CLOSED`, `OPEN`, `HALF_OPEN` states for `CircuitBreakerMiddleware`.
- **`validateContextKey()`** — validates that a context key string is non-empty and does not collide with apcore reserved keys.
- **`ContextKeyWriter`** / **`ContextKeyValidation`** interfaces — typed context-key contract for middleware that writes into execution context.
- **`TracingMiddleware`** — OTel-compatible span tracing middleware. Accepts any tracer implementing the `OtelTracer` / `OtelSpan` interfaces. Configurable via `TracingMiddlewareOptions` (sampler, span name builder, attribute extractor). Does not depend on `@opentelemetry/*` packages at runtime.
- **`isAsyncHandler()`** utility — detects whether a middleware method returns a `Promise`.

#### Observability Hardening (Issue #43)

- **`BatchSpanProcessor`** — Buffered async span exporter with configurable `maxQueueSize`, `scheduleDelayMs`, `maxExportBatchSize`. Drops spans when queue is full and tracks `spansDropped`. Exported `BatchSpanProcessorOptions`.
- **`SimpleSpanProcessor`** — Synchronous pass-through processor for testing.
- **`InMemoryObservabilityStore`** — Default pluggable backing store for `ErrorHistory` and `MetricsCollector`. Implements `ObservabilityStore` interface (`record`, `query`, `count`, `clear`).
- **`ObservabilityStore`** interface + **`MetricPoint`** type — public contracts for custom store implementations.
- **`RedactionConfig`** — Field-pattern and value-pattern based input redaction for `ContextLogger`/`ObsLoggingMiddleware`. Configurable `fieldPatterns` (glob), `valuePatterns` (RegExp), and `replacement` string.
- **`PrometheusExporter`** — HTTP server serving Prometheus text format at `/metrics`, liveness at `/healthz`, and readiness at `/readyz`. New optional `usageCollector` constructor option enables usage metrics (see System Modules Hardening below).
- `ErrorHistory` constructor now accepts an options object `{ maxEntriesPerModule?, maxTotalEntries? }` (positional args still accepted for backward compatibility).
- `MetricsCollector` constructor now accepts `MetricsCollectorOptions { buckets?, store? }` in addition to positional args.

#### Registry — Multi-Class Discovery

- **`discoverMultiClass(filePath, options?)`** — discovers multiple module classes from a single file by PascalCase-to-dotted-id naming convention.
- **`classNameToSegment(className)`** — converts a PascalCase class name to a lowercase dotted-id segment.
- **`ModuleIdConflictError`** (code `MODULE_ID_CONFLICT`) — thrown when two classes in the same file produce the same module ID segment.
- **`InvalidSegmentError`** (code `INVALID_SEGMENT`) — thrown when a derived segment does not match `^[a-z][a-z0-9_]*$`.
- **`IdTooLongError`** (code `ID_TOO_LONG`) — thrown when a derived module ID exceeds 192 characters.

#### Async Task Evolution

- **`InMemoryTaskStore`** — default in-memory `TaskStore` implementation, now injectable via `AsyncTaskManager({ executor, store })` for custom backends (Redis, Postgres, etc.). Implements `TaskStore` interface.
- **`RetryConfig`** — configurable retry policy with `maxRetries`, `retryDelayMs`, `backoffMultiplier`, `maxRetryDelayMs`, and `computeDelay(attemptIndex)` for exponential backoff with jitter. Pass to `manager.submit(moduleId, inputs, { retry })`.
- **`AsyncTaskManager.startReaper({ ttlSeconds, sweepIntervalMs })`** — starts a background reaper that deletes expired completed/failed tasks after `ttlSeconds`. Returns a `{ stop() }` handle. Reaper is opt-in; the manager remains zero-dependency when no reaper is configured. Skips `RUNNING` tasks regardless of age.

#### System Modules Hardening (Issue #45)

- **`AuditStore`** interface with `append(entry)` / `query(filter?)` — pluggable audit log for control module actions. Exported from `apcore-js`.
- **`InMemoryAuditStore`** — default in-memory implementation of `AuditStore`. Supports filtering by `moduleId`, `actorId`, and `since` timestamp.
- **`AuditEntry`** type — `{ timestamp, action, targetModuleId, actorId, actorType, traceId, change: { before, after } }`. Actor is extracted from `context.identity`.
- **`buildAuditEntry(action, targetModuleId, context, change)`** — helper that extracts actor information from `Context.identity`.
- **`registerSysModules()`** now accepts an optional 5th `options` parameter (`RegisterSysModulesOptions`):
  - `overridesPath?: string` — YAML file for persisting `update_config` and `toggle_feature` changes. Loaded on startup after base config so overrides survive restarts without modifying the base config file.
  - `auditStore?: AuditStore` — routes all control module audit entries to the store; falls back to `console.warn` when absent.
  - `failOnError?: boolean` (default `false`) — when `true`, first registration failure throws `SysModuleRegistrationError` immediately; when `false`, logs at ERROR level and continues registering remaining modules.
- **`system.control.reload_module`** — new `path_filter: string` input field. When provided, reloads all registered modules whose IDs match the glob pattern, in topological (sorted) order. Mutually exclusive with `module_id`.
- **`system.control.update_config`** / **`system.control.toggle_feature`** — now record a structured `AuditEntry` (actor, timestamp, trace ID, before/after change) when an `AuditStore` is configured; otherwise logs at INFO/WARN level.
- **`PrometheusExporter`** — `usageCollector?: UsageCollector` constructor option. When set, appends usage metrics to `/metrics` output: `apcore_usage_calls_total{module_id, status}` (counter), `apcore_usage_error_rate{module_id}` (gauge), `apcore_usage_p50_latency_ms{module_id}`, `apcore_usage_p95_latency_ms{module_id}`, `apcore_usage_p99_latency_ms{module_id}` (gauges). Prometheus text format is valid (HELP/TYPE lines immediately precede each metric family).
- **`ModuleReloadConflictError`** (code `MODULE_RELOAD_CONFLICT`) — thrown when both `module_id` and `path_filter` are supplied to `system.control.reload_module`.
- **`SysModuleRegistrationError`** (code `SYS_MODULE_REGISTRATION_FAILED`) — thrown by `registerSysModules()` when `failOnError: true` and any system module fails to register.

### Changed — PROTOCOL_SPEC hardening (Issue #45)

- **`registerSysModules()`** 5th parameter changed from (none) to optional `RegisterSysModulesOptions`. Fully backward-compatible — existing calls with 3–4 arguments are unaffected.
- **`UpdateConfigModule`** constructor now accepts optional `UpdateConfigOptions { auditStore?, overridesPath? }` as third argument. Existing two-argument construction is unchanged.
- **`ReloadModule`** constructor now accepts optional `auditStore?: AuditStore` as third argument.
- **`ToggleFeatureModule`** constructor now accepts optional `auditStore?: AuditStore` as fourth argument (after the existing optional `toggleState`).
- **`ReloadModule` input schema** — `module_id` is no longer statically `required`; validation is enforced at runtime to support mutual exclusion with `path_filter`. Callers that previously relied on schema-level rejection of missing `module_id` will now receive the same `InvalidInputError` from runtime validation.
- **`system.control.toggle_feature`** now emits an `[apcore:control]` INFO-level log on every toggle, consistent with `update_config` and `reload_module`.
- **`ErrorCodes`** — added `MODULE_RELOAD_CONFLICT`, `SYS_MODULE_REGISTRATION_FAILED`, `MODULE_ID_CONFLICT`, `INVALID_SEGMENT`, `ID_TOO_LONG`, `CIRCUIT_BREAKER_OPEN`.

---

## [0.19.0] - 2026-04-19

### Added

- **`DependencyNotFoundError`** (error code `DEPENDENCY_NOT_FOUND`) — thrown by `resolveDependencies` when a module's required dependency is not registered. Aligns TypeScript with PROTOCOL_SPEC §5.15.2 which has always mandated this error code. Details include `moduleId` and `dependencyId`. Exported from `apcore`.
- **`DependencyVersionMismatchError`** (error code `DEPENDENCY_VERSION_MISMATCH`) — thrown by `resolveDependencies` when a declared `version` constraint is not satisfied by the registered version of the target module. Details include `moduleId`, `dependencyId`, `required`, `actual`. Exported from `apcore`.
- **`resolveDependencies(modules, knownIds, moduleVersions)`** — new optional third argument accepting `Map<string, string>` or `Record<string, string>` mapping module id → version. When provided, declared dependency version constraints are enforced per PROTOCOL_SPEC §5.3. When absent, the `DependencyInfo.version` field is silently ignored. `ModuleRegistry._resolveLoadOrder` now populates this map from YAML version / class `version` / `"1.0.0"` fallback, and includes already-registered modules so inter-batch constraints resolve against the live registry.
- **Caret (`^`) and tilde (`~`) constraint support** in `matchesVersionHint` / `selectBestVersion` (npm/Cargo semantics): `^1.2.3 → >=1.2.3,<2.0.0`, `^0.2.3 → >=0.2.3,<0.3.0`, `^0.0.3 → >=0.0.3,<0.0.4`, `~1.2.3 → >=1.2.3,<1.3.0`, `~1.2 → >=1.2.0,<1.3.0`, `~1 → >=1.0.0,<2.0.0`. `matchesVersionHint` is now exported.
- **Auto-schema multi-adapter chain** (`src/schema/extractor.ts`) — `SchemaExtractorRegistry` with pluggable adapters. Built-in: TypeBox (priority 100, detects `Symbol.for('TypeBox.Kind')`), JsonSchema (priority 30, detects `type`/`properties`). Custom adapters (zod, class-validator, typia) registered via `SchemaExtractorRegistry.register()`. See DECLARATIVE_CONFIG_SPEC.md §6.3.
- **`auto_schema: true | permissive | strict`** in binding YAML — triggers module export scanning (`inputSchema`/`outputSchema` named exports, or `<symbolName>InputSchema`/`<symbolName>OutputSchema` companion naming). Implicit default when no schema mode specified.
- **`BindingSchemaInferenceFailedError`** and **`BindingSchemaModeConflictError`** — canonical errors per DECLARATIVE_CONFIG_SPEC.md §7.1. `BindingSchemaMissingError` is now a deprecated alias.
- **`spec_version`** field support in binding YAML with deprecation warning when absent.
- **`documentation`, `annotations`, `metadata`** fields pass through `BindingLoader` → `FunctionModule`. Annotations converted from YAML snake_case to TypeScript camelCase via `parseAnnotations()`.
- **Pipeline `handler:` dynamic import** — `_resolveStep` and `buildStrategyFromConfig` are now `async`. Handler modules loaded via `await import()` with security checks (rejects `..` segments, `file:` URLs). See DECLARATIVE_CONFIG_SPEC.md §4.4.
- **Cross-SDK conformance fixtures** in `apcore/conformance/fixtures/`.

### Fixed

- **`resolveDependencies` cycle path accuracy** — `extractCycle` previously returned a phantom path (all remaining nodes plus the first one re-appended) when the arbitrarily-picked start node had no outgoing edge inside `remaining`. This could happen when a module is blocked on an external `knownIds` dependency while another subset contains a real cycle. Rewritten to DFS from each remaining node (sorted) and return a true back-edge cycle `[n0, ..., nk, n0]`; falls back to `sortedRemaining` only when no back-edge exists.

### Changed
- **Missing required dependencies now throw `DependencyNotFoundError` (code `DEPENDENCY_NOT_FOUND`) instead of `ModuleLoadError` (code `MODULE_LOAD_ERROR`).** Brings TypeScript into compliance with PROTOCOL_SPEC §5.15.2. Upgrade path: catch `DependencyNotFoundError` specifically, or catch the `ModuleError` base class. Code-based dispatch (`err.code === 'DEPENDENCY_NOT_FOUND'`) also works and is recommended for cross-language consumers.
- **`Context.create({ traceParent })`** — strict input validation per PROTOCOL_SPEC §10.5. trace_ids that are all-zero or all-f (W3C-invalid) now trigger regeneration, and any regeneration now emits `console.warn` (previously silent). No auto-normalization (dashed-UUID stripping or case folding) is performed at `Context.create`; such normalization is the caller's ContextFactory responsibility. Valid 32-hex inputs remain accepted verbatim. Covered by new conformance fixture `context_trace_parent.json`.

### Changed (BREAKING)

- **`buildStrategyFromConfig()` is now `async`** — returns `Promise<ExecutionStrategy>`. Callers must `await` it. Necessary because `handler:` resolution uses `await import()`.
- **`_resolveStep()` is now `async`** — returns `Promise<Step>`.
- **`BindingSchemaMissingError`** renamed to `BindingSchemaInferenceFailedError`. Constructor signature changed: `(target, moduleId?, filePath?, remediation?, options?)`. Old name kept as alias.

## [0.18.0] - 2026-04-15

### Added

- **Registry length boundary tests** — `tests/registry/test-registry.test.ts` now covers `MAX_MODULE_ID_LENGTH` constant equality, exact-length registration acceptance, and over-length rejection (parity with `apcore-python`'s `TestRegisterConstants`).
- **8 new parity tests** in `tests/registry/test-registry.test.ts` covering: invalid pattern rejection (uppercase, hyphens, leading digit, etc.), reserved word in any segment rejection, `registerInternal` accepting reserved first segment, accepting reserved word in any segment, still rejecting empty, still rejecting invalid pattern, still rejecting over-length, and rejecting duplicate.

### Changed

- **ACL singular condition handler aliases removed** (`identity_type`, `role`, `call_depth`). Spec §6.1 only defines the plural forms (`identity_types`, `roles`, `max_call_depth`); the singular aliases were a cross-language divergence. Aligned with apcore-python (commit `2c204fb`) and apcore-rust (plural-only since initial implementation).
- **`module()` factory now throws `InvalidInputError` when `id` is not provided**, per PROTOCOL_SPEC §5.11.6. JavaScript cannot derive `{module_path}.{name}` at runtime (unlike Python's `__module__`), so explicit `id` is required. Previously defaulted to `'anonymous'`. Aligned with apcore-rust which also requires explicit name.
- **`MAX_MODULE_ID_LENGTH` raised from 128 to 192** (`registry/registry.ts`). Tracks PROTOCOL_SPEC §2.7 EBNF constraint #1 — accommodates Java/.NET deep-namespace FQN-derived IDs while remaining filesystem-safe (`192 + ".binding.yaml".length = 205 < 255`-byte filename limit on ext4/xfs/NTFS/APFS/btrfs). Module IDs valid before this change remain valid; only the upper bound moved. **Forward-compatible relaxation:** older 0.17.x/0.18.x readers will reject IDs in the 129–192 range emitted by this version.
- **`Registry.register()` and `Registry.registerInternal()` now share a private `validateModuleId()` helper** that runs validation in canonical order (empty → EBNF pattern → length → reserved word per-segment). Deduplicated 2 enforcement sites in the same file. Aligned cross-language with apcore-python and apcore-rust.
- **Duplicate registration error message canonicalized** to `` `Module ID '${moduleId}' is already registered` `` (was `` `Module already exists: ${moduleId}` ``). Both `register()` and `registerInternal()` now emit the same message. Aligned with apcore-python and apcore-rust byte-for-byte.
- **Helper error message style aligned with apcore-python / apcore-rust:**
  - Empty error: `'module_id must be a non-empty string'` (was `'Module ID must be a non-empty string'` — now lowercase to match Python/Rust).
  - Pattern error: single quotes around the offending ID (was double quotes).
  - Pattern error format string: uses `${MODULE_ID_PATTERN.source}` (bare regex source) instead of `${MODULE_ID_PATTERN}` (which produced `/.../` slashes via `RegExp.toString()`).

### Changed (cross-language sync)

- **`Executor.listStrategies()` now returns `StrategyInfo[]` instead of `string[]`** — Provides step count, step names, and description alongside the strategy name. Aligned with apcore-python `list_strategies() -> list[StrategyInfo]` and apcore-rust `list_strategies() -> Vec<StrategyInfo>`.

### Removed

- **`FeatureNotImplementedError` and `DependencyNotFoundError`** — zero throw-sites across the codebase. Error codes `GENERAL_NOT_IMPLEMENTED` and `DEPENDENCY_NOT_FOUND` remain in `ErrorCodes` for use via the generic `ModuleError` constructor. Aligned with apcore-python (commit `91e951a`).

### Fixed

- **README Quick Start — missing `await` on `client.validate()` call.** `validate()` is async and returns `Promise<PreflightResult>`; the example assigned the Promise directly instead of awaiting it.

- **Dead fallback in `getDefinition` dropped** (`registry.ts:516-530`). A `module.description ?? metadata.description` chain was unreachable because `module.description` is always set by the `Module` base class constructor. Removed the dead branch.
- **Spec §4.13 annotation merge — YAML annotations are no longer silently dropped at registration.** Two coupled bugs were repaired in `registry/metadata.ts:mergeModuleMetadata` and `registry/registry.ts:getDefinition`. The merge step was doing whole-replacement of the `annotations` field instead of the field-level merge mandated by §4.13 ("If YAML only defines `readonly: true`, other fields **must** retain values from code or defaults."), and `getDefinition` was reading directly from the module class object even when the merge result was available. The fix wires `mergeAnnotations` and `mergeExamples` from `schema/annotations.ts` (defined and unit-tested but never previously called from production) into the registry pipeline, and updates `getDefinition` to consume the merged metadata. **User-observable behavior change:** modules that supplied `annotations:` in their `*_meta.yaml` companion files were previously seeing those annotations silently ignored; they will now be honored. Modules that relied on the broken behavior should audit their meta files. Identical fix to `apcore-python` commit `9c0fde9`. Adds 5 regression tests covering field-level merge, YAML-only, neither-defined, examples-yaml-wins, and unknown-key-drop scenarios.
- **`annotationsFromJSON` precedence inversion** — Per PROTOCOL_SPEC §4.4.1 rule 7, when the same key appears both in a nested `extra` object and as a top-level overflow key, the **nested value now wins** (previously the spread order `{...explicitExtra, ...overflow}` made overflow win). Behavior change is observable only in the pathological case where an input contains both forms of the same key — no conformant producer emits this. Top-level overflow keys are still tolerated and merged into `extra` for backward compatibility.

## [0.17.1] - 2026-04-06

### Added

- **`buildMinimalStrategy()`** — 4-step pipeline (context → lookup → execute → return) for pre-validated internal hot paths. Registered as `"minimal"` in Executor built-in factories.
- **`requires` / `provides` on `Step` interface** — Optional advisory fields declaring step dependencies. `ExecutionStrategy` validates dependency chains at construction and insertion, emitting `console.warn` for unmet `requires`.

### Fixed

- **`buildTestingStrategy` aligned with Python/Rust** — Now removes `acl_check`, `approval_gate`, and `call_chain_guard` (8 steps) instead of stripping to 4 minimal steps. Cross-language strategy parity restored.
- **`buildPerformanceStrategy` aligned with Python/Rust** — Now removes `middleware_before` and `middleware_after` instead of `approval_gate` and `output_validation`. Cross-language strategy parity restored.

---

## [0.17.0] - 2026-04-05

### Added

- **Step Metadata**: Four optional fields on `Step` interface: `matchModules` (glob patterns), `ignoreErrors` (fault-tolerant), `pure` (safe for validate dry-run), `timeoutMs` (per-step timeout via `Promise.race`).
- **YAML Pipeline Configuration**: `registerStepType()`, `unregisterStepType()`, `registeredStepTypes()`, `buildStrategyFromConfig()` in new `pipeline-config.ts` module.
- **PipelineContext fields**: `dryRun`, `versionHint`, `executedMiddlewares`.
- **StepTrace**: `skipReason` field.

### Changed

- **Step order**: `BuiltinMiddlewareBefore` now runs BEFORE `BuiltinInputValidation`. Middleware transforms are validated.
- **Executor delegation**: `callAsync()`, `validate()`, and `stream()` fully delegate to `PipelineEngine.run()`. Removed inline step code.
- **Renamed**: `safety_check` → `call_chain_guard`, `BuiltinSafetyCheck` → `BuiltinCallChainGuard`.
- **Removed `builtin.` prefix**: All step names changed from `builtin.context_creation` to `context_creation`.
- **`validate()` is now async**: Returns `Promise<PreflightResult>`.

### Fixed

- Middleware input transforms were never validated against schema.
- `validate()` now uses pipeline dry-run mode — user-added `pure=true` steps automatically participate.

---

## [0.16.0] - 2026-04-05

### Added

- **Config Bus**: `envStyle` (auto/nested/flat), `maxDepth`, `envPrefix` auto-derivation, `envMap` (namespace + global), `Config.envMap()`, `ConfigEnvMapConflictError`.
- **Context**: `ContextKey<T>` typed accessor with `get()`/`set()`/`delete()`/`exists()`/`scoped()`. Built-in key constants. `globalDeadline: number | null` field. `Context.serialize()`/`deserialize()` with `_context_version: 1`.
- **Annotations**: `extra: Readonly<Record<string, unknown>>` extension field. `paginationStyle` changed from union to `string`. All optional fields now required with defaults. `createAnnotations()` factory. `annotationsToJSON()`/`annotationsFromJSON()` wire format.
- **ACL**: `ACLConditionHandler` interface (`boolean | Promise<boolean>`). `ACL.registerCondition()`. `$or`/`$not` compound operators. `asyncCheck()` method. Fail-closed for unknown conditions. `removeRule` fixed to element-wise comparison.
- **Pipeline**: `Step` interface, `StepResult`, `PipelineContext`, `PipelineTrace`, `ExecutionStrategy`, `PipelineEngine`. 11 `BuiltinStep` classes. Preset strategies (standard/internal/testing/performance). `Executor.strategy` option. `callWithTrace()`. `registerStrategy()`/`listStrategies()`/`describePipeline()`.

### Changed

- Toggle system module now has PROTOCOL_SPEC reference comment.

---

## [0.15.1] - 2026-03-31

### Changed

- **Env prefix convention simplified** — Removed the `^APCORE_[A-Z0-9]` reservation rule from `Config.registerNamespace()`. Sub-packages now use single-underscore prefixes (`APCORE_MCP`, `APCORE_OBSERVABILITY`, `APCORE_SYS`) instead of the double-underscore form. Only the exact `APCORE` prefix is reserved for the core namespace.
- Built-in namespace env prefixes: `APCORE__OBSERVABILITY` → `APCORE_OBSERVABILITY`, `APCORE__SYS` → `APCORE_SYS`.

---

## [0.15.0] - 2026-03-30

### Added

#### Config Bus Architecture (§9.4–§9.14)

`Config` is upgraded from an internal configuration tool to an ecosystem-level Config Bus. Any package — apcore ecosystem or third-party — can register a named namespace with optional JSON Schema validation, environment variable prefix, and default values.

- **`Config.registerNamespace(name, options?)`** — Register a namespace on the global (class-level) registry shared across all `Config` instances. Options:
  - `schema?` — JSON Schema object for namespace-level validation
  - `envPrefix?` — Environment variable prefix for this namespace (e.g. `'APCORE_MCP'`)
  - `defaults?` — Default values merged before file and env overrides
  - Late registration is permitted; call `config.reload()` afterward to apply defaults and env overrides
  - Throws `CONFIG_NAMESPACE_DUPLICATE` if the name is already registered
  - Throws `CONFIG_NAMESPACE_RESERVED` for reserved names (e.g. `_config`)
- **`config.get("namespace.key.path")`** — Dot-path access with namespace resolution. The first segment resolves to a registered namespace; remaining segments traverse its subtree
- **`config.namespace(name)`** — Returns the full subtree for a registered namespace as a plain object
- **`config.bind<T>(namespace, type)`** — Returns a typed view of a namespace subtree; throws `CONFIG_BIND_ERROR` on schema mismatch
- **`config.getTyped<T>(path, type)`** — Typed single-value accessor with runtime type guard
- **`config.mount(namespace, options)`** — Attach an external configuration source to a namespace without requiring a unified YAML file. `options` accepts `fromFile` (path string) or `fromDict` (plain object). Throws `CONFIG_MOUNT_ERROR` on failure
- **`Config.registeredNamespaces()`** — Returns a string array of all currently registered namespace names
- **`config.reload()`** — Extended: re-reads YAML (when loaded via `Config.load()`), re-detects legacy/namespace mode, re-applies namespace defaults and env overrides, re-validates, and re-reads mounted files

##### Unified YAML with namespace sections

Config files now support a namespace mode when an `apcore:` top-level key is present. Each registered namespace occupies its own top-level section. The `_config` reserved meta-namespace controls validation behavior (`strict`, `allowUnknown`). Legacy files (no `apcore:` key) remain fully backward compatible.

##### Per-namespace environment variable overrides

Each namespace declares its own `envPrefix`. The loader uses a longest-prefix-match dispatch algorithm to route env vars to the correct namespace. Apcore sub-packages use `APCORE_` prefixed names (e.g. `APCORE_MCP`, `APCORE_OBSERVABILITY`); the longest-prefix-match dispatch disambiguates from the core `APCORE` flat-key prefix.

##### New error codes

| Code | When thrown |
|------|-------------|
| `CONFIG_NAMESPACE_DUPLICATE` | `registerNamespace()` called with an already-registered name |
| `CONFIG_NAMESPACE_RESERVED` | `registerNamespace()` called with a reserved name (e.g. `_config`) |
| `CONFIG_ENV_PREFIX_CONFLICT` | Two namespaces declare the same `envPrefix` |
| `CONFIG_MOUNT_ERROR` | `mount()` cannot read or parse the external source |
| `CONFIG_BIND_ERROR` | `bind<T>()` or `getTyped<T>()` type guard fails |

#### Built-in Namespace Registrations (§9.15)

apcore pre-registers two namespaces for its own subsystems:

- **`observability`** (`APCORE_OBSERVABILITY`) — Wraps the existing `apcore.observability.*` flat keys (tracing, metrics, logging, errorHistory, platformNotify) into a dedicated namespace. Adapter packages (apcore-mcp, apcore-a2a, apcore-cli) should read from this namespace instead of maintaining independent logging defaults.
- **`sysModules`** (`APCORE_SYS`) — Promotes `apcore.sys_modules.*` flat keys into a dedicated namespace. `registerSysModules()` prefers `config.namespace("sysModules")` in namespace mode and falls back to `config.get("sys_modules.*")` in legacy mode.

#### Error Formatter Registry (§8.8)

New `ErrorFormatter` interface and `ErrorFormatterRegistry` singleton for adapter-specific error serialization:

- **`ErrorFormatterRegistry.register(surface, formatter)`** — Register a named formatter (e.g. `'mcp'`, `'a2a'`). Throws `ERROR_FORMATTER_DUPLICATE` if already registered.
- **`ErrorFormatterRegistry.get(surface)`** — Retrieve a registered formatter by surface name.
- **`ErrorFormatterRegistry.format(surface, error)`** — Format a `ModuleError` using the registered formatter; falls back to `error.toDict()` when no formatter is registered for the surface.

New error code: `ERROR_FORMATTER_DUPLICATE`.

#### Event Type Naming Convention and Collision Fix (§9.16)

Two confirmed event-type collisions in the emitted event stream are resolved. Canonical dot-namespaced names replace the ambiguous short-form names:

| Legacy name (alias, still emitted) | Canonical name | Meaning |
|------------------------------------|----------------|---------|
| `"module_health_changed"` | `apcore.module.toggled` | Module enabled/disabled toggle |
| `"module_health_changed"` | `apcore.health.recovered` | Error-rate recovery after spike |
| `"config_changed"` | `apcore.config.updated` | Config key updated at runtime |
| `"config_changed"` | `apcore.module.reloaded` | Module reloaded from disk |

Naming convention: `apcore.*` is reserved for core events. Adapter packages use their own prefix (`apcore-mcp.*`, `apcore-a2a.*`, `apcore-cli.*`). All four legacy short-form names remain emitted as aliases during the transition period.

---

## [0.14.1] - 2026-03-29

### Fixed
- **Executor schema validation** — `Executor.call()` now accepts raw JSON Schema (e.g. from `zodToJsonSchema`) as `inputSchema`/`outputSchema`, not just TypeBox `TSchema`. Previously, passing raw JSON Schema caused TypeBox `Value.Check()` to throw "Unknown type". The fix auto-converts via `jsonSchemaToTypeBox()` on first use and caches the result on the module object to avoid repeated conversion.

## [0.14.0] - 2026-03-24

### Breaking Changes
- Middleware default priority changed from `0` to `100` per PROTOCOL_SPEC §11.2. Middleware without explicit priority will now execute before priority-0 middleware.

### Added
- **Middleware priority** — `Middleware` base class now accepts `priority: number` (default 0). Higher priority executes first; equal priority preserves registration order. `BeforeMiddleware` and `AfterMiddleware` adapters also accept `priority`.
- **Priority range validation** — `RangeError` thrown for values outside 0-1000

## [0.13.1] - 2026-03-22

### Changed
- Rebrand: aipartnerup → aiperceivable

## [0.13.0] - 2026-03-12

### Added
- **Caching/pagination annotations** — `ModuleAnnotations` gains 5 optional fields: `cacheable`, `cacheTtl`, `cacheKeyFields`, `paginated`, `paginationStyle` (backward compatible)
- **`paginationStyle` union** — Typed as `'cursor' | 'offset' | 'page'` matching Python SDK and spec
- **`sunsetDate`** — New field on `ModuleDescriptor` and `LLMExtensions` for module deprecation lifecycle
- **`onSuspend()` / `onResume()` lifecycle hooks** — Optional methods on `Module` interface for state preservation during hot-reload; integrated into control module reload flow
- **MCP `_meta` export** — Schema exporter includes `cacheable`, `cacheTtl`, `cacheKeyFields`, `paginated`, `paginationStyle` in `_meta` sub-dict
- **Suspend/resume tests** — 5 test cases in `test-control.test.ts` covering happy path, null return, no hooks, error paths
- **README Links section** — Footer with Documentation, Specification, GitHub, npm, Issues links

### Changed
- **Rebranded** — "module development framework" → "module standard" in package.json, index.ts, README, and internal JSDoc
- **README** — Three-tier slogan/subtitle/definition format, annotation features in feature list
- **`dictToAnnotations`** — Snake_case fallbacks for new fields (`cache_ttl`, `cache_key_fields`, `pagination_style`)
- **All sys-module annotations** — Updated with new fields (9 modules across 5 files)

---

## [0.12.0] - 2026-03-11

### Added
- **`Module.preflight()`** — Optional method for domain-specific pre-execution warnings (spec §5.6)
- **`Module.describe()`** — Optional method returning `ModuleDescription` for LLM/AI tool discovery (spec §5.6)
- **`ModuleDescription`** interface — Typed return type for `Module.describe()`, exported from package index

### Changed
- **`ExecutionCancelledError`** now extends `ModuleError` (was bare `Error`) with error code `EXECUTION_CANCELLED`, aligning with PROTOCOL_SPEC §8.7 error hierarchy
- **`ErrorCodes`** — Added `EXECUTION_CANCELLED` constant

### Fixed
- **Removed phantom CHANGELOG entry** — `ModuleAnnotations.batchProcessing` (v0.4.0) was never implemented

---

## [0.11.0] - 2026-03-08

### Added
- **Full lifecycle integration tests** (`tests/integration/test-full-lifecycle.test.ts`) — 8 tests covering the complete 11-step pipeline with all gates (ACL + Approval + Middleware + Schema validation) enabled simultaneously, nested module calls, shared `context.data`, error propagation, schema validation, and safe hot-reload lifecycle.

#### System Modules — AI Bidirectional Introspection
Built-in `system.*` modules that allow AI agents to query, monitor

- **`system.health.summary`** / **`system.health.module`** — Health status classification with error history integration.
- **`system.manifest.module`** / **`system.manifest.full`** — Module introspection and full registry manifest with filtering.
- **`system.usage.summary`** / **`system.usage.module`** — Usage statistics with hourly trend data.
- **`system.control.update_config`** — Runtime config hot-patching.
- **`system.control.reload_module`** — Hot-reload modules from disk.
- **`system.control.toggle_feature`** — Enable/disable modules at runtime.
- **`registerSysModules()`** — Auto-registration wiring for all system modules.

#### Observability
- **`ErrorHistory`** — Ring buffer tracking recent errors with deduplication.
- **`ErrorHistoryMiddleware`** — Middleware recording `ModuleError` details.
- **`UsageCollector`** / **`UsageMiddleware`** — Per-module call counting, latency histograms, and hourly trends.
- **`PlatformNotifyMiddleware`** — Threshold-based sensor emitting events on error rate spikes.

#### Event System
- **`EventEmitter`** — Global event bus with async subscriber dispatch.
- **`WebhookSubscriber`** — HTTP POST event delivery with retry.
- **`A2ASubscriber`** — Agent-to-Agent protocol event bridge.

#### APCore Unified Client
- **`APCore.on()`** / **`APCore.off()`** — Event subscription management via the unified client.
- **`APCore.disable()`** / **`APCore.enable()`** — Module toggle control via the unified client.

#### Registry
- **Module toggle** — `ToggleState` with `disable()`/`enable()`, `ModuleDisabledError` enforcement.

#### Examples
- **`examples/`** directory — 7 runnable examples mirroring apcore-python: simple client, minimal module, readonly module, full-featured module with ContextLogger, `module()` function, and YAML binding with target function.

### Fixed
- **Stale `VERSION` constant** in built dist (`0.9.0` vs `0.11.0`). Rebuilt dist to match `package.json`.
- README architecture tree updated to include ~20 missing source files (`client.ts`, `events/`, `sys-modules/`, etc.).
- README error class count corrected to 35.

---

## [0.10.0] - 2026-03-07

### Added

#### APCore Unified Client
- **`APCore.stream()`** — Stream module output chunk by chunk via the unified client.
- **`APCore.validate()`** — Non-destructive preflight check via the unified client.
- **`APCore.describe()`** — Get module description info (for AI/LLM use).
- **`APCore.useBefore()`** — Add before function middleware via the unified client.
- **`APCore.useAfter()`** — Add after function middleware via the unified client.
- **`APCore.remove()`** — Remove middleware by identity via the unified client.

#### Module Interface
- **Optional methods** added to `Module` interface: `stream?()`, `validate?()`, `onLoad?()`, `onUnload?()`.

#### Error Hierarchy
- **`FeatureNotImplementedError`** — New error class for `GENERAL_NOT_IMPLEMENTED` code.
- **`DependencyNotFoundError`** — New error class for `DEPENDENCY_NOT_FOUND` code.

### Changed
- APCore client now provides full feature parity with `Executor`.

---

## [0.9.0] - 2026-03-06

### Added

#### Enhanced Executor.validate() Preflight
- **`PreflightCheckResult`** — New readonly interface representing a single preflight check result with `check`, `passed`, and `error` fields.
- **`PreflightResult`** — New readonly interface returned by `Executor.validate()`, containing per-check results, `requiresApproval` flag, and computed `errors` array. Duck-type compatible with `ValidationResult`.
- **`createPreflightResult()`** — Factory function for constructing `PreflightResult` from a checks array.
- **Full 6-check preflight** — `validate()` now runs Steps 1–6 of the pipeline (module_id format, module lookup, call chain safety, ACL, approval detection, schema validation) without executing module code or middleware.

### Changed

#### Executor Pipeline
- **Step renumbering** — Approval Gate renumbered from Step 4.5 to Step 5; all subsequent steps shifted +1 (now 11 clean steps).
- **`validate()` return type** — Changed from `ValidationResult` to `PreflightResult`. Backward compatible: `.valid` and `.errors` still work identically for existing consumers.
- **`validate()` signature** — Added optional `context` parameter for call-chain checks; `inputs` now optional (defaults to `{}`).

#### Public API
- Exported `PreflightCheckResult`, `PreflightResult`, and `createPreflightResult` from top-level `index.ts`.

## [0.8.0] - 2026-03-05

### Added

#### Executor Enhancements
- **Dual-timeout model** — Global deadline enforcement (`executor.global_timeout`) alongside per-module timeout. The shorter of the two is applied, preventing nested call chains from exceeding the global budget.
- **Error propagation (Algorithm A11)** — All execution paths wrap exceptions via `propagateError()`, ensuring middleware always receives `ModuleError` instances with trace context.

#### Error System
- **ErrorCodeRegistry** — Custom module error codes are validated against framework prefixes and other modules to prevent collisions. Raises `ErrorCodeCollisionError` on conflict.
- **VersionIncompatibleError** — New error class for SDK/config version mismatches with `negotiateVersion()` utility.
- **MiddlewareChainError** — Now explicitly `DEFAULT_RETRYABLE = false` per PROTOCOL_SPEC §8.6.
- **ErrorCodes** — Added `VERSION_INCOMPATIBLE` and `ERROR_CODE_COLLISION` constants (34 total).

#### Utilities
- **`guardCallChain()`** — Standalone Algorithm A20 implementation for call chain safety checks (depth, circular, frequency). Executor delegates to this utility instead of inline logic.
- **`propagateError()`** — Standalone Algorithm A11 implementation for error wrapping and trace context attachment.
- **`normalizeToCanonicalId()`** — Cross-language module ID normalization (Python snake_case, Go PascalCase, etc.).
- **`calculateSpecificity()`** — ACL pattern specificity scoring for deterministic rule ordering.

#### ACL Enhancements
- **Audit logging** — `ACL` constructor accepts optional `auditLogger` callback. All access decisions emit `AuditEntry` with timestamp, caller/target IDs, matched rule, identity, and trace context.
- **Condition-based rules** — ACL rules support `conditions` for identity type, role, and call depth filtering.

#### Config System
- **Full validation** — `Config.validate()` checks schema structure, value types, and range constraints.
- **Hot reload** — `Config.reload()` re-reads the YAML source and re-validates.
- **Environment overrides** — `APCORE_*` environment variables override config values (e.g., `APCORE_EXECUTOR_DEFAULT_TIMEOUT=5000`).
- **`Config.fromDefaults()`** — Factory method for default configuration.

#### Middleware
- **RetryMiddleware** — Configurable retry with exponential/fixed backoff, jitter, and max delay. Only retries errors marked `retryable: true`.

#### Context
- **Generic `services` typing** — `Context<T>` supports typed dependency injection via the `services` field.

### Changed

#### Executor Internals
- `_checkSafety()` now delegates to standalone `guardCallChain()` instead of inline duplicated logic.
- Global deadline set on root call only, propagated to child contexts via shared `data['_global_deadline']`.

#### Public API
- Expanded `index.ts` exports with new symbols: `RetryMiddleware`, `RetryConfig`, `ErrorCodeRegistry`, `ErrorCodeCollisionError`, `VersionIncompatibleError`, `negotiateVersion`, `guardCallChain`, `propagateError`, `normalizeToCanonicalId`, `calculateSpecificity`, `AuditEntry`.

## [0.7.2] - 2026-03-04

### Fixed
- **CHANGELOG cleanup** — Removed duplicate entries that were incorrectly repeated in the 0.4.0 and 0.3.0 sections.

### Changed
- **README.md** — Added documentation link section pointing to the official Getting Started guide. Updated project structure to reflect files added in recent releases (`async-task.ts`, `cancel.ts`, `extensions.ts`, `trace-context.ts`), and corrected error class count from 20+ to 30+.

## [0.7.1] - 2026-03-03

### Changed
- **`license` field aligned** — Updated `package.json` `license` field from `"MIT"` to `"Apache-2.0"` to match the license file change made in 0.7.0.

## [0.7.0] - 2026-03-02

### Added
- **Approval system** — Pluggable approval gate (Step 4.5) in the executor pipeline between ACL enforcement and input validation. Modules with `requiresApproval: true` annotation trigger an approval flow before execution proceeds.
  - `ApprovalHandler` interface with `requestApproval()` and `checkApproval()` methods for synchronous and async (polling) approval flows
  - `ApprovalRequest` and `ApprovalResult` types carrying invocation context and decision state (`approved`, `rejected`, `timeout`, `pending`)
  - Three built-in handlers: `AutoApproveHandler` (dev/testing), `AlwaysDenyHandler` (safe default), `CallbackApprovalHandler` (user-provided async callback)
  - `createApprovalRequest()` and `createApprovalResult()` factory functions
  - `Executor.setApprovalHandler()` method for runtime handler configuration
  - Approval audit events emitted to tracing spans for observability
- **Approval error types** — `ApprovalError` (base), `ApprovalDeniedError`, `ApprovalTimeoutError` (retryable), `ApprovalPendingError` (carries `approvalId` for polling). Error codes `APPROVAL_DENIED`, `APPROVAL_TIMEOUT`, `APPROVAL_PENDING` added to `ErrorCodes`.
- **`approval_handler` extension point** — Single-handler extension point in `ExtensionManager` for wiring approval handlers via the extension system.
- **Approval test suites** — `test-approval.test.ts`, `test-approval-executor.test.ts`, `test-approval-integration.test.ts`, and `test-errors.test.ts` covering handler behavior, executor pipeline integration, async polling, and error class correctness.

### Changed
- **License changed from MIT to Apache-2.0**.
- Added `"approval"` to `package.json` keywords.

## [0.6.0] - 2026-02-23

### Fixed
- **Critical publishing bug** — Previous releases (0.1.0–0.5.0) shipped without `dist/` directory because `.gitignore` excluded `dist/` and npm fell back to it as the exclusion list (no `files` field or `.npmignore` existed). `require("apcore-js")` and `import("apcore-js")` would fail at runtime with "module not found". This is the first version where the package is actually usable from npm.
- **VERSION constant out of sync** — `VERSION` export was stuck at `'0.3.0'` while `package.json` was at `0.5.0`.

### Added
- `"files": ["dist", "README.md"]` in `package.json` to restrict npm publish scope to compiled output only (previously published src/, tests/, planning/, .claude/, .github/ — 902 KB of dev files).
- `"prepublishOnly": "pnpm run build"` script to ensure `tsc` runs before every `npm publish` / `pnpm publish`.
- **Package integrity test suite** (`tests/test-package-integrity.test.ts`) — 10 tests that verify:
  - `files` field configuration and exclusion of dev directories
  - `prepublishOnly` script exists and invokes build
  - All entry points (`main`, `types`, `exports`) resolve to files in `dist/`
  - `dist/index.js` is importable and exports all 16+ core symbols
  - `VERSION` constant matches `package.json` version

### Changed
- **Version aligned with apcore-python** — Bumped to 0.6.0 for cross-language version consistency.
- Package size reduced from 192.6 kB (source-only, broken) to 86.3 kB (compiled, working).
- **Full browser / frontend compatibility** — All `node:fs` and `node:path` imports across 7 source files (`acl.ts`, `bindings.ts`, `schema/loader.ts`, `schema/ref-resolver.ts`, `registry/metadata.ts`, `registry/scanner.ts`, `registry/registry.ts`) converted from static top-level imports to lazy-load via ESM top-level `await import()` with `try/catch`. Importing any module from `apcore-js` in a browser bundler no longer crashes at parse time.
- **`node:crypto` removed** — `trace-context.ts` and `observability/tracing.ts` now use a new `randomHex()` utility based on the Web Crypto API (`globalThis.crypto.getRandomValues()`), compatible with Node 18+ and all modern browsers.
- **`process.stdout` / `process.stderr` removed** — `StdoutExporter` uses `console.info()`, `ContextLogger` default output uses `console.error()` for universal runtime compatibility.
- `Registry.watch()` signature changed from `watch(): void` to `async watch(): Promise<void>` (backward-compatible — existing fire-and-forget calls still work).
- Added `"sideEffects": false` to `package.json` to enable bundler tree-shaking of Node.js-only code paths.

### Added (new in browser-compat)
- `randomHex(byteLength: number): string` utility function in `utils/index.ts` — generates hex strings using Web Crypto API, replacing `node:crypto.randomBytes`.
- **Browser compatibility test suite** (`tests/test-browser-compat.test.ts`) — 26 tests across 4 groups:
  - Module import health (8 tests) — all lazy-load modules importable
  - Pure-logic APIs without filesystem (10 tests) — ACL, metadata, jsonSchemaToTypeBox, RefResolver inline $ref, Registry register/get/event
  - Filesystem-dependent APIs in Node.js (5 tests) — ACL.load, loadMetadata, scanExtensions, SchemaLoader, RefResolver with lazy-loaded fs/path
  - Source file guard (1 test) — scans all 10 refactored files to assert zero static `node:` imports

## [0.5.0] - 2026-02-23

### Added
- **Cancellation support** with `CancelToken` and `ExecutionCancelledError`, including executor pre-execution cancellation checks.
- **Async task system** with `AsyncTaskManager`, `TaskStatus`, and `TaskInfo` for background module execution, status tracking, cancellation, and cleanup.
- **Extension framework** via `ExtensionManager` and `ExtensionPoint`, with built-in extension points for `discoverer`, `middleware`, `acl`, `span_exporter`, and `module_validator`.
- **W3C Trace Context support** through `TraceContext` and `TraceParent` (`inject`, `extract`, `fromTraceparent`) for distributed trace propagation.
- **OTLP tracing exporter** (`OTLPExporter`) for OpenTelemetry-compatible HTTP span export.
- **Registry extensibility hooks**: custom `Discoverer` and `ModuleValidator` interfaces and runtime registration methods.
- **Registry constraints and constants**: `MAX_MODULE_ID_LENGTH`, `RESERVED_WORDS`, and stricter module ID validation rules.
- **Context interoperability APIs**: `Context.toJSON()`, `Context.fromJSON()`, and `ContextFactory` interface.

### Changed
- `Context.create()` now accepts optional `traceParent` and can derive `traceId` from inbound distributed trace headers.
- `Registry.discover()` now supports async custom discovery/validation flow in addition to default filesystem discovery.
- `TracingMiddleware` now supports runtime exporter replacement via `setExporter()` and uses Unix epoch seconds with OTLP-compatible nanosecond conversion.
- Public exports were expanded in `index.ts` to expose new cancellation, extension, tracing, registry, and async-task APIs.
- `MiddlewareChainError` now preserves the original cause when wrapping middleware exceptions.

### Fixed
- Improved cancellation correctness by bypassing middleware error recovery for `ExecutionCancelledError`.
- Improved async task concurrency behavior around queued-task cancellation to avoid counter corruption.
- Improved context serialization safety by excluding internal `data` keys prefixed with `_` from `toJSON()` output.

### Tests
- Added comprehensive tests for cancellation, async task management, extension wiring, trace context parsing/injection, registry hot-reload/custom hooks, and OTLP export behavior.

## [0.4.0] - 2026-02-23

### Changed
- Improved performance of `Executor.stream()` with optimized buffering.

### Added
- Added new logging features for better observability in the execution pipeline.
- **ExtensionManager** and **ExtensionPoint** exports for unified extension point management (discoverer, middleware, acl, span_exporter, module_validator)
- **AsyncTaskManager**, **TaskStatus**, **TaskInfo** exports for async task execution with status tracking (PENDING, RUNNING, COMPLETED, FAILED, CANCELLED) and cancellation
- **TraceContext** and **TraceParent** exports for W3C Trace Context support with `inject()`, `extract()`, and `fromTraceparent()` methods
- `Context.create()` accepts optional `traceParent` parameter for distributed trace propagation

### Fixed
- Resolved issues with error handling in `context.ts`.

### Co-Authors
- Claude Opus 4.6 <noreply@anthropic.com>
- New Contributor <newcontributor@example.com>

### Added

- **Error classes and constants**
  - `ModuleExecuteError` — New error class for module execution failures
  - `InternalError` — New error class for general internal errors
  - `ErrorCodes` — Frozen object with all 26 error code strings for consistent error code usage
  - `ErrorCode` — Type definition for all error codes
- **Registry constants**
  - `REGISTRY_EVENTS` — Frozen object with standard event names (`register`, `unregister`)
  - `MODULE_ID_PATTERN` — Regex pattern enforcing lowercase/digits/underscores/dots for module IDs (no hyphens allowed to ensure bijective MCP tool name normalization)
- **Executor methods**
  - `Executor.callAsync()` — Alias for `call()` for compatibility with MCP bridge packages

### Changed

- **Module ID validation** — Registry now validates module IDs against `MODULE_ID_PATTERN` on registration, rejecting IDs with hyphens or invalid characters
- **Event handling** — Registry event validation now uses `REGISTRY_EVENTS` constants instead of hardcoded strings
- **Test updates** — Updated tests to use underscore-separated module IDs instead of hyphens (e.g., `math.add_ten` instead of `math.addTen`, `ctx_test` instead of `ctx-test`)

### Fixed

- **String literals in Registry** — Replaced hardcoded `'register'` and `'unregister'` strings with `REGISTRY_EVENTS.REGISTER` and `REGISTRY_EVENTS.UNREGISTER` constants in event triggers for consistency

## [0.3.0] - 2026-02-20

### Changed
- Use shallow merge for `stream()` accumulation instead of last-chunk.

### Added
- Add `Executor.stream()` async generator and `ModuleAnnotations.streaming` for streaming support in the core execution pipeline.

### Co-Authors
- Claude Opus 4.6 <noreply@anthropic.com>

### Added

- **Error classes and constants**
  - `ModuleExecuteError` — New error class for module execution failures
  - `InternalError` — New error class for general internal errors
  - `ErrorCodes` — Frozen object with all 26 error code strings for consistent error code usage
  - `ErrorCode` — Type definition for all error codes
- **Registry constants**
  - `REGISTRY_EVENTS` — Frozen object with standard event names (`register`, `unregister`)
  - `MODULE_ID_PATTERN` — Regex pattern enforcing lowercase/digits/underscores/dots for module IDs (no hyphens allowed to ensure bijective MCP tool name normalization)
- **Executor methods**
  - `Executor.callAsync()` — Alias for `call()` for compatibility with MCP bridge packages

### Changed

- **Module ID validation** — Registry now validates module IDs against `MODULE_ID_PATTERN` on registration, rejecting IDs with hyphens or invalid characters
- **Event handling** — Registry event validation now uses `REGISTRY_EVENTS` constants instead of hardcoded strings
- **Test updates** — Updated tests to use underscore-separated module IDs instead of hyphens (e.g., `math.add_ten` instead of `math.addTen`, `ctx_test` instead of `ctx-test`)

### Fixed

- **String literals in Registry** — Replaced hardcoded `'register'` and `'unregister'` strings with `REGISTRY_EVENTS.REGISTER` and `REGISTRY_EVENTS.UNREGISTER` constants in event triggers for consistency

## [0.2.0] - 2026-02-20

### Added

- **Error classes and constants**
  - `ModuleExecuteError` — New error class for module execution failures
  - `InternalError` — New error class for general internal errors
  - `ErrorCodes` — Frozen object with all 26 error code strings for consistent error code usage
  - `ErrorCode` — Type definition for all error codes
- **Registry constants**
  - `REGISTRY_EVENTS` — Frozen object with standard event names (`register`, `unregister`)
  - `MODULE_ID_PATTERN` — Regex pattern enforcing lowercase/digits/underscores/dots for module IDs (no hyphens allowed to ensure bijective MCP tool name normalization)
- **Executor methods**
  - `Executor.callAsync()` — Alias for `call()` for compatibility with MCP bridge packages

### Changed

- **Module ID validation** — Registry now validates module IDs against `MODULE_ID_PATTERN` on registration, rejecting IDs with hyphens or invalid characters
- **Event handling** — Registry event validation now uses `REGISTRY_EVENTS` constants instead of hardcoded strings
- **Test updates** — Updated tests to use underscore-separated module IDs instead of hyphens (e.g., `math.add_ten` instead of `math.addTen`, `ctx_test` instead of `ctx-test`)

### Fixed

- **String literals in Registry** — Replaced hardcoded `'register'` and `'unregister'` strings with `REGISTRY_EVENTS.REGISTER` and `REGISTRY_EVENTS.UNREGISTER` constants in event triggers for consistency

## [0.1.2] - 2026-02-18

### Fixed

- **Timer leak in executor** — `_executeWithTimeout` now calls `clearTimeout` in `.finally()` to prevent timer leak on normal completion
- **Path traversal protection** — `resolveTarget` in binding loader rejects module paths containing `..` segments before dynamic `import()`
- **Bare catch blocks** — 6 silent `catch {}` blocks in registry and middleware manager now log warnings with `[apcore:<subsystem>]` prefix
- **Python-style error messages** — Fixed `FuncMissingTypeHintError` and `FuncMissingReturnTypeError` to use TypeScript syntax (`: string`, `: Record<string, unknown>`)
- **Console.log in production** — Replaced `console.log` with `console.info` in logging middleware and `process.stdout.write` in tracing exporter

### Changed

- **Long method decomposition** — Broke up 4 oversized methods to meet ≤50 line guideline:
  - `Executor.call()` (108 → 6 private helpers)
  - `Registry.discover()` (110 → 7 private helpers)
  - `ACL.load()` (71 → extracted `parseAclRule`)
  - `jsonSchemaToTypeBox()` (80 → 5 converter helpers)
- **Deeply readonly callChain** — `Context.callChain` type narrowed from `readonly string[]` to `readonly (readonly string[])` preventing mutation via push/splice
- **Consolidated `deepCopy`** — Removed 4 duplicate `deepCopy` implementations; single shared version now lives in `src/utils/index.ts`

### Added

- **42 new tests** for previously uncovered modules:
  - `tests/schema/test-annotations.test.ts` — 16 tests for `mergeAnnotations`, `mergeExamples`, `mergeMetadata`
  - `tests/schema/test-exporter.test.ts` — 14 tests for `SchemaExporter` across all 4 export profiles
  - `tests/test-logging-middleware.test.ts` — 12 tests for `LoggingMiddleware` before/after/onError

## [0.1.1] - 2026-02-17

### Fixed

- Updated logo URL in README

### Changed

- Renamed package from `apcore` to `apcore-js`
- Updated installation instructions

## [0.1.0] - 2026-02-16

### Added

- **Core executor** — 10-step async execution pipeline with timeout support via `Promise.race`
- **Context system** — Execution context with trace IDs, call chains, identity, and redacted inputs
- **Config** — Dot-path configuration accessor
- **Registry system**
  - File-based module discovery (`scanExtensions`, `scanMultiRoot`)
  - Dynamic entry point resolution with duck-type validation
  - YAML metadata loading and merging (code values + YAML overrides)
  - Dependency parsing with topological sort (Kahn's algorithm) and cycle detection
  - ID map support for custom module IDs
  - Schema export in JSON/YAML with strict and compact modes
- **FunctionModule** — Schema-driven module wrapper with TypeBox schemas
- **Binding loader** — YAML-based module registration with three schema modes (inline, external ref, permissive fallback)
- **ACL (Access Control List)**
  - Pattern-based rules with glob matching
  - Identity type and role-based conditions
  - Call depth conditions
  - Dynamic rule management (`addRule`, `removeRule`, `reload`)
  - YAML configuration loading
- **Middleware system**
  - Onion-model execution (before forward, after reverse)
  - Error recovery via `onError` hooks
  - `BeforeMiddleware` and `AfterMiddleware` adapters
  - `LoggingMiddleware` for structured execution logging
- **Observability**
  - **Tracing** — Span creation, `InMemoryExporter`, `StdoutExporter`, `TracingMiddleware` with sampling strategies (full, off, proportional, error_first)
  - **Metrics** — `MetricsCollector` with counters, histograms, Prometheus text format export, `MetricsMiddleware`
  - **Logging** — `ContextLogger` with JSON/text formats, level filtering, `_secret_` field redaction, `ObsLoggingMiddleware`
- **Schema system**
  - JSON Schema to TypeBox conversion
  - `$ref` resolution
  - Schema validation
  - Strict transforms (`additionalProperties: false`)
  - LLM description injection and extension stripping
- **Error hierarchy** — 20+ typed error classes with error codes, details, trace IDs, and timestamps
- **Pattern matching** — Glob-style pattern matching for ACL rules and module targeting
- **Comprehensive test suite** — 385 tests across 29 test files

---

[0.20.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/aiperceivable/apcore-typescript/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/aiperceivable/apcore-typescript/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/aiperceivable/apcore-typescript/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/aiperceivable/apcore-typescript/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aiperceivable/apcore-typescript/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aiperceivable/apcore-typescript/releases/tag/v0.1.0
