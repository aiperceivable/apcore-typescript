/**
 * Tests for pipeline-config.ts: step type registry, _resolveStep, and buildStrategyFromConfig.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resolveStep,
  buildStrategyFromConfig,
  registerStepType,
  registeredStepTypes,
  unregisterStepType,
} from '../src/pipeline-config.js';
import type { Step, StepResult } from '../src/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalStep(name: string): Step {
  return {
    name,
    description: `Step ${name}`,
    removable: true,
    replaceable: true,
    execute: async (): Promise<StepResult> => ({ action: 'continue' }),
  };
}

const TEST_TYPE_PREFIX = '__test_pc_';

function uniqueType(suffix: string): string {
  return `${TEST_TYPE_PREFIX}${suffix}`;
}

// ---------------------------------------------------------------------------
// registerStepType / unregisterStepType / registeredStepTypes
// ---------------------------------------------------------------------------

describe('registerStepType', () => {
  const registeredNames: string[] = [];

  afterEach(() => {
    for (const name of registeredNames) {
      unregisterStepType(name);
    }
    registeredNames.length = 0;
  });

  it('registers a step type successfully', () => {
    const name = uniqueType('basic');
    registeredNames.push(name);
    registerStepType(name, (_config) => makeMinimalStep('from-factory'));
    expect(registeredStepTypes()).toContain(name);
  });

  it('throws when name is empty', () => {
    expect(() => registerStepType('', () => makeMinimalStep('x'))).toThrow(
      /Invalid step type name/,
    );
  });

  it('throws when name contains whitespace', () => {
    expect(() => registerStepType('has space', () => makeMinimalStep('x'))).toThrow(
      /Invalid step type name/,
    );
    expect(() => registerStepType('tab\there', () => makeMinimalStep('x'))).toThrow(
      /Invalid step type name/,
    );
  });

  it('throws when the same name is registered twice', () => {
    const name = uniqueType('dup');
    registeredNames.push(name);
    registerStepType(name, (_config) => makeMinimalStep('x'));
    expect(() => registerStepType(name, (_config) => makeMinimalStep('y'))).toThrow(
      /already registered/,
    );
  });
});

describe('unregisterStepType', () => {
  it('returns true and removes the registered type', () => {
    const name = uniqueType('to-remove');
    registerStepType(name, (_config) => makeMinimalStep('x'));
    const removed = unregisterStepType(name);
    expect(removed).toBe(true);
    expect(registeredStepTypes()).not.toContain(name);
  });

  it('returns false when type was not registered', () => {
    const result = unregisterStepType(uniqueType('nonexistent'));
    expect(result).toBe(false);
  });

  it('allows re-registration after unregister', () => {
    const name = uniqueType('reuse');
    registerStepType(name, (_config) => makeMinimalStep('a'));
    unregisterStepType(name);
    expect(() => registerStepType(name, (_config) => makeMinimalStep('b'))).not.toThrow();
    unregisterStepType(name);
  });
});

describe('registeredStepTypes', () => {
  it('returns an array of registered type names', () => {
    const name = uniqueType('listed');
    registerStepType(name, (_config) => makeMinimalStep('x'));
    expect(registeredStepTypes()).toContain(name);
    unregisterStepType(name);
  });
});

// ---------------------------------------------------------------------------
// _resolveStep
// ---------------------------------------------------------------------------

describe('_resolveStep', () => {
  const TEST_TYPE = uniqueType('resolve-test');

  beforeEach(() => {
    registerStepType(TEST_TYPE, (config) =>
      makeMinimalStep((config['stepName'] as string) ?? 'resolved'),
    );
  });

  afterEach(() => {
    unregisterStepType(TEST_TYPE);
  });

  it('resolves a step from a registered type', async () => {
    const step = await _resolveStep({ type: TEST_TYPE, config: { stepName: 'my-step' } });
    expect(step.name).toBe('my-step');
  });

  it('applies name override from step definition', async () => {
    const step = await _resolveStep({ type: TEST_TYPE, name: 'override-name', config: {} });
    expect(step.name).toBe('override-name');
  });

  it('rejects handler path missing colon separator', async () => {
    await expect(_resolveStep({ handler: 'no-colon-here' })).rejects.toThrow(
      /Expected format: 'module:exportName'/,
    );
  });

  it('rejects handler path containing path-traversal segments', async () => {
    await expect(_resolveStep({ handler: '../escape:fn' })).rejects.toThrow(
      /must not contain '\.\.'/,
    );
  });

  it('rejects handler path using file: URLs', async () => {
    await expect(_resolveStep({ handler: 'file:///etc/passwd:fn' })).rejects.toThrow(
      /must not use 'file:' URLs/,
    );
  });

  it('rejects handler path using http: URLs', async () => {
    await expect(_resolveStep({ handler: 'http://evil.com/mod.js:fn' })).rejects.toThrow(
      /must not use 'http:' URLs/,
    );
  });

  it('rejects handler path using data: URLs', async () => {
    await expect(
      _resolveStep({ handler: 'data:text/javascript,export const x=1:fn' }),
    ).rejects.toThrow(/must not use 'data:' URLs/);
  });

  it('rejects handler module that cannot be imported', async () => {
    await expect(_resolveStep({ handler: './nonexistent-module-xyz:fn' })).rejects.toThrow(
      /Cannot import handler module/,
    );
  });

  it('throws when type is unknown', async () => {
    await expect(_resolveStep({ type: uniqueType('not-registered') })).rejects.toThrow(
      /not registered/,
    );
  });

  it('throws when neither type nor handler is provided', async () => {
    await expect(_resolveStep({ name: 'bare-step' })).rejects.toThrow(
      /neither 'type' nor 'handler'/,
    );
  });

  it('forwards matchModules, ignoreErrors, pure, and timeoutMs overrides', async () => {
    const step = await _resolveStep({
      type: TEST_TYPE,
      matchModules: ['foo.*'],
      ignoreErrors: true,
      pure: true,
      timeoutMs: 500,
      config: {},
    });
    expect((step as any).matchModules).toEqual(['foo.*']);
    expect((step as any).ignoreErrors).toBe(true);
    expect((step as any).pure).toBe(true);
    expect((step as any).timeoutMs).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// buildStrategyFromConfig
// ---------------------------------------------------------------------------

describe('buildStrategyFromConfig', () => {
  // We use a real StandardStrategyDeps with minimal stubs because
  // buildStandardStrategy expects specific shape. Instead we test via
  // buildStrategyFromConfig with a registered custom step type.

  const CUSTOM_TYPE = uniqueType('build-test');

  beforeEach(() => {
    registerStepType(CUSTOM_TYPE, (_config) => makeMinimalStep('custom-step'));
  });

  afterEach(() => {
    unregisterStepType(CUSTOM_TYPE);
  });

  it('produces a strategy with standard steps when given empty config', async () => {
    const deps = makeFakeDeps();
    const strategy = await buildStrategyFromConfig({}, deps);
    expect(strategy.stepNames().length).toBeGreaterThan(0);
  });

  it('throws ConfigurationError when remove targets a nonexistent step (Issue #33 §1.2)', async () => {
    const deps = makeFakeDeps();
    await expect(
      buildStrategyFromConfig({ remove: ['nonexistent_step_xyz'] }, deps),
    ).rejects.toThrow(/nonexistent_step_xyz/);
  });

  it('throws ConfigurationError when a step has neither after nor before in steps list (Issue #33 §1.2)', async () => {
    const deps = makeFakeDeps();
    await expect(
      buildStrategyFromConfig(
        {
          steps: [{ type: CUSTOM_TYPE, name: 'custom-step' }],
        },
        deps,
      ),
    ).rejects.toThrow(/neither 'after' nor 'before'/);
  });

  it('inserts a custom step after a named standard step', async () => {
    const deps = makeFakeDeps();
    const baseStrategy = await buildStrategyFromConfig({}, deps);
    const firstName = baseStrategy.stepNames()[0];

    const insertType = uniqueType('insert-after');
    registerStepType(insertType, (_c) => makeMinimalStep('inserted-after'));
    try {
      const strategy = await buildStrategyFromConfig(
        {
          steps: [{ type: insertType, name: 'inserted-after', after: firstName }],
        },
        deps,
      );
      const names = strategy.stepNames();
      const firstIdx = names.indexOf(firstName);
      expect(names[firstIdx + 1]).toBe('inserted-after');
    } finally {
      unregisterStepType(insertType);
    }
  });

  it('inserts a custom step before a named standard step', async () => {
    const deps = makeFakeDeps();
    const baseStrategy = await buildStrategyFromConfig({}, deps);
    const lastName = baseStrategy.stepNames().at(-1)!;

    const insertType = uniqueType('insert-before');
    registerStepType(insertType, (_c) => makeMinimalStep('inserted-before'));
    try {
      const strategy = await buildStrategyFromConfig(
        {
          steps: [{ type: insertType, name: 'inserted-before', before: lastName }],
        },
        deps,
      );
      const names = strategy.stepNames();
      const lastIdx = names.indexOf(lastName);
      expect(names[lastIdx - 1]).toBe('inserted-before');
    } finally {
      unregisterStepType(insertType);
    }
  });
});

// ---------------------------------------------------------------------------
// pipeline.configure field validation (Issue #34 §2)
// ---------------------------------------------------------------------------

describe('buildStrategyFromConfig — pipeline.configure field validation', () => {
  // `BuiltinInputValidation` declares `pure`, `requires` and `provides` but NOT
  // `ignoreErrors` / `matchModules` / `timeoutMs`. The previous `key in step`
  // test therefore rejected exactly the fields its own error message advertised
  // as valid.
  it('the built-in step really does lack the optional fields (regression guard)', async () => {
    const strategy = await buildStrategyFromConfig({}, makeFakeDeps());
    const step = strategy.steps.find((s) => s.name === 'input_validation')!;
    expect('ignoreErrors' in step).toBe(false);
    expect('matchModules' in step).toBe(false);
    expect('timeoutMs' in step).toBe(false);
  });

  // The canonical spelling. schemas/apcore-config.schema.json $defs/PipelineStep
  // is snake_case, so this is what an operator actually writes in apcore.yaml
  // and what every conformance fixture carries. Accepting only camelCase left
  // three of the four fields unreachable from real YAML.
  it('accepts the canonical snake_case spellings from apcore.yaml', async () => {
    const strategy = await buildStrategyFromConfig(
      {
        configure: {
          input_validation: {
            ignore_errors: true,
            match_modules: ['executor.*'],
            pure: false,
            timeout_ms: 500,
          },
        } as never,
      },
      makeFakeDeps(),
    );
    const step = strategy.steps.find((s) => s.name === 'input_validation')!;
    expect(step.ignoreErrors).toBe(true);
    expect(step.matchModules).toEqual(['executor.*']);
    expect(step.pure).toBe(false);
    expect(step.timeoutMs).toBe(500);
  });

  it('accepts the camelCase aliases (the TypeScript Step surface)', async () => {
    const strategy = await buildStrategyFromConfig(
      {
        configure: {
          input_validation: { ignoreErrors: true, matchModules: ['api.*'], timeoutMs: 250 },
        },
      },
      makeFakeDeps(),
    );
    const step = strategy.steps.find((s) => s.name === 'input_validation')!;
    expect(step.ignoreErrors).toBe(true);
    expect(step.matchModules).toEqual(['api.*']);
    expect(step.timeoutMs).toBe(250);
  });

  // docs/features/middleware-system.md "Configuration safety" ships exactly
  // this YAML as the canonical example. A field set without requires/provides
  // makes the spec's own example throw.
  it('accepts requires/provides, as the spec example configures them', async () => {
    const strategy = await buildStrategyFromConfig(
      {
        configure: {
          input_validation: { requires: ['context'], provides: ['validated_inputs'] },
        } as never,
      },
      makeFakeDeps(),
    );
    const step = strategy.steps.find((s) => s.name === 'input_validation')!;
    expect(step.requires).toEqual(['context']);
    expect(step.provides).toEqual(['validated_inputs']);
  });

  it('rejects an unknown field and names the canonical spellings', async () => {
    await expect(
      buildStrategyFromConfig(
        { configure: { input_validation: { no_such_field: 1 } } as never },
        makeFakeDeps(),
      ),
    ).rejects.toThrow(
      /has no configurable field 'no_such_field'.*match_modules, ignore_errors, pure, timeout_ms, requires, provides/s,
    );
  });

  // Narrower than the old `key in step` on purpose: these are the step's
  // identity and its own mutation guards, and `in` walked the prototype chain
  // so `execute` was accepted too — a config file could replace the step body.
  it.each(['name', 'description', 'removable', 'replaceable', 'execute'])(
    'rejects the non-configurable field %s',
    async (field) => {
      await expect(
        buildStrategyFromConfig(
          { configure: { input_validation: { [field]: 'x' } } as never },
          makeFakeDeps(),
        ),
      ).rejects.toThrow(new RegExp(`has no configurable field '${field}'`));
    },
  );
});

// ---------------------------------------------------------------------------
// Minimal stub deps for buildStrategyFromConfig
// ---------------------------------------------------------------------------

function makeFakeDeps() {
  // StandardStrategyDeps shape -- provide minimal stubs
  return {
    registry: {
      get: (_id: string) => null,
    } as any,
    acl: null as any,
    config: {
      get: (_key: string, _def?: unknown) => undefined,
    } as any,
    middlewareManager: null as any,
    approvalHandler: null as any,
  };
}
