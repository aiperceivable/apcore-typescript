import { describe, it, expect, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Config } from '../src/config.js';
import { Registry } from '../src/registry/registry.js';
import { Executor } from '../src/executor.js';
import {
  registerSysModules,
  registerSubscriberType,
  unregisterSubscriberType,
  resetSubscriberRegistry,
} from '../src/sys-modules/registration.js';

describe('registerSysModules', () => {
  it('returns empty context when sys_modules.enabled is false', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const config = new Config({ sys_modules: { enabled: false } });
    const ctx = registerSysModules(registry, executor, config);
    expect(ctx.errorHistory).toBeUndefined();
    expect(ctx.eventEmitter).toBeUndefined();
  });

  it('registers health modules when enabled', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const config = new Config({ sys_modules: { enabled: true } });
    const ctx = registerSysModules(registry, executor, config);
    expect(ctx.errorHistory).toBeDefined();
    expect(registry.has('system.health.summary')).toBe(true);
    expect(registry.has('system.health.module')).toBe(true);
  });

  it('registers manifest modules when enabled', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const config = new Config({ sys_modules: { enabled: true } });
    registerSysModules(registry, executor, config);
    expect(registry.has('system.manifest.module')).toBe(true);
    expect(registry.has('system.manifest.full')).toBe(true);
  });

  it('registers usage modules when enabled', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const config = new Config({ sys_modules: { enabled: true } });
    const ctx = registerSysModules(registry, executor, config);
    expect(ctx.usageCollector).toBeDefined();
    expect(ctx.usageMiddleware).toBeDefined();
    expect(registry.has('system.usage.summary')).toBe(true);
    expect(registry.has('system.usage.module')).toBe(true);
  });

  it('registers control modules only when events are enabled', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const config = new Config({
      sys_modules: { enabled: true, events: { enabled: false } },
    });
    registerSysModules(registry, executor, config);
    expect(registry.has('system.control.toggle_feature')).toBe(false);
    expect(registry.has('system.control.update_config')).toBe(false);
    expect(registry.has('system.control.reload_module')).toBe(false);
  });

  it('registers control modules and PlatformNotifyMiddleware when events enabled', () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const config = new Config({
      sys_modules: { enabled: true, events: { enabled: true } },
    });
    const ctx = registerSysModules(registry, executor, config);
    expect(ctx.eventEmitter).toBeDefined();
    expect(ctx.platformNotifyMiddleware).toBeDefined();
    expect(registry.has('system.control.toggle_feature')).toBe(true);
    expect(registry.has('system.control.update_config')).toBe(true);
    expect(registry.has('system.control.reload_module')).toBe(true);
  });

  it('calls system.health.summary successfully', async () => {
    const registry = new Registry();
    const executor = new Executor({ registry });
    const config = new Config({ sys_modules: { enabled: true } });
    registerSysModules(registry, executor, config);

    // Register a dummy module
    registry.registerInternal('test.mod', {
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'test',
      execute: () => ({ ok: true }),
    });

    const result = await executor.call('system.health.summary', {});
    expect(result['summary']).toBeDefined();
    expect((result['summary'] as Record<string, unknown>)['total_modules']).toBeGreaterThan(0);
  });
});

describe('subscriber registry', () => {
  afterEach(() => {
    resetSubscriberRegistry();
  });

  it('registers and uses a subscriber type', () => {
    const factory = (cfg: Record<string, unknown>) => ({
      onEvent: () => { void cfg; },
    });
    registerSubscriberType('custom', factory);
    // No error means registration succeeded
  });

  it('unregisters a subscriber type', () => {
    registerSubscriberType('temp', () => ({ onEvent: () => {} }));
    unregisterSubscriberType('temp');
    expect(() => unregisterSubscriberType('temp')).toThrow('not registered');
  });

  it('throws when unregistering unknown type', () => {
    expect(() => unregisterSubscriberType('unknown')).toThrow('not registered');
  });

  it('resets custom types but preserves built-in types', () => {
    registerSubscriberType('custom1', () => ({ onEvent: () => {} }));
    registerSubscriberType('custom2', () => ({ onEvent: () => {} }));
    resetSubscriberRegistry();
    expect(() => unregisterSubscriberType('custom1')).toThrow('not registered');
    // Built-in types should survive reset
    unregisterSubscriberType('webhook');
    unregisterSubscriberType('a2a');
  });

  it('has built-in webhook and a2a types', () => {
    // Should not throw — they are pre-registered
    unregisterSubscriberType('webhook');
    unregisterSubscriberType('a2a');
  });
});
