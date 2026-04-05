/**
 * High-level client for apcore to simplify interaction.
 */

import type { TSchema } from '@sinclair/typebox';
import type { Config } from './config.js';
import type { Context } from './context.js';
import { FunctionModule, module as createModule } from './decorator.js';
import type { ApCoreEvent, EventSubscriber } from './events/emitter.js';
import { EventEmitter } from './events/emitter.js';
import { Executor } from './executor.js';
import type { Middleware } from './middleware/index.js';
import type { ModuleAnnotations, ModuleExample, PreflightResult } from './module.js';
import type { MetricsCollector } from './observability/metrics.js';
import { Registry } from './registry/registry.js';
import { registerSysModules } from './sys-modules/registration.js';
import type { SysModulesContext } from './sys-modules/registration.js';

export interface APCoreOptions {
  registry?: Registry;
  executor?: Executor;
  config?: Config;
  metricsCollector?: MetricsCollector;
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
  private _sysModulesContext: SysModulesContext = {};

  constructor(options?: APCoreOptions) {
    this.registry = options?.registry ?? new Registry();
    this.config = options?.config ?? null;
    this.metricsCollector = options?.metricsCollector ?? null;
    this.executor = options?.executor ?? new Executor({
      registry: this.registry,
      config: this.config,
    });

    // Auto-register sys modules if config is provided and enabled
    if (this.config) {
      this._sysModulesContext = registerSysModules(
        this.registry,
        this.executor,
        this.config,
        options?.metricsCollector,
      );
    }
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
      throw new Error(
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
   */
  off(subscriber: EventSubscriber): void {
    const emitter = this.events;
    if (!emitter) {
      throw new Error(
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
    if (!this._sysModulesContext.eventEmitter) {
      throw new Error(
        `Cannot call ${method}(): sys_modules with events must be enabled in config.`,
      );
    }
  }
}
