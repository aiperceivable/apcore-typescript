# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Spec §4.13 annotation merge — YAML annotations are no longer silently dropped at registration.** Two coupled bugs were repaired in `registry/metadata.ts:mergeModuleMetadata` and `registry/registry.ts:getDefinition`. The merge step was doing whole-replacement of the `annotations` field instead of the field-level merge mandated by §4.13 ("If YAML only defines `readonly: true`, other fields **must** retain values from code or defaults."), and `getDefinition` was reading directly from the module class object even when the merge result was available. The fix wires `mergeAnnotations` and `mergeExamples` from `schema/annotations.ts` (defined and unit-tested but never previously called from production) into the registry pipeline, and updates `getDefinition` to consume the merged metadata. **User-observable behavior change:** modules that supplied `annotations:` in their `*_meta.yaml` companion files were previously seeing those annotations silently ignored; they will now be honored. Modules that relied on the broken behavior should audit their meta files. Identical fix to `apcore-python` commit `9c0fde9`. Adds 5 regression tests covering field-level merge, YAML-only, neither-defined, examples-yaml-wins, and unknown-key-drop scenarios.

## [0.18.0] - 2026-04-08

### Added

- **Registry length boundary tests** — `tests/registry/test-registry.test.ts` now covers `MAX_MODULE_ID_LENGTH` constant equality, exact-length registration acceptance, and over-length rejection (parity with `apcore-python`'s `TestRegisterConstants`).
- **8 new parity tests** in `tests/registry/test-registry.test.ts` covering: invalid pattern rejection (uppercase, hyphens, leading digit, etc.), reserved word in any segment rejection, `registerInternal` accepting reserved first segment, accepting reserved word in any segment, still rejecting empty, still rejecting invalid pattern, still rejecting over-length, and rejecting duplicate.

### Changed

- **`MAX_MODULE_ID_LENGTH` raised from 128 to 192** (`registry/registry.ts`). Tracks PROTOCOL_SPEC §2.7 EBNF constraint #1 — accommodates Java/.NET deep-namespace FQN-derived IDs while remaining filesystem-safe (`192 + ".binding.yaml".length = 205 < 255`-byte filename limit on ext4/xfs/NTFS/APFS/btrfs). Module IDs valid before this change remain valid; only the upper bound moved. **Forward-compatible relaxation:** older 0.17.x/0.18.x readers will reject IDs in the 129–192 range emitted by this version.
- **`Registry.register()` and `Registry.registerInternal()` now share a private `validateModuleId()` helper** that runs validation in canonical order (empty → EBNF pattern → length → reserved word per-segment). Deduplicated 2 enforcement sites in the same file. Aligned cross-language with apcore-python and apcore-rust.
- **Duplicate registration error message canonicalized** to `` `Module ID '${moduleId}' is already registered` `` (was `` `Module already exists: ${moduleId}` ``). Both `register()` and `registerInternal()` now emit the same message. Aligned with apcore-python and apcore-rust byte-for-byte.
- **Helper error message style aligned with apcore-python / apcore-rust:**
  - Empty error: `'module_id must be a non-empty string'` (was `'Module ID must be a non-empty string'` — now lowercase to match Python/Rust).
  - Pattern error: single quotes around the offending ID (was double quotes).
  - Pattern error format string: uses `${MODULE_ID_PATTERN.source}` (bare regex source) instead of `${MODULE_ID_PATTERN}` (which produced `/.../` slashes via `RegExp.toString()`).

### Fixed

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
