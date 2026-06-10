/**
 * High-level client for apcore to simplify interaction.
 */

import type { TSchema } from '@sinclair/typebox';
import type { Config } from './config.js';
import type { Context } from './context.js';
import { FunctionModule, module as createModule } from './decorator.js';
import { SysModulesDisabledError } from './errors.js';
import type { ApCoreEvent, EventSubscriber } from './events/emitter.js';
import { EventEmitter } from './events/emitter.js';
import { Executor } from './executor.js';
import type { Middleware } from './middleware/index.js';
import type { ModuleAnnotations, ModuleExample, PreflightResult } from './module.js';
import type { MetricsCollector } from './observability/metrics.js';
import { Registry } from './registry/registry.js';
import type { RegisterSysModulesOptions, SysModulesContext } from './sys-modules/registration.js';
import { ToggleState } from './sys-modules/toggle.js';

/**
 * Optional Node-side hook that auto-registers system modules when an
 * `APCore` is constructed with a non-null `Config`. Installed by the
 * Node entry's side-effect import of `./sys-modules/install.ts`.
 *
 * Browser bundles never import the installer, so `_sysModulesInstaller`
 * stays `null` and the constructor skips auto-registration. Browser
 * callers either pass `config: undefined` (the recommended path) or
 * register sys-modules manually after construction.
 */
type SysModulesInstaller = (
  registry: Registry,
  executor: Executor,
  config: Config,
  metricsCollector?: MetricsCollector | null,
  options?: RegisterSysModulesOptions,
) => SysModulesContext;
let _sysModulesInstaller: SysModulesInstaller | null = null;

/** @internal — used by the Node-only `./sys-modules/install.ts` side-effect. */
export function _setSysModulesInstaller(fn: SysModulesInstaller): void {
  _sysModulesInstaller = fn;
}

export interface APCoreOptions {
  registry?: Registry;
  executor?: Executor;
  config?: Config;
  metricsCollector?: MetricsCollector;
  /**
   * Per-instance ToggleState (Issue #71). Each APCore instance owns one
   * ToggleState that is injected into both the toggle module (write path)
   * and the Executor's pipeline lookup (read path), so disabling a module
   * is isolated to this instance and survives reload. Defaults to a fresh
   * `new ToggleState()`. Ignored when a pre-built `executor` is supplied.
   */
  toggleState?: ToggleState;
}

export interface ModuleOptions {
  id?: string;
  inputSchema: TSchema;
  outputSchema: TSchema;
  description?: string;
  documentation?: string | null;
  annotations?: ModuleAnnotations | null;
  tags?: string[] | null;
  version?: string;
  metadata?: Record<string, unknown> | null;
  examples?: ModuleExample[] | null;
  display?: Record<string, unknown> | null;
  execute: (inputs: Record<string, unknown>, context: Context) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * A high-level client that manages Registry and Executor.
 *
 * Provides a unified entry point for apcore, making it easier
 * for beginners to get started without manually managing multiple objects.
 */
export class APCore {
  readonly registry: Registry;
  readonly executor: Executor;
  readonly config: Config | null;
  readonly metricsCollector: MetricsCollector | null;
  /**
   * Per-instance ToggleState (Issue #71). Shared between the toggle module
   * (write path, via the sys-modules installer) and the Executor's pipeline
   * lookup (read path) so toggles are isolated to this instance.
   */
  private readonly _toggleState: ToggleState;
  private _sysModulesContext: SysModulesContext = {};

  constructor(options?: APCoreOptions) {
    this.registry = options?.registry ?? new Registry();
    this.config = options?.config ?? null;
    this._toggleState = options?.toggleState ?? new ToggleState();

    this.metricsCollector = options?.metricsCollector ?? null;
    this.executor =
      options?.executor ??
      new Executor({
        registry: this.registry,
        config: this.config,
        // Read path: the pipeline's BuiltinModuleLookup observes this same
        // ToggleState instance (Issue #71).
        toggleState: this._toggleState,
      });

    // Auto-register sys modules if config is provided AND the Node-side
    // installer is wired up. In browser bundles `_sysModulesInstaller`
    // remains null, so this branch is skipped — keeping the chain to
    // `node:fs`/`node:path` (sys-modules/registration.ts and friends)
    // out of the browser closure.
    if (this.config && _sysModulesInstaller) {
      this._sysModulesContext = _sysModulesInstaller(
        this.registry,
        this.executor,
        this.config,
        options?.metricsCollector,
        // Write path: ToggleFeatureModule mutates this same ToggleState
        // instance (Issue #71).
        { toggleState: this._toggleState },
      );
    }
  }

  /**
   * The per-instance ToggleState backing this client's enable/disable calls
   * and pipeline disabled-module checks (Issue #71). Exposed for inspection
   * and conformance testing; mutate via {@link disable}/{@link enable}.
   */
  get toggleState(): ToggleState {
    return this._toggleState;
  }

  /**
   * Create and register a FunctionModule.
   *
   * TypeScript version requires explicit schemas (no runtime type inference).
   */
  module(options: ModuleOptions): FunctionModule {
    return createModule({
      ...options,
      registry: this.registry,
    });
  }

  /**
   * Register a module object directly.
   */
  register(moduleId: string, moduleObj: unknown): void {
    this.registry.register(moduleId, moduleObj);
  }

  /**
   * Execute an async module call.
   */
  async call(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    versionHint?: string | null,
  ): Promise<Record<string, unknown>> {
    return this.executor.call(moduleId, inputs, context, versionHint);
  }

  /**
   * Async module call (alias for call).
   */
  async callAsync(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    versionHint?: string | null,
  ): Promise<Record<string, unknown>> {
    return this.executor.call(moduleId, inputs, context, versionHint);
  }

  /**
   * Stream module output chunk by chunk.
   */
  async *stream(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
    versionHint?: string | null,
  ): AsyncGenerator<Record<string, unknown>> {
    yield* this.executor.stream(moduleId, inputs, context, versionHint);
  }

  /**
   * Non-destructive preflight check without execution.
   */
  async validate(
    moduleId: string,
    inputs?: Record<string, unknown> | null,
    context?: Context | null,
  ): Promise<PreflightResult> {
    return this.executor.validate(moduleId, inputs, context);
  }

  /**
   * Get module description info (for AI/LLM use).
   */
  describe(moduleId: string): string {
    return this.registry.describe(moduleId);
  }

  /**
   * Add class-based middleware. Returns self for chaining.
   */
  use(middleware: Middleware): APCore {
    this.executor.use(middleware);
    return this;
  }

  /**
   * Add before function middleware. Returns self for chaining.
   */
  useBefore(callback: (moduleId: string, inputs: Record<string, unknown>, context: Context) => Record<string, unknown> | null): APCore {
    this.executor.useBefore(callback);
    return this;
  }

  /**
   * Add after function middleware. Returns self for chaining.
   */
  useAfter(callback: (moduleId: string, inputs: Record<string, unknown>, output: Record<string, unknown>, context: Context) => Record<string, unknown> | null): APCore {
    this.executor.useAfter(callback);
    return this;
  }

  /**
   * Remove middleware by identity. Returns true if found and removed.
   */
  remove(middleware: Middleware): boolean {
    return this.executor.remove(middleware);
  }

  /**
   * Discover and register modules from configured extension directories.
   */
  async discover(): Promise<number> {
    return this.registry.discover();
  }

  /**
   * Return sorted list of registered module IDs, optionally filtered.
   */
  listModules(options?: { tags?: string[]; prefix?: string }): string[] {
    return this.registry.list(options);
  }

  /**
   * Access the event emitter (available when sys_modules.events is enabled).
   */
  get events(): EventEmitter | null {
    return this._sysModulesContext.eventEmitter ?? null;
  }

  /**
   * Subscribe to events of a specific type with a simple callback.
   *
   * Returns the subscriber for later unsubscription via off().
   */
  on(
    eventType: string,
    handler: (event: ApCoreEvent) => void | Promise<void>,
  ): EventSubscriber {
    const emitter = this.events;
    if (!emitter) {
      throw new SysModulesDisabledError(
        'Events are not enabled. Set sys_modules.enabled=true and '
        + 'sys_modules.events.enabled=true in config.',
      );
    }
    const subscriber: EventSubscriber = {
      onEvent(event: ApCoreEvent) {
        if (event.eventType === eventType) {
          return handler(event);
        }
      },
    };
    emitter.subscribe(subscriber);
    return subscriber;
  }

  /**
   * Unsubscribe a previously registered event subscriber.
   *
   * @throws {SysModulesDisabledError} If events are not enabled
   *   (code `SYS_MODULES_DISABLED`).
   */
  off(subscriber: EventSubscriber): void {
    const emitter = this.events;
    if (!emitter) {
      throw new SysModulesDisabledError(
        'Events are not enabled. Set sys_modules.enabled=true and '
        + 'sys_modules.events.enabled=true in config.',
      );
    }
    emitter.unsubscribe(subscriber);
  }

  /**
   * Disable a module without unloading it.
   * Convenience wrapper around system.control.toggle_feature.
   */
  async disable(moduleId: string, reason: string = 'Disabled via APCore client'): Promise<Record<string, unknown>> {
    this._requireSysModules('disable');
    return this.executor.call('system.control.toggle_feature', {
      module_id: moduleId,
      enabled: false,
      reason,
    });
  }

  /**
   * Re-enable a previously disabled module.
   * Convenience wrapper around system.control.toggle_feature.
   */
  async enable(moduleId: string, reason: string = 'Enabled via APCore client'): Promise<Record<string, unknown>> {
    this._requireSysModules('enable');
    return this.executor.call('system.control.toggle_feature', {
      module_id: moduleId,
      enabled: true,
      reason,
    });
  }

  private _requireSysModules(method: string): void {
    if (!this._sysModulesContext || Object.keys(this._sysModulesContext).length === 0) {
      throw new SysModulesDisabledError(
        `Cannot call ${method}(): sys_modules must be enabled in config.`,
      );
    }
  }
}
