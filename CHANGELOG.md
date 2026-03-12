# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.12.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aipartnerup/apcore-typescript/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aipartnerup/apcore-typescript/releases/tag/v0.1.0
