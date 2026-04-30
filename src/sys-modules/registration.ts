/**
 * Auto-registration of sys.* modules and middleware from config.
 */

import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import type { Registry } from '../registry/registry.js';
import type { Executor } from '../executor.js';
import type { Config } from '../config.js';
import type { MetricsCollector } from '../observability/metrics.js';
import type { AuditStore } from './audit.js';
import { SysModuleRegistrationError } from '../errors.js';
import { ErrorHistory } from '../observability/error-history.js';
import { ErrorHistoryMiddleware } from '../middleware/error-history.js';
import { UsageCollector, UsageMiddleware } from '../observability/usage.js';
import type { EventSubscriber } from '../events/emitter.js';
import { EventEmitter, createEvent } from '../events/emitter.js';
import { WebhookSubscriber, A2ASubscriber, FileSubscriber, StdoutSubscriber, FilterSubscriber } from '../events/subscribers.js';
import { PlatformNotifyMiddleware } from '../middleware/platform-notify.js';
import { HealthSummaryModule, HealthModule } from './health.js';
import { ManifestFullModule, ManifestModule } from './manifest.js';
import { ToggleFeatureModule } from './toggle.js';
import { UpdateConfigModule, ReloadModule } from './control.js';
import { UsageSummaryModule, UsageModule } from './usage.js';

// ---------------------------------------------------------------------------
// Namespace-mode helpers — §9.15.3
// ---------------------------------------------------------------------------

/** §9.15.3: Return sys_modules namespace dict in namespace mode, null in legacy. */
function _resolveSysCfg(config: Config): Record<string, unknown> | null {
  // C-6: Access config.mode directly via the public getter — no unsafe cast needed.
  if (config.mode === 'namespace') {
    return (config.namespace('sys_modules') as Record<string, unknown>) ?? {};
  }
  return null;
}

function _nestedGet(data: Record<string, unknown>, dottedKey: string, defaultValue: unknown): unknown {
  let current: unknown = data;
  for (const key of dottedKey.split('.')) {
    if (typeof current !== 'object' || current === null) return defaultValue;
    const obj = current as Record<string, unknown>;
    if (!(key in obj)) return defaultValue;
    current = obj[key];
  }
  return current;
}

function _cfgGet(
  sysCfg: Record<string, unknown> | null,
  config: Config,
  subKey: string,
  defaultValue: unknown,
): unknown {
  if (sysCfg !== null) {
    return _nestedGet(sysCfg, subKey, defaultValue);
  }
  return config.get(`sys_modules.${subKey}`, defaultValue);
}

// ---------------------------------------------------------------------------
// Subscriber type registry — extensible factory for EventSubscriber types
// ---------------------------------------------------------------------------

type SubscriberFactory = (config: Record<string, unknown>) => EventSubscriber;

const _subscriberFactories: Map<string, SubscriberFactory> = new Map();

function _registerBuiltInFactories(): void {
  _subscriberFactories.set('webhook', (config: Record<string, unknown>): EventSubscriber => {
    const url = config['url'] as string;
    const headers = config['headers'] as Record<string, string> | undefined;
    const retryCount = config['retry_count'] as number | undefined;
    const timeoutMs = config['timeout_ms'] as number | undefined;
    return new WebhookSubscriber(url, headers, retryCount, timeoutMs);
  });

  _subscriberFactories.set('a2a', (config: Record<string, unknown>): EventSubscriber => {
    const platformUrl = config['platform_url'] as string;
    const auth = config['auth'] as string | Record<string, string> | undefined;
    const timeoutMs = config['timeout_ms'] as number | undefined;
    return new A2ASubscriber(platformUrl, auth, timeoutMs);
  });

  _subscriberFactories.set('file', (config: Record<string, unknown>): EventSubscriber => {
    const path = config['path'];
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`file subscriber requires a non-empty "path" string field`);
    }
    const append = config['append'] as boolean | undefined;
    const format = config['format'] as string | undefined;
    const rotateBytes = config['rotate_bytes'] as number | undefined;
    return new FileSubscriber(path, append, format, rotateBytes);
  });

  _subscriberFactories.set('stdout', (config: Record<string, unknown>): EventSubscriber => {
    const format = config['format'] as string | undefined;
    const levelFilter = config['level_filter'] as string | undefined;
    return new StdoutSubscriber(format, levelFilter);
  });

  _subscriberFactories.set('filter', (config: Record<string, unknown>): EventSubscriber => {
    const delegateType = config['delegate_type'];
    if (typeof delegateType !== 'string') {
      throw new Error(`filter subscriber requires a "delegate_type" string field`);
    }
    const delegateConfig = (config['delegate_config'] ?? {}) as Record<string, unknown>;
    const delegateFactory = _subscriberFactories.get(delegateType);
    if (delegateFactory === undefined) {
      throw new Error(`Unknown delegate subscriber type '${delegateType}' for filter subscriber`);
    }
    const delegate = delegateFactory(delegateConfig);
    const includeEvents = config['include_events'] as string[] | undefined;
    const excludeEvents = config['exclude_events'] as string[] | undefined;
    return new FilterSubscriber(delegate, includeEvents, excludeEvents);
  });
}

// Register built-in factories on module load
_registerBuiltInFactories();

/** Register a custom subscriber type for config-driven instantiation. */
export function registerSubscriberType(
  typeName: string,
  factory: SubscriberFactory,
): void {
  _subscriberFactories.set(typeName, factory);
}

/** Remove a previously registered subscriber type. */
export function unregisterSubscriberType(typeName: string): void {
  if (!_subscriberFactories.has(typeName)) {
    throw new Error(`Subscriber type '${typeName}' is not registered`);
  }
  _subscriberFactories.delete(typeName);
}

/** Reset the registry to built-in types only. Intended for test teardown. */
export function resetSubscriberRegistry(): void {
  _subscriberFactories.clear();
  _registerBuiltInFactories();
}

/**
 * Instantiate a single subscriber from a config object.
 * The `type` field selects the factory; all other fields are passed as config.
 */
export function createSubscriberFromConfig(config: Record<string, unknown>): EventSubscriber {
  const typeName = config['type'] as string | undefined;
  if (typeof typeName !== 'string') {
    throw new Error('Subscriber config missing "type" field');
  }
  const factory = _subscriberFactories.get(typeName);
  if (factory === undefined) {
    throw new Error(`Unknown subscriber type '${typeName}'`);
  }
  return factory(config);
}

/**
 * Instantiate subscribers from config and subscribe them to the emitter.
 */
export function _instantiateSubscribers(
  config: Config,
  eventEmitter: EventEmitter,
  sysCfg: Record<string, unknown> | null = null,
): void {
  const subscriberConfigs = _cfgGet(sysCfg, config, 'events.subscribers', []) as
    ReadonlyArray<Record<string, unknown>>;

  for (const subscriberConfig of subscriberConfigs) {
    const typeName = subscriberConfig['type'] as string | undefined;
    if (typeof typeName !== 'string') {
      console.warn('[apcore:events]', 'Subscriber config missing "type" field, skipping');
      continue;
    }

    const factory = _subscriberFactories.get(typeName);
    if (factory === undefined) {
      console.warn('[apcore:events]', `Unknown subscriber type '${typeName}', skipping`);
      continue;
    }

    try {
      const subscriber = factory(subscriberConfig);
      eventEmitter.subscribe(subscriber);
    } catch (err: unknown) {
      console.warn('[apcore:events]', `Failed to create subscriber of type '${typeName}':`, err);
    }
  }
}

export interface SysModulesContext {
  errorHistory?: ErrorHistory;
  errorHistoryMiddleware?: ErrorHistoryMiddleware;
  usageCollector?: UsageCollector;
  usageMiddleware?: UsageMiddleware;
  eventEmitter?: EventEmitter;
  platformNotifyMiddleware?: PlatformNotifyMiddleware;
}

export interface RegisterSysModulesOptions {
  failOnError?: boolean;
  overridesPath?: string;
  auditStore?: AuditStore;
}

/**
 * Auto-register all sys.* modules and middleware based on config.
 */
export function registerSysModules(
  registry: Registry,
  executor: Executor,
  config: Config,
  metricsCollector?: MetricsCollector | null,
  options?: RegisterSysModulesOptions,
): SysModulesContext {
  const result: SysModulesContext = {};
  const failOnError = options?.failOnError ?? false;
  const overridesPath = options?.overridesPath ?? null;
  const auditStore = options?.auditStore ?? null;

  // §9.15.3: prefer config.namespace('sys_modules') in namespace mode
  const sysCfg = _resolveSysCfg(config);

  if (!_cfgGet(sysCfg, config, 'enabled', false)) {
    return result;
  }

  // Load overrides file and apply after base config
  if (overridesPath !== null && fs.existsSync(overridesPath)) {
    try {
      const content = fs.readFileSync(overridesPath, 'utf-8');
      const parsed = yaml.load(content);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          config.set(key, value);
        }
      }
    } catch (err) {
      console.warn('[apcore:sys-modules] Failed to load overrides file:', err);
    }
  }

  // Error history
  const maxPerModule = Number(_cfgGet(sysCfg, config, 'error_history.max_entries_per_module', 50));
  const maxTotal = Number(_cfgGet(sysCfg, config, 'error_history.max_total_entries', 1000));
  const errorHistory = new ErrorHistory({ maxEntriesPerModule: maxPerModule, maxTotalEntries: maxTotal });
  result.errorHistory = errorHistory;

  const ehMiddleware = new ErrorHistoryMiddleware(errorHistory);
  executor.use(ehMiddleware);
  result.errorHistoryMiddleware = ehMiddleware;

  // Usage tracking
  const usageCollector = new UsageCollector();
  result.usageCollector = usageCollector;
  const usageMiddleware = new UsageMiddleware(usageCollector);
  executor.use(usageMiddleware);
  result.usageMiddleware = usageMiddleware;

  // Register sys modules via registerInternal to bypass reserved-word checks
  const reg = (id: string, mod: unknown): void => {
    try {
      registry.registerInternal(id, mod);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      if (failOnError) {
        throw new SysModuleRegistrationError(id, cause);
      }
      console.error(`[apcore:sys-modules] Failed to register system module '${id}':`, err);
    }
  };

  // Health modules
  reg('system.health.summary', new HealthSummaryModule(registry, metricsCollector ?? null, errorHistory, config));
  reg('system.health.module', new HealthModule(registry, metricsCollector ?? null, errorHistory));

  // Manifest modules
  reg('system.manifest.module', new ManifestModule(registry, config));
  reg('system.manifest.full', new ManifestFullModule(registry, config));

  // Usage modules
  reg('system.usage.summary', new UsageSummaryModule(usageCollector));
  reg('system.usage.module', new UsageModule(registry, usageCollector));

  // Events system
  if (_cfgGet(sysCfg, config, 'events.enabled', false)) {
    const eventEmitter = new EventEmitter();
    result.eventEmitter = eventEmitter;

    // Config-driven subscribers
    _instantiateSubscribers(config, eventEmitter, sysCfg);

    // PlatformNotifyMiddleware
    const errorRateThreshold = Number(_cfgGet(sysCfg, config, 'events.thresholds.error_rate', 0.1));
    const latencyP99Threshold = Number(_cfgGet(sysCfg, config, 'events.thresholds.latency_p99_ms', 5000));
    const pnMiddleware = new PlatformNotifyMiddleware(eventEmitter, metricsCollector ?? null, errorRateThreshold, latencyP99Threshold);
    executor.use(pnMiddleware);
    result.platformNotifyMiddleware = pnMiddleware;

    // Control modules (require EventEmitter)
    reg('system.control.toggle_feature', new ToggleFeatureModule(registry, eventEmitter, undefined, auditStore ?? undefined));
    reg('system.control.update_config', new UpdateConfigModule(config, eventEmitter, {
      auditStore: auditStore ?? undefined,
      overridesPath: overridesPath ?? undefined,
    }));
    reg('system.control.reload_module', new ReloadModule(registry, eventEmitter, auditStore ?? undefined));

    // Bridge registry events
    registry.on('register', (moduleId: string) => {
      eventEmitter.emit(createEvent('module_registered', moduleId, 'info', {}));
    });
    registry.on('unregister', (moduleId: string) => {
      eventEmitter.emit(createEvent('module_unregistered', moduleId, 'info', {}));
    });
  }

  return result;
}
