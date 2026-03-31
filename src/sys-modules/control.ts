/**
 * System control modules -- runtime config update and hot-reload.
 */

import { ConfigError, InvalidInputError, ModuleNotFoundError, ReloadFailedError } from '../errors.js';
import type { Registry } from '../registry/registry.js';
import type { EventEmitter } from '../events/emitter.js';
import { createEvent } from '../events/emitter.js';
import type { Config } from '../config.js';

const RESTRICTED_KEYS = new Set(['sys_modules.enabled']);

const SENSITIVE_SEGMENTS = new Set(['token', 'secret', 'key', 'password', 'auth', 'credential']);

export class UpdateConfigModule {
  readonly description = 'Update a runtime configuration value by dot-path key';
  readonly annotations = { readonly: false, destructive: false, idempotent: true, requiresApproval: true, openWorld: false, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const };

  private readonly _config: Config;
  private readonly _emitter: EventEmitter;

  constructor(config: Config, eventEmitter: EventEmitter) {
    this._config = config;
    this._emitter = eventEmitter;
  }

  execute(inputs: Record<string, unknown>, _context: unknown): Record<string, unknown> {
    const { key, value, reason } = this._validateInputs(inputs);

    if (RESTRICTED_KEYS.has(key)) {
      throw new ConfigError(`Configuration key '${key}' cannot be changed at runtime`);
    }

    const oldValue = this._config.get(key);
    this._config.set(key, value);

    const isSensitive = key.toLowerCase().split('.').some((seg) => SENSITIVE_SEGMENTS.has(seg));
    const safeOld = isSensitive ? '***' : oldValue;
    const safeNew = isSensitive ? '***' : value;

    // Emit canonical event first, then legacy alias for transition period
    this._emitter.emit(createEvent('apcore.config.updated', 'system.control.update_config', 'info', {
      key, old_value: safeOld, new_value: safeNew,
    }));
    this._emitter.emit(createEvent('config_changed', 'system.control.update_config', 'info', {
      key, old_value: safeOld, new_value: safeNew,
    }));

    console.warn(`[apcore:control] Config updated: key=${key} old_value=${safeOld} new_value=${safeNew} reason=${reason}`);

    return { success: true, key, old_value: safeOld, new_value: safeNew };
  }

  private _validateInputs(inputs: Record<string, unknown>): { key: string; value: unknown; reason: string } {
    const key = inputs['key'];
    if (typeof key !== 'string' || !key) {
      throw new InvalidInputError("'key' is required and must not be empty");
    }
    const reason = inputs['reason'];
    if (typeof reason !== 'string' || !reason) {
      throw new InvalidInputError("'reason' is required and must not be empty");
    }
    const value = inputs['value'];
    return { key, value, reason };
  }
}

export class ReloadModuleModule {
  readonly description = 'Hot-reload a module by safe unregister and re-discover';
  readonly annotations = { readonly: false, destructive: false, idempotent: true, requiresApproval: true, openWorld: false, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const };

  private readonly _registry: Registry;
  private readonly _emitter: EventEmitter;

  constructor(registry: Registry, eventEmitter: EventEmitter) {
    this._registry = registry;
    this._emitter = eventEmitter;
  }

  async execute(inputs: Record<string, unknown>, _context: unknown): Promise<Record<string, unknown>> {
    const { moduleId, reason } = this._validateInputs(inputs);

    const existing = this._registry.get(moduleId);
    if (existing === null) {
      throw new ModuleNotFoundError(moduleId);
    }
    const existingObj = existing as Record<string, unknown>;
    const previousVersion = String(existingObj['version'] ?? '1.0.0');

    // Capture suspend state from old module (if onSuspend is defined)
    let suspendedState: Record<string, unknown> | null = null;
    if (typeof existingObj['onSuspend'] === 'function') {
      try {
        suspendedState = (existingObj['onSuspend'] as () => Record<string, unknown> | null)();
      } catch (err) {
        console.warn(`[apcore:control] onSuspend failed for ${moduleId}:`, err);
      }
    }

    const start = performance.now();
    this._registry.unregister(moduleId);

    try {
      await this._registry.discover();
    } catch (err) {
      // Restore original module on discover failure
      this._registry.registerInternal(moduleId, existing);
      throw new ReloadFailedError(moduleId, String(err));
    }

    const reloaded = this._registry.get(moduleId);
    if (reloaded === null) {
      // Restore original module if not found after re-discovery
      this._registry.registerInternal(moduleId, existing);
      throw new ReloadFailedError(moduleId, `Module '${moduleId}' was not found after re-discovery`);
    }

    // Resume state on new module (if state was captured and onResume is defined)
    const reloadedObj = reloaded as Record<string, unknown>;
    if (suspendedState !== null && typeof reloadedObj['onResume'] === 'function') {
      try {
        (reloadedObj['onResume'] as (state: Record<string, unknown>) => void)(suspendedState);
      } catch (err) {
        console.warn(`[apcore:control] onResume failed for ${moduleId}:`, err);
      }
    }

    const elapsedMs = performance.now() - start;
    const newVersion = String(reloadedObj['version'] ?? '1.0.0');

    // Emit canonical event first, then legacy alias for transition period
    this._emitter.emit(createEvent('apcore.module.reloaded', moduleId, 'info', {
      previous_version: previousVersion,
      new_version: newVersion,
    }));
    this._emitter.emit(createEvent('config_changed', moduleId, 'info', {
      previous_version: previousVersion,
      new_version: newVersion,
    }));

    console.warn(
      `[apcore:control] Module reloaded: module_id=${moduleId} previous_version=${previousVersion} new_version=${newVersion} reason=${reason}`,
    );

    return {
      success: true,
      module_id: moduleId,
      previous_version: previousVersion,
      new_version: newVersion,
      reload_duration_ms: elapsedMs,
    };
  }

  private _validateInputs(inputs: Record<string, unknown>): { moduleId: string; reason: string } {
    const moduleId = inputs['module_id'];
    if (typeof moduleId !== 'string' || !moduleId) {
      throw new InvalidInputError("'module_id' is required and must be a non-empty string");
    }
    const reason = inputs['reason'];
    if (typeof reason !== 'string' || !reason) {
      throw new InvalidInputError("'reason' is required and must be a non-empty string");
    }
    return { moduleId, reason };
  }
}
