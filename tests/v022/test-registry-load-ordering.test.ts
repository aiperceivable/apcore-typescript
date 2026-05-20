import { describe, it, expect } from 'vitest';
import { Registry } from '../../src/registry/registry.js';
import { InvalidInputError } from '../../src/errors.js';

describe('Registry on_load ordering (#65)', () => {
  it('module with sync onLoad is visible immediately after register()', async () => {
    const registry = new Registry();
    let loaded = false;
    const mod = {
      id: 'test.sync',
      description: 'test',
      inputSchema: {},
      outputSchema: {},
      onLoad() { loaded = true; },
      async execute() { return {}; },
    };
    await registry.register('test.sync', mod);
    expect(loaded).toBe(true);
    expect(registry.get('test.sync')).toBe(mod);
  });

  it('module with async onLoad is NOT visible until onLoad resolves', async () => {
    const registry = new Registry();
    let resolveLoad!: () => void;
    const loadPromise = new Promise<void>((r) => { resolveLoad = r; });

    const mod = {
      id: 'test.async',
      description: 'test',
      inputSchema: {},
      outputSchema: {},
      async onLoad() { await loadPromise; },
      async execute() { return {}; },
    };

    // Start registration but do NOT await it yet
    const registerPromise = registry.register('test.async', mod);

    // Module should NOT be visible yet (onLoad hasn't resolved)
    expect(registry.get('test.async')).toBeNull();
    expect(registry.has('test.async')).toBe(false);

    // Resolve onLoad
    resolveLoad();
    await registerPromise;

    // Now the module should be visible
    expect(registry.get('test.async')).toBe(mod);
    expect(registry.has('test.async')).toBe(true);
  });

  it('concurrent registrations of same ID during onLoad throw DUPLICATE error', async () => {
    const registry = new Registry();
    let resolveLoad!: () => void;
    const loadPromise = new Promise<void>((r) => { resolveLoad = r; });

    const mod1 = {
      id: 'test.concurrent',
      description: 'test',
      inputSchema: {},
      outputSchema: {},
      async onLoad() { await loadPromise; },
      async execute() { return {}; },
    };
    const mod2 = {
      id: 'test.concurrent',
      description: 'test',
      inputSchema: {},
      outputSchema: {},
      async execute() { return {}; },
    };

    // Start first registration (in-flight, onLoad not done)
    const r1 = registry.register('test.concurrent', mod1);

    // Second registration of same ID while first is in-flight should throw
    // (throws synchronously because conflict detection runs before async onLoad)
    expect(() => registry.register('test.concurrent', mod2)).toThrow(InvalidInputError);

    resolveLoad();
    await r1;
    expect(registry.get('test.concurrent')).toBe(mod1);
  });

  it('async onLoad failure rolls back registration', async () => {
    const registry = new Registry();
    const mod = {
      id: 'test.failload',
      description: 'test',
      inputSchema: {},
      outputSchema: {},
      async onLoad() { throw new Error('onLoad failed async'); },
      async execute() { return {}; },
    };

    await expect(registry.register('test.failload', mod)).rejects.toThrow('onLoad failed async');
    expect(registry.get('test.failload')).toBeNull();
    expect(registry.has('test.failload')).toBe(false);
  });

  it('register() without async onLoad works synchronously when not awaited', () => {
    // Existing sync callers: no await, no async onLoad — should still work
    const registry = new Registry();
    const mod = {
      id: 'test.compat',
      description: 'test',
      inputSchema: {},
      outputSchema: {},
      async execute() { return {}; },
    };
    // Not awaiting — sync usage should be backward-compatible for modules without onLoad
    void registry.register('test.compat', mod);
    // Sync modules visible immediately (no async onLoad)
    expect(registry.get('test.compat')).toBe(mod);
  });
});
