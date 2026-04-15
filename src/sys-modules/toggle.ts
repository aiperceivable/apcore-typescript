/**
 * Module toggle system -- disable/enable modules without unloading.
 *
 * Implements system.control.toggle_feature as defined in PROTOCOL_SPEC.md:
 * - Error code: MODULE_DISABLED (HTTP 403)
 * - Canonical event: apcore.module.toggled
 * - See spec sections: "Error Codes" and "Canonical Event Types"
 */

import { InvalidInputError, ModuleNotFoundError, ModuleDisabledError } from '../errors.js';
import type { Registry } from '../registry/registry.js';
import type { EventEmitter } from '../events/emitter.js';
import { createEvent } from '../events/emitter.js';

/**
 * Toggle state container. Tracks which modules are disabled.
 * State survives module reload since it lives outside the Registry.
 */
export class ToggleState {
  private readonly _disabled: Set<string> = new Set();

  isDisabled(moduleId: string): boolean {
    return this._disabled.has(moduleId);
  }

  disable(moduleId: string): void {
    this._disabled.add(moduleId);
  }

  enable(moduleId: string): void {
    this._disabled.delete(moduleId);
  }

  clear(): void {
    this._disabled.clear();
  }
}

/** Default global toggle state. */
export const DEFAULT_TOGGLE_STATE = new ToggleState();

/** Check if a module is disabled using the default toggle state. */
export function isModuleDisabled(moduleId: string): boolean {
  return DEFAULT_TOGGLE_STATE.isDisabled(moduleId);
}

/** Throw ModuleDisabledError if the module is disabled. */
export function checkModuleDisabled(moduleId: string): void {
  if (isModuleDisabled(moduleId)) {
    throw new ModuleDisabledError(moduleId);
  }
}

/**
 * Disable or enable a module without unloading it from the Registry.
 * A disabled module remains registered but calls return MODULE_DISABLED error.
 * @internal
 */
export class ToggleFeatureModule {
  readonly description = 'Disable or enable a module without unloading it';
  readonly annotations = { readonly: false, destructive: false, idempotent: true, requiresApproval: true, openWorld: false, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const };
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      module_id: { type: 'string' as const, description: 'ID of the module to toggle' },
      enabled: { type: 'boolean' as const, description: 'True to enable, false to disable' },
      reason: { type: 'string' as const, description: 'Audit reason for the toggle' },
    },
    required: ['module_id', 'enabled', 'reason'],
  };
  readonly outputSchema = {
    type: 'object' as const,
    properties: {
      success: { type: 'boolean' as const, description: 'Whether the toggle succeeded' },
      module_id: { type: 'string' as const, description: 'ID of the toggled module' },
      enabled: { type: 'boolean' as const, description: 'Current enabled state' },
    },
    required: ['success', 'module_id', 'enabled'],
  };

  private readonly _registry: Registry;
  private readonly _emitter: EventEmitter;
  private readonly _toggleState: ToggleState;

  constructor(registry: Registry, eventEmitter: EventEmitter, toggleState?: ToggleState) {
    this._registry = registry;
    this._emitter = eventEmitter;
    this._toggleState = toggleState ?? DEFAULT_TOGGLE_STATE;
  }

  execute(inputs: Record<string, unknown>, _context: unknown): Record<string, unknown> {
    const { moduleId, enabled, reason } = this._validateInputs(inputs);
    if (!this._registry.has(moduleId)) {
      throw new ModuleNotFoundError(moduleId);
    }
    if (enabled) {
      this._toggleState.enable(moduleId);
    } else {
      this._toggleState.disable(moduleId);
    }
    // W-12: Event payload carries only { enabled } to match Python reference implementation.
    // `reason` is returned in the module output but not emitted in the event.
    this._emitter.emit(createEvent('apcore.module.toggled', moduleId, 'info', { enabled }));
    return { success: true, module_id: moduleId, enabled };
  }

  private _validateInputs(inputs: Record<string, unknown>): { moduleId: string; enabled: boolean; reason: string } {
    const moduleId = inputs['module_id'];
    if (typeof moduleId !== 'string' || !moduleId) {
      throw new InvalidInputError("'module_id' is required and must be a non-empty string");
    }
    const enabled = inputs['enabled'];
    if (typeof enabled !== 'boolean') {
      throw new InvalidInputError("'enabled' is required and must be a boolean");
    }
    const reason = inputs['reason'];
    if (typeof reason !== 'string' || !reason) {
      throw new InvalidInputError("'reason' is required and must be a non-empty string");
    }
    return { moduleId, enabled, reason };
  }
}
