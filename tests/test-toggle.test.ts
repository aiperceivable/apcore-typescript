import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ToggleState,
  defaultToggleState,
  isModuleDisabled,
  checkModuleDisabled,
  ToggleFeatureModule,
} from '../src/sys-modules/toggle.js';
import { InvalidInputError, ModuleNotFoundError, ModuleDisabledError } from '../src/errors.js';
import { Registry } from '../src/registry/registry.js';
import { EventEmitter } from '../src/events/emitter.js';
import type { ApCoreEvent } from '../src/events/emitter.js';

describe('ToggleState', () => {
  let state: ToggleState;

  beforeEach(() => {
    state = new ToggleState();
  });

  it('reports module as not disabled by default', () => {
    expect(state.isDisabled('some.module')).toBe(false);
  });

  it('disables a module', () => {
    state.disable('my.module');
    expect(state.isDisabled('my.module')).toBe(true);
  });

  it('enables a previously disabled module', () => {
    state.disable('my.module');
    state.enable('my.module');
    expect(state.isDisabled('my.module')).toBe(false);
  });

  it('enable is a no-op for a module that is not disabled', () => {
    state.enable('unknown.module');
    expect(state.isDisabled('unknown.module')).toBe(false);
  });

  it('clears all disabled modules', () => {
    state.disable('a');
    state.disable('b');
    state.clear();
    expect(state.isDisabled('a')).toBe(false);
    expect(state.isDisabled('b')).toBe(false);
  });

  it('tracks multiple modules independently', () => {
    state.disable('a');
    state.disable('b');
    expect(state.isDisabled('a')).toBe(true);
    expect(state.isDisabled('b')).toBe(true);
    state.enable('a');
    expect(state.isDisabled('a')).toBe(false);
    expect(state.isDisabled('b')).toBe(true);
  });
});

describe('defaultToggleState', () => {
  afterEach(() => {
    defaultToggleState.clear();
  });

  it('is an instance of ToggleState', () => {
    expect(defaultToggleState).toBeInstanceOf(ToggleState);
  });
});

describe('isModuleDisabled', () => {
  afterEach(() => {
    defaultToggleState.clear();
  });

  it('returns false when module is not disabled', () => {
    expect(isModuleDisabled('some.module')).toBe(false);
  });

  it('delegates to defaultToggleState', () => {
    defaultToggleState.disable('some.module');
    expect(isModuleDisabled('some.module')).toBe(true);
  });

  it('returns false after module is re-enabled', () => {
    defaultToggleState.disable('some.module');
    defaultToggleState.enable('some.module');
    expect(isModuleDisabled('some.module')).toBe(false);
  });
});

describe('checkModuleDisabled', () => {
  afterEach(() => {
    defaultToggleState.clear();
  });

  it('does nothing when module is not disabled', () => {
    expect(() => checkModuleDisabled('ok.module')).not.toThrow();
  });

  it('throws ModuleDisabledError when module is disabled', () => {
    defaultToggleState.disable('bad.module');
    expect(() => checkModuleDisabled('bad.module')).toThrow(ModuleDisabledError);
  });
});

describe('ToggleFeatureModule', () => {
  let registry: Registry;
  let emitter: EventEmitter;
  let toggleState: ToggleState;
  let toggle: ToggleFeatureModule;
  let capturedEvents: ApCoreEvent[];

  beforeEach(() => {
    registry = new Registry();
    emitter = new EventEmitter();
    toggleState = new ToggleState();
    toggle = new ToggleFeatureModule(registry, emitter, toggleState);
    capturedEvents = [];

    emitter.subscribe({
      onEvent(event: ApCoreEvent) {
        capturedEvents.push(event);
      },
    });

    // Register a dummy module so toggle can find it
    registry.registerInternal('test.dummy', { description: 'dummy module for testing' });
  });

  afterEach(() => {
    defaultToggleState.clear();
  });

  describe('input validation', () => {
    it('throws InvalidInputError when module_id is missing', () => {
      expect(() => toggle.execute({ enabled: true, reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when module_id is empty string', () => {
      expect(() => toggle.execute({ module_id: '', enabled: true, reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when module_id is not a string', () => {
      expect(() => toggle.execute({ module_id: 123, enabled: true, reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when enabled is missing', () => {
      expect(() => toggle.execute({ module_id: 'test.dummy', reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when enabled is not a boolean', () => {
      expect(() => toggle.execute({ module_id: 'test.dummy', enabled: 'true', reason: 'test' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is missing', () => {
      expect(() => toggle.execute({ module_id: 'test.dummy', enabled: true }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is empty string', () => {
      expect(() => toggle.execute({ module_id: 'test.dummy', enabled: true, reason: '' }, null)).toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when reason is not a string', () => {
      expect(() => toggle.execute({ module_id: 'test.dummy', enabled: true, reason: 42 }, null)).toThrow(InvalidInputError);
    });
  });

  it('throws ModuleNotFoundError for an unregistered module', () => {
    expect(() =>
      toggle.execute({ module_id: 'nonexistent.module', enabled: false, reason: 'test' }, null),
    ).toThrow(ModuleNotFoundError);
  });

  it('disables a module', () => {
    toggle.execute({ module_id: 'test.dummy', enabled: false, reason: 'maintenance' }, null);
    expect(toggleState.isDisabled('test.dummy')).toBe(true);
  });

  it('enables a previously disabled module', () => {
    toggleState.disable('test.dummy');
    toggle.execute({ module_id: 'test.dummy', enabled: true, reason: 'back online' }, null);
    expect(toggleState.isDisabled('test.dummy')).toBe(false);
  });

  it('emits module_health_changed event with enabled and reason in data', () => {
    toggle.execute({ module_id: 'test.dummy', enabled: false, reason: 'shutting down' }, null);

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0];
    expect(event.eventType).toBe('module_health_changed');
    expect(event.moduleId).toBe('test.dummy');
    expect(event.severity).toBe('info');
    expect(event.data).toEqual(expect.objectContaining({ enabled: false, reason: 'shutting down' }));
  });

  it('returns success result with module_id, enabled, and reason', () => {
    const result = toggle.execute(
      { module_id: 'test.dummy', enabled: false, reason: 'disabled for test' },
      null,
    );
    expect(result).toEqual({
      success: true,
      module_id: 'test.dummy',
      enabled: false,
      reason: 'disabled for test',
    });
  });

  it('returns correct result when enabling a module', () => {
    toggleState.disable('test.dummy');
    const result = toggle.execute(
      { module_id: 'test.dummy', enabled: true, reason: 're-enabled' },
      null,
    );
    expect(result).toEqual({
      success: true,
      module_id: 'test.dummy',
      enabled: true,
      reason: 're-enabled',
    });
  });
});
