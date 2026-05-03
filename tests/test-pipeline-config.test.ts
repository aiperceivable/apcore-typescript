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
