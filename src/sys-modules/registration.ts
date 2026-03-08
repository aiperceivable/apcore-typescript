/**
 * Auto-registration of sys.* modules and middleware from config.
 */

import type { Registry } from '../registry/registry.js';
import type { Executor } from '../executor.js';
import type { Config } from '../config.js';
import type { MetricsCollector } from '../observability/metrics.js';
import { ErrorHistory } from '../observability/error-history.js';
import { ErrorHistoryMiddleware } from '../middleware/error-history.js';
import { UsageCollector, UsageMiddleware } from '../observability/usage.js';
import type { EventSubscriber } from '../events/emitter.js';
import { EventEmitter, createEvent } from '../events/emitter.js';
import { WebhookSubscriber, A2ASubscriber } from '../events/subscribers.js';
import { PlatformNotifyMiddleware } from '../middleware/platform-notify.js';
import { HealthSummaryModule, HealthModuleModule } from './health.js';
import { ManifestFullModule, ManifestModuleModule } from './manifest.js';
import { ToggleFeatureModule } from './toggle.js';
import { UpdateConfigModule, ReloadModuleModule } from './control.js';
import { UsageSummaryModule, UsageModuleModule } from './usage.js';

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
    const auth = config['auth'] as Record<string, unknown> | undefined;
    const timeoutMs = config['timeout_ms'] as number | undefined;
    return new A2ASubscriber(platformUrl, auth, timeoutMs);
  });
}

// Register built-in factories on module load
_registerBuiltInFactories();

export function registerSubscriberType(
  typeName: string,
  factory: SubscriberFactory,
): void {
  _subscriberFactories.set(typeName, factory);
}

export function unregisterSubscriberType(typeName: string): void {
  if (!_subscriberFactories.has(typeName)) {
    throw new Error(`Subscriber type '${typeName}' is not registered`);
  }
  _subscriberFactories.delete(typeName);
}

export function resetSubscriberRegistry(): void {
  _subscriberFactories.clear();
  _registerBuiltInFactories();
}

/**
 * Instantiate subscribers from config and subscribe them to the emitter.
 */
export function _instantiateSubscribers(
  config: Config,
  eventEmitter: EventEmitter,
): void {
  const subscriberConfigs = config.get('sys_modules.events.subscribers', []) as
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

/**
 * Auto-register all sys.* modules and middleware based on config.
 */
export function registerSysModules(
  registry: Registry,
  executor: Executor,
  config: Config,
  metricsCollector?: MetricsCollector | null,
): SysModulesContext {
  const result: SysModulesContext = {};

  if (!config.get('sys_modules.enabled', false)) {
    return result;
  }

  // Error history
  const maxPerModule = Number(config.get('sys_modules.error_history.max_entries_per_module', 50));
  const maxTotal = Number(config.get('sys_modules.error_history.max_total_entries', 1000));
  const errorHistory = new ErrorHistory(maxPerModule, maxTotal);
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
    registry.registerInternal(id, mod);
  };

  // Health modules
  reg('system.health.summary', new HealthSummaryModule(registry, metricsCollector ?? null, errorHistory, config));
  reg('system.health.module', new HealthModuleModule(registry, metricsCollector ?? null, errorHistory));

  // Manifest modules
  reg('system.manifest.module', new ManifestModuleModule(registry, config));
  reg('system.manifest.full', new ManifestFullModule(registry, config));

  // Usage modules
  reg('system.usage.summary', new UsageSummaryModule(usageCollector));
  reg('system.usage.module', new UsageModuleModule(registry, usageCollector));

  // Events system
  if (config.get('sys_modules.events.enabled', false)) {
    const eventEmitter = new EventEmitter();
    result.eventEmitter = eventEmitter;

    // Config-driven subscribers
    _instantiateSubscribers(config, eventEmitter);

    // PlatformNotifyMiddleware
    const errorRateThreshold = Number(config.get('sys_modules.events.thresholds.error_rate', 0.1));
    const latencyP99Threshold = Number(config.get('sys_modules.events.thresholds.latency_p99_ms', 5000));
    const pnMiddleware = new PlatformNotifyMiddleware(eventEmitter, metricsCollector ?? null, errorRateThreshold, latencyP99Threshold);
    executor.use(pnMiddleware);
    result.platformNotifyMiddleware = pnMiddleware;

    // Control modules (require EventEmitter)
    reg('system.control.toggle_feature', new ToggleFeatureModule(registry, eventEmitter));
    reg('system.control.update_config', new UpdateConfigModule(config, eventEmitter));
    reg('system.control.reload_module', new ReloadModuleModule(registry, eventEmitter));

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
