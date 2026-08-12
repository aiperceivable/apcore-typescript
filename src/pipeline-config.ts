/**
 * Pipeline YAML configuration: step type registry and strategy builder.
 */

import { buildStandardStrategy } from './builtin-steps.js';
import type { StandardStrategyDeps } from './builtin-steps.js';
import { ModuleError } from './errors.js';
import type { ErrorOptions } from './errors.js';
import type { PipelineContext, Step, StepResult } from './pipeline.js';
import type { ExecutionStrategy } from './pipeline.js';

/**
 * Raised when YAML pipeline configuration references a step or anchor that
 * does not exist (Issue #33 §1.2). Replaces the previous warn-and-continue
 * behaviour so misconfigured `apcore.yaml` files fail loudly at load time.
 *
 * Emits wire code `PIPELINE_CONFIGURATION_ERROR` — the canonical code for
 * parse-time pipeline fail-fast (D-37, see docs/features/error-system.md and
 * the `pipeline_failfast_config` fixture, whose `error_code` is normative
 * while the class name is not). `PIPELINE_CONFIG_INVALID` is a DIFFERENT
 * registry entry reserved for field-level validation failures and MUST NOT
 * be reused here. The exported class name stays `ConfigurationError` because
 * it is public API, and matches apcore-python's `ConfigurationError`
 * (src/apcore/pipeline.py) and apcore-rust's `PipelineError::Configuration`.
 */
export class ConfigurationError extends ModuleError {
  static override readonly DEFAULT_RETRYABLE: boolean | null = false;

  constructor(message: string, options?: ErrorOptions) {
    super(
      'PIPELINE_CONFIGURATION_ERROR',
      message,
      {},
      options?.cause,
      options?.traceId,
      options?.retryable,
      options?.aiGuidance,
      options?.userFixable,
      options?.suggestion,
    );
    this.name = 'ConfigurationError';
  }
}

// ---------------------------------------------------------------------------
// Global step type registry
// ---------------------------------------------------------------------------

type StepFactory = (config: Record<string, unknown>) => Step;

/** Global step type registry: name -> factory function. */
const _stepTypeRegistry = new Map<string, StepFactory>();

/**
 * Register a step type for YAML pipeline configuration.
 *
 * @param name - Type name referenced in YAML `type` field.
 *   Must be non-empty, no whitespace, unique.
 * @param factory - A callable `(config) => Step`.
 * @throws If name is empty, contains whitespace, or is already registered.
 */
export function registerStepType(name: string, factory: StepFactory): void {
  if (!name || /\s/.test(name)) {
    throw new Error(`Invalid step type name: '${name}'`);
  }
  if (_stepTypeRegistry.has(name)) {
    throw new Error(`Step type '${name}' is already registered`);
  }
  _stepTypeRegistry.set(name, factory);
}

/**
 * Remove a registered step type.
 * @returns True if found and removed.
 */
export function unregisterStepType(name: string): boolean {
  return _stepTypeRegistry.delete(name);
}

/**
 * Return a list of all registered step type names.
 */
export function registeredStepTypes(): string[] {
  return [..._stepTypeRegistry.keys()];
}

// ---------------------------------------------------------------------------
// Step resolution
// ---------------------------------------------------------------------------

interface StepDefinition {
  name?: string;
  type?: string;
  handler?: string;
  config?: Record<string, unknown>;
  matchModules?: string[];
  ignoreErrors?: boolean;
  pure?: boolean;
  timeoutMs?: number;
  after?: string;
  before?: string;
}

/** Wraps a resolved step with optional metadata overrides from YAML config. */
class ConfiguredStep implements Step {
  readonly description: string;
  readonly removable: boolean;
  readonly replaceable: boolean;

  name: string;
  matchModules?: string[] | null;
  ignoreErrors?: boolean;
  pure?: boolean;
  timeoutMs?: number;

  private _inner: Step;

  constructor(inner: Step, overrides: Partial<StepDefinition>) {
    this._inner = inner;
    this.name = overrides.name ?? inner.name;
    this.description = inner.description;
    this.removable = inner.removable;
    this.replaceable = inner.replaceable;
    this.matchModules = overrides.matchModules ?? inner.matchModules ?? null;
    this.ignoreErrors = overrides.ignoreErrors ?? inner.ignoreErrors ?? false;
    this.pure = overrides.pure ?? inner.pure ?? false;
    this.timeoutMs = overrides.timeoutMs ?? inner.timeoutMs ?? 0;
  }

  execute(ctx: PipelineContext): Promise<StepResult> {
    return this._inner.execute(ctx);
  }
}

/**
 * Resolve a step definition dict into a Step instance.
 *
 * Resolution order (DECLARATIVE_CONFIG_SPEC.md §4):
 *   1. `type` field -> look up in registry (sync, fast path)
 *   2. `handler` field -> dynamic ESM import via `await import()`
 *      Format: `"module:exportName"`. The resolved export is invoked as
 *      `factory(config)` — wrap classes in a factory if needed.
 *   3. Neither -> throw Error
 *
 * NOTE: this function is async because handler resolution requires
 * `await import()`. Type-registry lookups still resolve synchronously
 * inside this async wrapper.
 */
export async function _resolveStep(stepDef: StepDefinition): Promise<Step> {
  const typeName = stepDef.type;
  const handlerPath = stepDef.handler;
  const config = stepDef.config ?? {};

  // (1) Try type registry
  if (typeName && _stepTypeRegistry.has(typeName)) {
    const factory = _stepTypeRegistry.get(typeName)!;
    const step = factory(config);
    return new ConfiguredStep(step, stepDef);
  }

  // (2) Handler path -- dynamic ESM import
  if (handlerPath) {
    const step = await _importStep(handlerPath, config);
    return new ConfiguredStep(step, stepDef);
  }

  // (3) Neither
  if (typeName) {
    throw new Error(
      `Step type '${typeName}' not registered. ` +
        `Register with: registerStepType('${typeName}', yourFactory)`,
    );
  }
  throw new Error(`Step '${stepDef.name ?? ''}' has neither 'type' nor 'handler'`);
}

/**
 * Dynamically import a Step factory from a `"module:exportName"` handler path.
 *
 * Mirrors `bindings.ts#resolveTarget` security model: rejects path-traversal
 * (`..`) segments and `file:` URLs at parse time. The resolved export must be
 * a callable `(config) => Step`. Classes should be wrapped in a thin factory.
 */
async function _importStep(handlerPath: string, config: Record<string, unknown>): Promise<Step> {
  // Security checks run on the whole path BEFORE the module:export split,
  // because 'file:' URLs contain a colon that would otherwise be misparsed.
  const FORBIDDEN_SCHEMES = ['file:', 'http:', 'https:', 'ftp:', 'data:', 'blob:'];
  for (const scheme of FORBIDDEN_SCHEMES) {
    if (handlerPath.startsWith(scheme)) {
      throw new Error(`Handler path '${handlerPath}' must not use '${scheme}' URLs.`);
    }
  }
  if (handlerPath.includes('..')) {
    throw new Error(`Handler path '${handlerPath}' must not contain '..' segments.`);
  }
  if (!handlerPath.includes(':')) {
    throw new Error(`Invalid handler path '${handlerPath}'. Expected format: 'module:exportName'.`);
  }

  // Split from the right so module specifiers containing ':' (e.g., URL-like)
  // don't get misparsed. Standard forms ('./mod:fn', '@scope/pkg:fn') split fine
  // either way; rsplit defends against future scheme-like specifiers.
  const lastColon = handlerPath.lastIndexOf(':');
  const modulePath = handlerPath.slice(0, lastColon);
  const exportName = handlerPath.slice(lastColon + 1);

  let mod: Record<string, unknown>;
  try {
    mod = await import(modulePath);
  } catch (e) {
    throw new Error(`Cannot import handler module '${modulePath}': ${(e as Error).message}`);
  }

  const resolved = mod[exportName];
  if (resolved == null) {
    throw new Error(`Export '${exportName}' not found in module '${modulePath}'.`);
  }
  if (typeof resolved !== 'function') {
    throw new Error(
      `Handler '${handlerPath}' resolved to a non-callable. ` +
        `Expected a (config) => Step factory; wrap classes in a factory if needed.`,
    );
  }

  // Distinguish class export (has a prototype with a `constructor` pointing
  // back to itself) from factory function. The previous implementation used
  // try/new-then-fallback-to-call, which silently swallowed legitimate
  // constructor errors (bad config, missing required field) and produced
  // misleading secondary failures when the fallback call was invoked on a
  // class that required `new`.
  const isLikelyClass =
    typeof resolved === 'function' &&
    resolved.prototype != null &&
    typeof resolved.prototype === 'object' &&
    resolved.prototype.constructor === resolved &&
    // Arrow functions have no prototype; factories with .prototype typically
    // have the default Object constructor, so also require the function's
    // name to start uppercase (class convention).
    /^[A-Z]/.test(resolved.name ?? '');

  const step: unknown = isLikelyClass
    ? new (resolved as new (cfg: Record<string, unknown>) => Step)(config)
    : (resolved as (cfg: Record<string, unknown>) => Step)(config);
  return step as Step;
}

// ---------------------------------------------------------------------------
// Strategy builder from YAML config
// ---------------------------------------------------------------------------

interface PipelineConfig {
  remove?: string[];
  configure?: Record<string, Record<string, unknown>>;
  steps?: StepDefinition[];
}

/**
 * The `Step` fields that `pipeline.configure` may override, keyed by the
 * CANONICAL YAML spelling and mapped to the TypeScript property name.
 *
 * Two spellings are accepted for every field. `schemas/apcore-config.schema.json`
 * `$defs/PipelineStep` — and therefore every `apcore.yaml` and every
 * cross-language conformance fixture — is snake_case (`match_modules`,
 * `ignore_errors`, `timeout_ms`), while the TypeScript {@link Step} interface is
 * camelCase. Accepting only camelCase made three of the four fields
 * unreachable from real YAML: the canonical
 *
 * ```yaml
 * pipeline:
 *   configure:
 *     input_validation:
 *       ignore_errors: true
 * ```
 *
 * threw `ConfigurationError` with a message that listed `ignoreErrors` as
 * valid. Normalising here rather than in the caller is deliberate — a
 * translation table living in a test (or in each downstream framework
 * integration) is the symptom, not the fix.
 *
 * `requires` / `provides` are configurable because
 * `docs/features/middleware-system.md` → "Configuration safety" documents
 * exactly that, and apcore-python accepts them (`hasattr` over the ten
 * attributes `BaseStep.__init__` assigns). Note that overriding them does NOT
 * re-run `ExecutionStrategy` dependency validation — `remove()`, `replace()`
 * and `configureStep()` do not re-validate either, and apcore-python has the
 * same gap; a `requires:` introduced through config is checked on the next
 * strategy construction, not on assignment.
 *
 * NOT configurable, and narrower than the previous `key in step` test on
 * purpose:
 *
 *  - `name` — the strategy keys an O(1) `name → index` map on it; renaming a
 *    step through YAML silently corrupts `findStepIndex`, `remove` and every
 *    `after`/`before` anchor.
 *  - `removable` / `replaceable` — a step's own guards against being removed or
 *    swapped. Letting a config file flip them defeats the guard.
 *  - `description` — not in `$defs/PipelineStep`; carries no behaviour.
 *  - `execute` — `key in step` walks the prototype chain, so the previous
 *    implementation accepted `execute` and let a config file replace the step
 *    body outright.
 */
const CONFIGURABLE_STEP_FIELDS: ReadonlyMap<string, string> = new Map([
  // canonical snake_case (schema + YAML + fixtures)
  ['match_modules', 'matchModules'],
  ['ignore_errors', 'ignoreErrors'],
  ['pure', 'pure'],
  ['timeout_ms', 'timeoutMs'],
  ['requires', 'requires'],
  ['provides', 'provides'],
  // camelCase aliases (the TypeScript `Step` surface)
  ['matchModules', 'matchModules'],
  ['ignoreErrors', 'ignoreErrors'],
  ['timeoutMs', 'timeoutMs'],
]);

/** The canonical (snake_case) spellings, for error messages. */
const CANONICAL_CONFIGURABLE_STEP_FIELDS: readonly string[] = [
  'match_modules',
  'ignore_errors',
  'pure',
  'timeout_ms',
  'requires',
  'provides',
];

/**
 * Map a `pipeline.configure` field key to the `Step` property it sets, or
 * `undefined` when the key is not configurable.
 */
function resolveConfigurableStepField(key: string): string | undefined {
  return CONFIGURABLE_STEP_FIELDS.get(key);
}

/**
 * Build an ExecutionStrategy from YAML pipeline configuration.
 *
 * Starts with `buildStandardStrategy()`, then applies:
 *   1. `remove` -- remove named steps
 *   2. `configure` -- update existing step fields
 *   3. `steps` -- resolve and insert custom steps
 *
 * @param pipelineConfig - The `pipeline` section from apcore.yaml.
 * @param deps - Forwarded to `buildStandardStrategy()`.
 * @returns Configured ExecutionStrategy.
 */
export async function buildStrategyFromConfig(
  pipelineConfig: PipelineConfig,
  deps: StandardStrategyDeps,
): Promise<ExecutionStrategy> {
  const strategy = buildStandardStrategy(deps);

  // (1) Remove steps — fail fast if target does not exist (§1.2)
  for (const stepName of pipelineConfig.remove ?? []) {
    if (strategy.findStepIndex(stepName) === undefined) {
      throw new ConfigurationError(
        `Cannot remove pipeline step '${stepName}': no such step in the strategy. ` +
          `Either remove this entry from pipeline.remove or insert a matching step first.`,
      );
    }
    strategy.remove(stepName);
  }

  // (2) Configure existing step fields — fail fast if target does not exist (§1.2)
  for (const [stepName, overrides] of Object.entries(pipelineConfig.configure ?? {})) {
    if (strategy.findStepIndex(stepName) === undefined) {
      throw new ConfigurationError(
        `Cannot configure pipeline step '${stepName}': no such step in the strategy. ` +
          `Either remove this entry from pipeline.configure or insert a matching step first.`,
      );
    }
    for (const step of strategy.steps) {
      if (step.name === stepName) {
        for (const [key, value] of Object.entries(overrides)) {
          const property = resolveConfigurableStepField(key);
          if (property === undefined) {
            throw new ConfigurationError(
              `Pipeline step '${stepName}' has no configurable field '${key}'. ` +
                `Valid fields are: ${CANONICAL_CONFIGURABLE_STEP_FIELDS.join(', ')} ` +
                `(the camelCase spellings ` +
                `${[...CONFIGURABLE_STEP_FIELDS.keys()]
                  .filter((k) => !CANONICAL_CONFIGURABLE_STEP_FIELDS.includes(k))
                  .join(', ')} are also accepted). ` +
                `'name', 'description', 'removable', 'replaceable' and 'execute' are ` +
                `deliberately NOT configurable — see CONFIGURABLE_STEP_FIELDS.`,
            );
          }
          (step as unknown as Record<string, unknown>)[property] = value;
        }
        break;
      }
    }
  }

  // (3) Resolve and insert custom steps — anchors must exist (§1.2)
  for (const stepDef of pipelineConfig.steps ?? []) {
    const step = await _resolveStep(stepDef);
    const after = stepDef.after;
    const before = stepDef.before;
    if (after) {
      if (strategy.findStepIndex(after) === undefined) {
        throw new ConfigurationError(
          `Cannot insert pipeline step '${step.name}' after '${after}': ` +
            `anchor step does not exist. Insert an anchor step first or use a valid anchor name.`,
        );
      }
      strategy.insertAfter(after, step);
    } else if (before) {
      if (strategy.findStepIndex(before) === undefined) {
        throw new ConfigurationError(
          `Cannot insert pipeline step '${step.name}' before '${before}': ` +
            `anchor step does not exist. Insert an anchor step first or use a valid anchor name.`,
        );
      }
      strategy.insertBefore(before, step);
    } else {
      throw new ConfigurationError(
        `Pipeline step '${step.name}' has neither 'after' nor 'before'. ` +
          `Specify one (or remove the step from pipeline.steps).`,
      );
    }
  }

  return strategy;
}
