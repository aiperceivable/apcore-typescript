/**
 * Pipeline YAML configuration: step type registry and strategy builder.
 */

import type { Step, PipelineContext, StepResult } from './pipeline.js';
import { ExecutionStrategy } from './pipeline.js';
import { buildStandardStrategy } from './builtin-steps.js';
import type { StandardStrategyDeps } from './builtin-steps.js';

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
export function registerStepType(
  name: string,
  factory: StepFactory,
): void {
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
 * Resolution order:
 *   1. `type` field -> look up in registry
 *   2. `handler` field -> dynamic import (TypeScript-native)
 *   3. Neither -> throw Error
 */
export function _resolveStep(stepDef: StepDefinition): Step {
  const typeName = stepDef.type;
  const handlerPath = stepDef.handler;
  const config = stepDef.config ?? {};

  // (1) Try type registry
  if (typeName && _stepTypeRegistry.has(typeName)) {
    const factory = _stepTypeRegistry.get(typeName)!;
    const step = factory(config);
    return new ConfiguredStep(step, stepDef);
  }

  // (2) Handler path (dynamic import placeholder)
  if (handlerPath) {
    throw new Error(
      `Dynamic handler import '${handlerPath}' is not supported in TypeScript SDK. ` +
      `Use registerStepType() to register the step type, then reference it via 'type'.`,
    );
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
export function buildStrategyFromConfig(
  pipelineConfig: PipelineConfig,
  deps: StandardStrategyDeps,
): ExecutionStrategy {
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
    const step = _resolveStep(stepDef);
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
