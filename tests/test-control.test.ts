import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateConfigModule, ReloadModuleModule } from '../src/sys-modules/control.js';
import { Config } from '../src/config.js';
import { Registry } from '../src/registry/registry.js';
import { EventEmitter } from '../src/events/emitter.js';
import {
  ConfigError,
  InvalidInputError,
  ModuleNotFoundError,
  ReloadFailedError,
} from '../src/errors.js';
import type { ApCoreEvent } from '../src/events/emitter.js';

describe('UpdateConfigModule', () => {
  let config: Config;
  let emitter: EventEmitter;
  let mod: UpdateConfigModule;

  beforeEach(() => {
    config = new Config({ some: { name: 'value' }, other: 'data' });
    emitter = new EventEmitter();
    mod = new UpdateConfigModule(config, emitter);
  });

  describe('input validation', () => {
    it('throws InvalidInputError when key is missing', () => {
      expect(() => mod.execute({ value: 'x', reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when key is empty string', () => {
      expect(() => mod.execute({ key: '', value: 'x', reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when key is not a string', () => {
      expect(() => mod.execute({ key: 123, value: 'x', reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is missing', () => {
      expect(() => mod.execute({ key: 'some.name', value: 'x' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is empty string', () => {
      expect(() => mod.execute({ key: 'some.name', value: 'x', reason: '' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is not a string', () => {
      expect(() => mod.execute({ key: 'some.name', value: 'x', reason: 42 }, null)).toThrow(InvalidInputError);
    });
  });

  describe('restricted keys', () => {
    it('throws ConfigError for sys_modules.enabled', () => {
      expect(() =>
        mod.execute({ key: 'sys_modules.enabled', value: false, reason: 'test' }, null),
      ).toThrow(ConfigError);
    });

    it('includes key name in ConfigError message', () => {
      expect(() =>
        mod.execute({ key: 'sys_modules.enabled', value: false, reason: 'test' }, null),
      ).toThrow(/sys_modules\.enabled/);
    });
  });

  describe('successful update', () => {
    it('updates the config value and returns correct result', () => {
      const result = mod.execute({ key: 'some.name', value: 'new_value', reason: 'testing' }, null);

      expect(result).toEqual({
        success: true,
        key: 'some.name',
        old_value: 'value',
        new_value: 'new_value',
      });
      expect(config.get('some.name')).toBe('new_value');
    });

    it('returns undefined as old_value when key did not exist', () => {
      const result = mod.execute({ key: 'brand.new', value: 'hello', reason: 'adding' }, null);

      expect(result).toEqual({
        success: true,
        key: 'brand.new',
        old_value: undefined,
        new_value: 'hello',
      });
    });

    it('allows setting value to null', () => {
      const result = mod.execute({ key: 'other', value: null, reason: 'clearing' }, null);

      expect(result.success).toBe(true);
      expect(result.new_value).toBeNull();
    });

    it('allows setting value to undefined', () => {
      const result = mod.execute({ key: 'other', value: undefined, reason: 'clearing' }, null);

      expect(result.success).toBe(true);
    });
  });

  describe('sensitive value redaction', () => {
    const sensitiveKeys = [
      'api.token',
      'db.secret',
      'service.key',
      'user.password',
      'oauth.auth',
      'vault.credential',
    ];

    for (const sensitiveKey of sensitiveKeys) {
      it(`redacts old_value and new_value for key containing '${sensitiveKey.split('.')[1]}'`, () => {
        config.set(sensitiveKey, 'old_secret_value');
        const result = mod.execute({ key: sensitiveKey, value: 'new_secret_value', reason: 'rotation' }, null);

        expect(result.old_value).toBe('***');
        expect(result.new_value).toBe('***');
      });
    }

    it('redacts values in the emitted event for sensitive keys', () => {
      const events: ApCoreEvent[] = [];
      emitter.subscribe({ onEvent: (e) => { events.push(e); } });

      config.set('api.token', 'old_token');
      mod.execute({ key: 'api.token', value: 'new_token', reason: 'rotate' }, null);

      expect(events).toHaveLength(1);
      expect(events[0].data['old_value']).toBe('***');
      expect(events[0].data['new_value']).toBe('***');
    });

    it('does not redact non-sensitive keys', () => {
      const result = mod.execute({ key: 'some.name', value: 'visible', reason: 'test' }, null);

      expect(result.old_value).toBe('value');
      expect(result.new_value).toBe('visible');
    });

    it('is case-insensitive for sensitivity detection', () => {
      config.set('api.TOKEN', 'old');
      // The key segments are lowercased before checking; 'TOKEN' -> 'token'
      // But the key itself has uppercase, so segment is 'TOKEN' -> lowercase -> 'token'
      const result = mod.execute({ key: 'api.TOKEN', value: 'new', reason: 'test' }, null);

      expect(result.old_value).toBe('***');
      expect(result.new_value).toBe('***');
    });
  });

  describe('event emission', () => {
    it('emits config_changed event with correct data', () => {
      const events: ApCoreEvent[] = [];
      emitter.subscribe({ onEvent: (e) => { events.push(e); } });

      mod.execute({ key: 'some.name', value: 'updated', reason: 'test' }, null);

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('config_changed');
      expect(events[0].moduleId).toBe('system.control.update_config');
      expect(events[0].severity).toBe('info');
      expect(events[0].data['key']).toBe('some.name');
      expect(events[0].data['old_value']).toBe('value');
      expect(events[0].data['new_value']).toBe('updated');
    });
  });
});

describe('ReloadModuleModule', () => {
  let registry: Registry;
  let emitter: EventEmitter;
  let mod: ReloadModuleModule;

  function createDummyModule(version: string = '1.0.0'): Record<string, unknown> {
    return {
      description: 'A dummy module',
      version,
      execute: () => ({ result: 'ok' }),
    };
  }

  beforeEach(() => {
    registry = new Registry();
    emitter = new EventEmitter();
    mod = new ReloadModuleModule(registry, emitter);
  });

  describe('input validation', () => {
    it('throws InvalidInputError when module_id is missing', async () => {
      await expect(mod.execute({ reason: 'test' }, null)).rejects.toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when module_id is empty string', async () => {
      await expect(mod.execute({ module_id: '', reason: 'test' }, null)).rejects.toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when module_id is not a string', async () => {
      await expect(mod.execute({ module_id: 123, reason: 'test' }, null)).rejects.toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is missing', async () => {
      await expect(mod.execute({ module_id: 'test.mod' }, null)).rejects.toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is empty string', async () => {
      await expect(mod.execute({ module_id: 'test.mod', reason: '' }, null)).rejects.toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is not a string', async () => {
      await expect(mod.execute({ module_id: 'test.mod', reason: 42 }, null)).rejects.toThrow(InvalidInputError);
    });
  });

  describe('module not found', () => {
    it('throws ModuleNotFoundError for unknown module_id', async () => {
      await expect(
        mod.execute({ module_id: 'nonexistent.mod', reason: 'test' }, null),
      ).rejects.toThrow(ModuleNotFoundError);
    });
  });

  describe('discover failure', () => {
    it('throws ReloadFailedError when discover fails', async () => {
      const dummy = createDummyModule('1.0.0');
      registry.registerInternal('system.test_mod', dummy);

      vi.spyOn(registry, 'discover').mockRejectedValue(new Error('disk error'));

      await expect(
        mod.execute({ module_id: 'system.test_mod', reason: 'update' }, null),
      ).rejects.toThrow(ReloadFailedError);
    });

    it('restores the original module when discover fails', async () => {
      const dummy = createDummyModule('1.0.0');
      registry.registerInternal('system.test_mod', dummy);

      vi.spyOn(registry, 'discover').mockRejectedValue(new Error('disk error'));

      try {
        await mod.execute({ module_id: 'system.test_mod', reason: 'update' }, null);
      } catch {
        // expected
      }

      const restored = registry.get('system.test_mod');
      expect(restored).toBe(dummy);
    });
  });

  describe('module not found after re-discovery', () => {
    it('throws ReloadFailedError when module is not found after discover', async () => {
      const dummy = createDummyModule('1.0.0');
      registry.registerInternal('system.test_mod', dummy);

      // discover succeeds but does not re-register the module
      vi.spyOn(registry, 'discover').mockResolvedValue(0);

      await expect(
        mod.execute({ module_id: 'system.test_mod', reason: 'update' }, null),
      ).rejects.toThrow(ReloadFailedError);
    });

    it('restores the original module when not found after re-discovery', async () => {
      const dummy = createDummyModule('1.0.0');
      registry.registerInternal('system.test_mod', dummy);

      vi.spyOn(registry, 'discover').mockResolvedValue(0);

      try {
        await mod.execute({ module_id: 'system.test_mod', reason: 'update' }, null);
      } catch {
        // expected
      }

      const restored = registry.get('system.test_mod');
      expect(restored).toBe(dummy);
    });
  });

  describe('successful reload', () => {
    it('returns success result with module_id, versions, and reload_duration_ms', async () => {
      const dummy = createDummyModule('1.0.0');
      registry.registerInternal('system.test_mod', dummy);

      const updatedDummy = createDummyModule('2.0.0');

      vi.spyOn(registry, 'discover').mockImplementation(async () => {
        // Simulate discover re-registering the module with a new version
        registry.registerInternal('system.test_mod', updatedDummy);
        return 1;
      });

      const result = await mod.execute({ module_id: 'system.test_mod', reason: 'upgrade' }, null);

      expect(result.success).toBe(true);
      expect(result.module_id).toBe('system.test_mod');
      expect(result.previous_version).toBe('1.0.0');
      expect(result.new_version).toBe('2.0.0');
      expect(typeof result.reload_duration_ms).toBe('number');
      expect(result.reload_duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('defaults version to 1.0.0 when module has no version field', async () => {
      const dummy = { description: 'no version', execute: () => ({}) };
      registry.registerInternal('system.test_mod', dummy);

      const reloaded = { description: 'no version v2', execute: () => ({}) };
      vi.spyOn(registry, 'discover').mockImplementation(async () => {
        registry.registerInternal('system.test_mod', reloaded);
        return 1;
      });

      const result = await mod.execute({ module_id: 'system.test_mod', reason: 'test' }, null);

      expect(result.previous_version).toBe('1.0.0');
      expect(result.new_version).toBe('1.0.0');
    });

    it('emits config_changed event on successful reload', async () => {
      const events: ApCoreEvent[] = [];
      emitter.subscribe({ onEvent: (e) => { events.push(e); } });

      const dummy = createDummyModule('1.0.0');
      registry.registerInternal('system.test_mod', dummy);

      const updatedDummy = createDummyModule('2.0.0');
      vi.spyOn(registry, 'discover').mockImplementation(async () => {
        registry.registerInternal('system.test_mod', updatedDummy);
        return 1;
      });

      await mod.execute({ module_id: 'system.test_mod', reason: 'upgrade' }, null);

      // Filter for config_changed events (registry also emits register/unregister via callbacks)
      const configEvents = events.filter((e) => e.eventType === 'config_changed');
      expect(configEvents).toHaveLength(1);
      expect(configEvents[0].moduleId).toBe('system.test_mod');
      expect(configEvents[0].severity).toBe('info');
      expect(configEvents[0].data['previous_version']).toBe('1.0.0');
      expect(configEvents[0].data['new_version']).toBe('2.0.0');
    });
  });
});
