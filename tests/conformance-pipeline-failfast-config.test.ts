/**
 * Cross-language conformance driver for `pipeline_failfast_config.json`
 * (Issue #33 — docs/features/middleware-system.md, "Configuration safety").
 *
 * Fixture source: apcore/conformance/fixtures/pipeline_failfast_config.json
 * (canonical). No `driver_contract` block; the `description` is the contract:
 * missing step references and unmet `requires:` MUST raise typed errors at
 * parse / construction time, never a warning and never deferred to the first
 * `call()`.
 *
 * NO NAMING TRANSLATION
 * ---------------------
 * The fixture's YAML is fed to `buildStrategyFromConfig` UNMANGLED. An earlier
 * revision of this driver carried a private `FIELD_NAME_TRANSLATION` map
 * (`ignore_errors` -> `ignoreErrors`, ...) so the SDK would accept the
 * fixture's snake_case. That map hid the real defect: the schema, every
 * `apcore.yaml` and every fixture are snake_case, so a user copying the
 * canonical YAML still got `ConfigurationError`. The SDK now normalises both
 * spellings itself (src/pipeline-config.ts CONFIGURABLE_STEP_FIELDS) and this
 * driver asserts that by passing the fixture bytes straight through.
 *
 * THREE DEFECTS THIS DRIVER USED TO PIN, ALL NOW FIXED
 * ----------------------------------------------------
 *  1. The fixture encoded `pipeline.configure` as a LIST of `{name, ...}`.
 *     It is an object map keyed by step name — what $defs/PipelineConfig
 *     declares and what all three SDKs parse. Corrected in the fixture.
 *  2. The fixture named the built-in step `validate_input`. No SDK has a step
 *     by that name; it is `input_validation` everywhere. This mattered: the
 *     case needs one VALID key to isolate the invalid one, so with both keys
 *     invalid the assertion it exists to make was unreachable.
 *  3. `buildStrategyFromConfig` validated override fields with `key in step`.
 *     matchModules / ignoreErrors / pure / timeoutMs are OPTIONAL on the Step
 *     interface, so configuring `ignoreErrors` on BuiltinInputValidation —
 *     which does not declare it — was rejected, with an error message that
 *     listed `ignoreErrors` as valid. Fixed in src/pipeline-config.ts by
 *     validating against the configurable-field set — which is keyed by the
 *     canonical snake_case spelling and accepts the camelCase alias, so the
 *     fixture's YAML needs no massaging on the way in.
 *
 * A fourth case, `missing_step_in_step_middleware_raises_configuration_error`,
 * was removed from the fixture: `pipeline.step_middleware:` is a config section
 * no SDK has ever parsed, and inventing one to satisfy a fixture is backwards.
 *
 * ASSERT THE WIRE CODE, NOT THE CLASS NAME. All three SDKs name this class
 * `ConfigurationError` while they emitted three different codes, so a
 * class-name assertion passed everywhere and proved nothing.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConfigurationError, buildStrategyFromConfig } from '../src/pipeline-config.js';
import {
  ExecutionStrategy,
  PipelineDependencyError,
  PipelineEngine,
  type PipelineContext,
  type Step,
  type StepResult,
} from '../src/pipeline.js';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function findFixturesRoot(): string {
  const envPath = process.env.APCORE_SPEC_REPO;
  if (envPath) {
    const fixtures = path.join(envPath, 'conformance', 'fixtures');
    if (fs.existsSync(fixtures)) return fixtures;
    throw new Error(`APCORE_SPEC_REPO=${envPath} does not contain conformance/fixtures/`);
  }
  const repoRoot = path.resolve(__dirname, '..');
  const sibling = path.resolve(repoRoot, '..', 'apcore', 'conformance', 'fixtures');
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(
    'Cannot find apcore conformance fixtures. Set APCORE_SPEC_REPO or clone ' +
      `apcore as a sibling at ${path.resolve(repoRoot, '..', 'apcore')}.`,
  );
}

interface FailfastCase {
  readonly id: string;
  readonly description: string;
  readonly input: {
    readonly yaml?: { readonly pipeline: Record<string, unknown> };
    readonly strategy?: {
      readonly name: string;
      readonly steps: ReadonlyArray<{
        readonly name: string;
        readonly requires?: readonly string[];
        readonly provides?: readonly string[];
      }>;
    };
  };
  readonly expected: Record<string, unknown>;
}

function loadFixture(name: string): { description: string; test_cases: readonly FailfastCase[] } {
  return JSON.parse(fs.readFileSync(path.join(findFixturesRoot(), `${name}.json`), 'utf-8'));
}

const fixture = loadFixture('pipeline_failfast_config');

function caseById(id: string): FailfastCase {
  const tc = fixture.test_cases.find((c) => c.id === id);
  if (tc === undefined) {
    throw new Error(
      `pipeline_failfast_config.json no longer contains case '${id}'. The fixture is ` +
        'canonical — update this driver to match it, do not edit the fixture.',
    );
  }
  return tc;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeDeps() {
  return {
    registry: { get: () => null },
    acl: null,
    config: { get: () => undefined },
    middlewareManager: null,
    approvalHandler: null,
    // Only the config-parsing path runs; no step ever executes.
  } as unknown as Parameters<typeof buildStrategyFromConfig>[1];
}

/** A no-op step carrying the fixture's declared requires/provides. */
function makeStep(name: string, requires?: readonly string[], provides?: readonly string[]): Step {
  return {
    name,
    description: `Conformance stand-in for ${name}`,
    removable: true,
    replaceable: true,
    requires,
    provides,
    execute: async (): Promise<StepResult> => ({ action: 'continue' }),
  };
}

function strategyFrom(tc: FailfastCase): ExecutionStrategy {
  const def = tc.input.strategy!;
  return new ExecutionStrategy(
    def.name,
    def.steps.map((s) => makeStep(s.name, s.requires, s.provides)),
  );
}

describe('Conformance: pipeline configuration fail-fast (pipeline_failfast_config.json)', () => {
  // -------------------------------------------------------------------------
  it('missing_step_in_configure_raises_configuration_error', async () => {
    const tc = caseById('missing_step_in_configure_raises_configuration_error');
    // Straight from the fixture — snake_case keys, real step names, no map.
    const configure = tc.input.yaml!.pipeline['configure'] as Record<
      string,
      Record<string, unknown>
    >;

    let error: unknown = null;
    try {
      await buildStrategyFromConfig({ configure }, makeFakeDeps());
    } catch (err) {
      error = err;
    }

    expect(error !== null).toBe(tc.expected['raises']);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(tc.expected['error_message_contains']);
    // The wire code is the contract. The class name is shared by all three
    // SDKs and therefore distinguishes nothing.
    expect((error as ConfigurationError).code).toBe(tc.expected['error_code']);
    // raised_at: parse_time / deferred_to_first_call: false — the throw came out
    // of buildStrategyFromConfig itself; no strategy object was ever returned,
    // so nothing could defer it to a first call().
    expect(tc.expected['raised_at']).toBe('parse_time');
    expect(tc.expected['deferred_to_first_call']).toBe(false);
  });

  // -------------------------------------------------------------------------
  it('unmet_requires_raises_pipeline_dependency_error', () => {
    const tc = caseById('unmet_requires_raises_pipeline_dependency_error');

    let error: unknown = null;
    try {
      strategyFrom(tc);
    } catch (err) {
      error = err;
    }

    expect(error !== null).toBe(tc.expected['raises']);
    expect(error).toBeInstanceOf(PipelineDependencyError);
    // The wire code, not the class name — the fixture has no `error_type` key
    // for exactly the reason stated in the header.
    expect((error as PipelineDependencyError).code).toBe(tc.expected['error_code']);
    for (const fragment of tc.expected['error_message_contains'] as string[]) {
      expect((error as Error).message).toContain(fragment);
    }
    // raised_at: strategy_construction — the throw came from the
    // `new ExecutionStrategy(...)` call itself, not from a later run.
    expect(tc.expected['raised_at']).toBe('strategy_construction');
  });

  // -------------------------------------------------------------------------
  it('satisfied_requires_constructs_successfully', async () => {
    const tc = caseById('satisfied_requires_constructs_successfully');

    let error: unknown = null;
    let strategy: ExecutionStrategy | null = null;
    try {
      strategy = strategyFrom(tc);
    } catch (err) {
      error = err;
    }
    expect(error !== null, `unexpected error: ${String(error)}`).toBe(tc.expected['raises']);

    // strategy_callable: prove it by actually running it end to end.
    const ctx = {
      moduleId: 'demo.greet',
      inputs: {},
      // Stand-in Context: the stub steps read no context fields.
      context: {} as PipelineContext['context'],
      output: null,
    } as PipelineContext;
    const [, trace] = await new PipelineEngine().run(strategy!, ctx);
    expect(trace.success).toBe(tc.expected['strategy_callable']);
    expect(trace.steps.map((s) => s.name)).toEqual(
      tc.input.strategy!.steps.map((s) => s.name),
    );
  });

  // -------------------------------------------------------------------------
  it('drives every fixture case', () => {
    expect(fixture.test_cases.map((c) => c.id)).toEqual([
      'missing_step_in_configure_raises_configuration_error',
      'unmet_requires_raises_pipeline_dependency_error',
      'satisfied_requires_constructs_successfully',
    ]);
  });
});
