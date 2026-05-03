/**
 * System control modules -- runtime config update and hot-reload.
 */

import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import { ConfigError, InvalidInputError, ModuleNotFoundError, ReloadFailedError, ModuleReloadConflictError } from '../errors.js';
import type { Registry } from '../registry/registry.js';
import type { EventEmitter } from '../events/emitter.js';
import { createEvent } from '../events/emitter.js';
import type { Config } from '../config.js';
import type { Context } from '../context.js';
import type { AuditStore } from './audit.js';
import { buildAuditEntry } from './audit.js';
import { matchPattern } from '../utils/pattern.js';
import type { OverridesStore } from './overrides.js';

const RESTRICTED_KEYS = new Set(['sys_modules.enabled']);

const SENSITIVE_SEGMENTS = ['token', 'secret', 'key', 'password', 'auth', 'credential'] as const;

/** Match exact segments or underscore-compound segments (api_key, auth_token). */
function isSensitiveKey(key: string): boolean {
  return key.toLowerCase().split('.').some((seg) =>
    SENSITIVE_SEGMENTS.some((s) => seg === s || seg.endsWith(`_${s}`) || seg.startsWith(`${s}_`)),
  );
}

export interface UpdateConfigOptions {
  auditStore?: AuditStore;
  overridesPath?: string;
  /** Pluggable persistent override store (Issue #45.1). */
  overridesStore?: OverridesStore;
}

export class UpdateConfigModule {
  readonly description = 'Update a runtime configuration value by dot-path key';
  readonly annotations = { readonly: false, destructive: false, idempotent: true, requiresApproval: true, openWorld: false, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const };
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      key: { type: 'string' as const, description: 'Dot-path config key' },
      value: { description: 'New value' },
      reason: { type: 'string' as const, description: 'Audit reason' },
    },
    required: ['key', 'value', 'reason'],
  };
  readonly outputSchema = {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' as const, description: 'Whether the update succeeded' },
      key: { type: 'string' as const, description: 'Updated config key' },
      old_value: { description: 'Previous value (redacted for sensitive keys)' },
      new_value: { description: 'New value (redacted for sensitive keys)' },
    },
    required: ['success', 'key', 'old_value', 'new_value'],
  };

  private readonly _config: Config;
  private readonly _emitter: EventEmitter;
  private readonly _auditStore: AuditStore | null;
  private readonly _overridesPath: string | null;
  private readonly _overridesStore: OverridesStore | null;

  constructor(config: Config, eventEmitter: EventEmitter, options?: UpdateConfigOptions) {
    this._config = config;
    this._emitter = eventEmitter;
    this._auditStore = options?.auditStore ?? null;
    this._overridesPath = options?.overridesPath ?? null;
    this._overridesStore = options?.overridesStore ?? null;
  }

  execute(inputs: Record<string, unknown>, context: unknown): Record<string, unknown> {
    const { key, value, reason } = this._validateInputs(inputs);
    const ctx = context as Context | null;

    if (RESTRICTED_KEYS.has(key)) {
      throw new ConfigError(`Configuration key '${key}' cannot be changed at runtime`);
    }

    const oldValue = this._config.get(key);
    this._config.set(key, value);

    const isSensitive = isSensitiveKey(key);
    const safeOld = isSensitive ? '***' : oldValue;
    const safeNew = isSensitive ? '***' : value;

    if (this._overridesPath !== null) {
      this._persistOverride(key, value);
    }

    if (this._overridesStore !== null) {
      this._persistOverrideToStore(key, value);
    }

    const entry = buildAuditEntry('update_config', 'system.control.update_config', ctx, { before: safeOld, after: safeNew });
    if (this._auditStore !== null) {
      this._auditStore.append(entry);
    } else {
      console.warn(`[apcore:audit] update_config key=${key} actor=${entry.actorId} reason=${reason}`);
    }

    this._emitter.emit(createEvent('apcore.config.updated', 'system.control.update_config', 'info', {
      key, old_value: safeOld, new_value: safeNew,
    }));

    console.warn(`[apcore:control] Config updated: key=${key} old_value=${safeOld} new_value=${safeNew} reason=${reason}`);

    return { success: true, key, old_value: safeOld, new_value: safeNew };
  }

  private _persistOverrideToStore(key: string, value: unknown): void {
    try {
      const store = this._overridesStore!;
      const loaded = store.load();
      if (loaded !== null && typeof (loaded as { then?: unknown }).then === 'function') {
        // Async store — fire-and-forget the read-modify-write so execute() stays sync.
        (loaded as Promise<Record<string, unknown>>)
          .then((existing) => {
            existing[key] = value;
            return store.save(existing);
          })
          .catch((err: unknown) => {
            console.warn(`[apcore:control] Failed to persist override for key '${key}' via OverridesStore:`, err);
          });
        return;
      }
      const existing = loaded as Record<string, unknown>;
      existing[key] = value;
      const saveResult = store.save(existing);
      if (saveResult !== undefined && typeof (saveResult as { then?: unknown }).then === 'function') {
        (saveResult as Promise<void>).catch((err: unknown) => {
          console.warn(`[apcore:control] Failed to persist override for key '${key}' via OverridesStore:`, err);
        });
      }
    } catch (err) {
      console.warn(`[apcore:control] Failed to persist override for key '${key}' via OverridesStore:`, err);
    }
  }

  private _persistOverride(key: string, value: unknown): void {
    let overrides: Record<string, unknown> = {};
    if (fs.existsSync(this._overridesPath!)) {
      try {
        const content = fs.readFileSync(this._overridesPath!, 'utf-8');
        const parsed = yaml.load(content);
        if (typeof parsed === 'object' && parsed !== null) {
          overrides = parsed as Record<string, unknown>;
        }
      } catch {
        // Start fresh if parse fails
      }
    }
    overrides[key] = value;
    try {
      fs.writeFileSync(this._overridesPath!, yaml.dump(overrides), 'utf-8');
    } catch (err) {
      console.warn(`[apcore:control] Failed to persist override for key '${key}':`, err);
    }
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

/** @internal */
export class ReloadModule {
  readonly description = 'Hot-reload a module by safe unregister and re-discover';
  readonly annotations = { readonly: false, destructive: false, idempotent: true, requiresApproval: true, openWorld: false, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const };
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      module_id: { type: 'string' as const, description: 'ID of the module to reload (mutually exclusive with path_filter)' },
      path_filter: { type: 'string' as const, description: 'Glob pattern to bulk-reload matching modules (mutually exclusive with module_id)' },
      reload_dependents: { type: 'boolean' as const, description: 'When true, also reload modules that depend on matched modules' },
      reason: { type: 'string' as const, description: 'Audit reason for the reload' },
    },
    required: ['reason'],
  };
  readonly outputSchema = {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' as const, description: 'Whether the reload succeeded' },
      module_id: { type: 'string' as const, description: 'ID of the reloaded module (single-module mode)' },
      reloaded_modules: { type: 'array' as const, description: 'IDs of reloaded modules (path_filter mode)' },
      previous_version: { type: 'string' as const, description: 'Version before reload' },
      new_version: { type: 'string' as const, description: 'Version after reload' },
      reload_duration_ms: { type: 'number' as const, description: 'Reload duration in milliseconds' },
    },
    required: ['success'],
  };

  private readonly _registry: Registry;
  private readonly _emitter: EventEmitter;
  private readonly _auditStore: AuditStore | null;

  constructor(registry: Registry, eventEmitter: EventEmitter, auditStore?: AuditStore) {
    this._registry = registry;
    this._emitter = eventEmitter;
    this._auditStore = auditStore ?? null;
  }

  async execute(inputs: Record<string, unknown>, context: unknown): Promise<Record<string, unknown>> {
    const { moduleId, pathFilter, reason } = this._validateInputs(inputs);
    const ctx = context as Context | null;

    if (pathFilter !== undefined) {
      return this._reloadWithPathFilter(pathFilter, reason, ctx);
    }

    return this._reloadSingleModule(moduleId!, reason, ctx);
  }

  private async _reloadSingleModule(moduleId: string, reason: string, ctx: Context | null): Promise<Record<string, unknown>> {
    const existing = this._registry.get(moduleId);
    if (existing === null) {
      throw new ModuleNotFoundError(moduleId);
    }
    const existingObj = existing as Record<string, unknown>;
    const previousVersion = String(existingObj['version'] ?? '1.0.0');

    let suspendedState: Record<string, unknown> | null = null;
    if (typeof existingObj['onSuspend'] === 'function') {
      try {
        suspendedState = (existingObj['onSuspend'] as () => Record<string, unknown> | null)();
      } catch (err) {
        console.warn(`[apcore:control] onSuspend failed for ${moduleId}:`, err);
      }
    }

    const start = performance.now();
    await this._registry.safeUnregister(moduleId);

    try {
      await this._registry.discover();
    } catch (err) {
      this._registry.registerInternal(moduleId, existing);
      throw new ReloadFailedError(moduleId, String(err));
    }

    const reloaded = this._registry.get(moduleId);
    if (reloaded === null) {
      this._registry.registerInternal(moduleId, existing);
      throw new ReloadFailedError(moduleId, `Module '${moduleId}' was not found after re-discovery`);
    }

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

    const entry = buildAuditEntry('reload_module', moduleId, ctx, { before: previousVersion, after: newVersion });
    if (this._auditStore !== null) {
      this._auditStore.append(entry);
    } else {
      console.warn(`[apcore:audit] reload_module ${moduleId} actor=${entry.actorId} reason=${reason}`);
    }

    this._emitter.emit(createEvent('apcore.module.reloaded', moduleId, 'info', {
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

  private async _reloadWithPathFilter(pathFilter: string, reason: string, ctx: Context | null): Promise<Record<string, unknown>> {
    const allIds = this._registry.list();
    const matchingIds = allIds.filter((id) => matchPattern(pathFilter, id)).sort();

    // Capture existing modules and versions before unregistering
    const existingModules = new Map<string, unknown>();
    const previousVersions = new Map<string, string>();
    for (const id of matchingIds) {
      const mod = this._registry.get(id);
      if (mod !== null) {
        existingModules.set(id, mod);
        previousVersions.set(id, String((mod as Record<string, unknown>)['version'] ?? '1.0.0'));
      }
    }

    // Unregister all matching modules
    for (const id of matchingIds) {
      await this._registry.safeUnregister(id);
    }

    // Re-discover
    try {
      await this._registry.discover();
    } catch (err) {
      for (const [id, mod] of existingModules) {
        this._registry.registerInternal(id, mod);
      }
      throw new ReloadFailedError(pathFilter, String(err));
    }

    // Collect successfully reloaded modules
    const reloadedModules: string[] = [];
    for (const id of matchingIds) {
      const reloaded = this._registry.get(id);
      if (reloaded === null) {
        const orig = existingModules.get(id);
        if (orig !== undefined) {
          this._registry.registerInternal(id, orig);
        }
      } else {
        reloadedModules.push(id);
        const entry = buildAuditEntry('reload_module', id, ctx, {
          before: previousVersions.get(id) ?? '1.0.0',
          after: String((reloaded as Record<string, unknown>)['version'] ?? '1.0.0'),
        });
        if (this._auditStore !== null) {
          this._auditStore.append(entry);
        }
      }
    }

    console.warn(`[apcore:control] Bulk reload: path_filter=${pathFilter} reloaded=${reloadedModules.length} reason=${reason}`);

    return { success: true, reloaded_modules: reloadedModules };
  }

  private _validateInputs(inputs: Record<string, unknown>): { moduleId?: string; pathFilter?: string; reason: string } {
    const moduleId = inputs['module_id'];
    const pathFilter = inputs['path_filter'];

    if (moduleId !== undefined && pathFilter !== undefined) {
      throw new ModuleReloadConflictError();
    }
    if (moduleId === undefined && pathFilter === undefined) {
      throw new InvalidInputError("either 'module_id' or 'path_filter' is required");
    }

    if (moduleId !== undefined) {
      if (typeof moduleId !== 'string' || !moduleId) {
        throw new InvalidInputError("'module_id' is required and must be a non-empty string");
      }
    }
    if (pathFilter !== undefined) {
      if (typeof pathFilter !== 'string' || !pathFilter) {
        throw new InvalidInputError("'path_filter' must be a non-empty string");
      }
    }

    const reason = inputs['reason'];
    if (typeof reason !== 'string' || !reason) {
      throw new InvalidInputError("'reason' is required and must be a non-empty string");
    }

    return {
      moduleId: moduleId as string | undefined,
      pathFilter: pathFilter as string | undefined,
      reason,
    };
  }
}
