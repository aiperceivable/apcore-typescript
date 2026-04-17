/**
 * Pipeline YAML configuration: step type registry and strategy builder.
 */

import { buildStandardStrategy } from './builtin-steps.js';
import type { StandardStrategyDeps } from './builtin-steps.js';
import type { PipelineContext, Step, StepResult } from './pipeline.js';
import type { ExecutionStrategy } from './pipeline.js';

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
  if (handlerPath.startsWith('file:')) {
    throw new Error(`Handler path '${handlerPath}' must not use file: URLs.`);
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

  // Try constructor first (handles class exports), fall back to function call.
  let step: unknown;
  try {
    step = new (resolved as new (cfg: Record<string, unknown>) => Step)(config);
  } catch {
    step = (resolved as (cfg: Record<string, unknown>) => Step)(config);
  }
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

  // (1) Remove steps
  for (const stepName of pipelineConfig.remove ?? []) {
    try {
      strategy.remove(stepName);
    } catch (exc) {
      console.warn(`[apcore:pipeline-config] Cannot remove step '${stepName}': ${exc}`);
    }
  }

  // (2) Configure existing step fields
  for (const [stepName, overrides] of Object.entries(pipelineConfig.configure ?? {})) {
    for (const step of strategy.steps) {
      if (step.name === stepName) {
        for (const [key, value] of Object.entries(overrides)) {
          if (key in step) {
            (step as unknown as Record<string, unknown>)[key] = value;
          } else {
            console.warn(`[apcore:pipeline-config] Step '${stepName}' has no field '${key}'`);
          }
        }
        break;
      }
    }
  }

  // (3) Resolve and insert custom steps
  for (const stepDef of pipelineConfig.steps ?? []) {
    const step = await _resolveStep(stepDef);
    const after = stepDef.after;
    const before = stepDef.before;
    if (after) {
      strategy.insertAfter(after, step);
    } else if (before) {
      strategy.insertBefore(before, step);
    } else {
      console.warn(
        `[apcore:pipeline-config] Step '${step.name}' has neither 'after' nor 'before' -- skipping`,
      );
    }
  }

  return strategy;
}
