/**
 * Global event bus with fan-out delivery, per-subscriber retry, and DLQ.
 */

import { resolveRetry, computeDelayMs, fnmatch } from './retry.js';
import type { RetryConfig } from './retry.js';

export interface ApCoreEvent {
  readonly eventType: string;
  readonly moduleId: string | null;
  readonly timestamp: string;
  readonly severity: string;
  readonly data: Record<string, unknown>;
}

export interface EventSubscriber {
  onEvent(event: ApCoreEvent): void | Promise<void>;
  /** Optional stable ID for this subscriber, used in DLQ payloads and identity tracking. */
  readonly subscriberId?: string;
  /**
   * Optional declared subscriber kind (e.g. 'webhook', 'a2a', 'file'). Used as
   * the `subscriber_type` in DLQ payloads. When absent, the type is derived
   * from the constructor name (legacy fallback). Cross-SDK canonical
   * (Python/Rust, A-D-029) reads this declared field first.
   */
  readonly subscriberType?: string;
  /**
   * Optional glob pattern (supports * and ? wildcards). When set, the emitter
   * only delivers events whose `eventType` matches the pattern.
   */
  readonly eventPattern?: string;
  /**
   * Optional retry configuration. When absent, delivery uses the spec default
   * policy (max_attempts=3 with exponential backoff). When present, supplied
   * fields are merged over DEFAULT_RETRY; `maxAttempts: 1` disables retry.
   */
  readonly retry?: RetryConfig;
  /**
   * Optional callback invoked after all retry attempts are exhausted.
   * Receives the original event, the final error, and the total attempt count.
   * Errors thrown from onFailure are logged and suppressed.
   */
  onFailure?(event: ApCoreEvent, error: Error, attemptCount: number): void | Promise<void>;
}

export function createEvent(
  eventType: string,
  moduleId: string | null,
  severity: string,
  data: Record<string, unknown>,
): ApCoreEvent {
  return {
    eventType,
    moduleId,
    timestamp: new Date().toISOString(),
    severity,
    data,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_MAX_PENDING = 1000;

/**
 * Global event bus with fan-out delivery, per-subscriber retry, and DLQ.
 *
 * Key behaviors:
 * - All subscribers get exponential-backoff retries up to `maxAttempts`. A subscriber
 *   that omits `retry` receives the spec default policy (max_attempts=3); one that sets
 *   `maxAttempts: 1` disables retry (single attempt).
 * - After retry exhaustion: DLQ event + optional `onFailure` callback.
 * - `eventPattern` (glob) filters which events a subscriber receives.
 * - `flush()` drains all in-flight async deliveries.
 */
export class EventEmitter {
  private _subscribers: EventSubscriber[] = [];
  private _pending: Promise<void>[] = [];
  private readonly _maxPending: number;
  private _shutdown = false;

  constructor(maxPending: number = DEFAULT_MAX_PENDING) {
    this._maxPending = maxPending;
  }

  subscribe(subscriber: EventSubscriber): void {
    this._subscribers.push(subscriber);
  }

  unsubscribe(subscriber: EventSubscriber): void {
    const idx = this._subscribers.indexOf(subscriber);
    if (idx !== -1) {
      this._subscribers.splice(idx, 1);
    }
  }

  /**
   * Stop accepting new emits. After shutdown, {@link emit} is a no-op (A-D-028,
   * cross-SDK canonical with Python/Rust which drop post-shutdown emits). Drains
   * any in-flight deliveries via {@link flush}.
   */
  async shutdown(timeoutMs: number = 5000): Promise<void> {
    if (this._shutdown) return;
    this._shutdown = true;
    await this.flush(timeoutMs);
  }

  emit(event: ApCoreEvent): void {
    // A-D-028: silently drop emits after shutdown.
    if (this._shutdown) return;
    const snapshot = this._getMatchingSubscribers(event.eventType);
    for (const subscriber of snapshot) {
      // Every subscriber — built-in and user-registered, with or without an explicit
      // `retry` block — goes through the unified retry/backoff/DLQ delivery path.
      // A subscriber that omits `retry` receives the spec default policy
      // (max_attempts=3); one that explicitly sets maxAttempts:1 disables retry.
      // (event-system.md §Per-Subscriber Retry Policy; sync finding A-D-005)
      const deliveryPromise = this._deliver(subscriber, event);
      if (this._pending.length >= this._maxPending) {
        console.warn(
          `[apcore:events] _pending cap (${this._maxPending}) reached — dropping async delivery for event ${event.eventType}`,
        );
        this._dispatchDroppedEvent(subscriber, event);
      } else {
        const tracked = deliveryPromise.catch(() => {
          // errors handled inside _deliver
        });
        this._pending.push(tracked);
        tracked.then(() => {
          const idx = this._pending.indexOf(tracked);
          if (idx !== -1) this._pending.splice(idx, 1);
        });
      }
    }
  }

  private _getMatchingSubscribers(eventType: string, isDlq = false): EventSubscriber[] {
    return this._subscribers.filter((sub) => {
      // A-D-026: DLQ events (apcore.event.delivery_failed) are delivered ONLY
      // to subscribers with an explicit, non-wildcard pattern. Catch-all
      // subscribers (no pattern, or pattern '*') never receive DLQ events —
      // this prevents cascading failures where a catch-all subscriber would
      // recursively fail on the DLQ event about its own delivery failure.
      const pattern = sub.eventPattern ?? '*';
      if (isDlq && pattern === '*') return false;
      return fnmatch(eventType, pattern);
    });
  }

  private async _deliver(subscriber: EventSubscriber, event: ApCoreEvent): Promise<void> {
    const retry = resolveRetry(subscriber.retry);
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
      try {
        await subscriber.onEvent(event);
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt + 1 < retry.maxAttempts) {
          await sleep(computeDelayMs(retry, attempt));
        }
      }
    }

    // All attempts exhausted — emit DLQ event and invoke onFailure callback
    await this._emitDLQ(subscriber, event, lastError, retry.maxAttempts);

    if (subscriber.onFailure) {
      try {
        await subscriber.onFailure(event, lastError, retry.maxAttempts);
      } catch (cbError) {
        console.error('[apcore:events] onFailure callback raised:', cbError);
      }
    }
  }

  private async _emitDLQ(
    subscriber: EventSubscriber,
    originalEvent: ApCoreEvent,
    error: Error,
    attemptCount: number,
  ): Promise<void> {
    // A-D-029: prefer the declared `subscriberType` field; fall back to the
    // constructor-name derivation only when it is absent.
    const subscriberType =
      typeof subscriber.subscriberType === 'string'
        ? subscriber.subscriberType
        : ((subscriber as { constructor?: { name?: string } }).constructor?.name ?? 'unknown')
            .replace('Subscriber', '')
            .toLowerCase();
    const subscriberId = subscriber.subscriberId ?? this._identifySubscriber(subscriber);

    const dlqEvent = createEvent(
      'apcore.event.delivery_failed',
      null,
      'error',
      {
        subscriber_type: subscriberType,
        subscriber_id: subscriberId,
        original_event: {
          name: originalEvent.eventType,
          module_id: originalEvent.moduleId,
          timestamp: originalEvent.timestamp,
          payload: originalEvent.data,
        },
        error: { type: error.constructor?.name ?? 'Error', message: error.message },
        attempt_count: attemptCount,
        timestamp: new Date().toISOString(),
      },
    );

    // Deliver DLQ event with NO retry — single attempt only; DLQ subscriber errors are logged.
    // isDlq=true excludes catch-all ('*'/no-pattern) subscribers (A-D-026).
    const dlqSubscribers = this._getMatchingSubscribers(dlqEvent.eventType, true);
    for (const dlqSub of dlqSubscribers) {
      try {
        const r = dlqSub.onEvent(dlqEvent);
        if (r instanceof Promise) {
          await r;
        }
      } catch (dlqErr) {
        console.error('[apcore:events] DLQ subscriber raised:', dlqErr);
      }
    }
  }

  /**
   * Synchronously dispatch an `apcore.subscriber.delivery_dropped` event to all
   * subscribers (except the one whose delivery was dropped, to avoid feedback
   * loops). Sync emit only — never tracked in `_pending`. (sync finding A-D-504)
   */
  private _dispatchDroppedEvent(
    droppedFor: EventSubscriber,
    originalEvent: ApCoreEvent,
  ): void {
    const droppedEvent = createEvent(
      'apcore.subscriber.delivery_dropped',
      null,
      'warning',
      {
        subscriber_id: this._identifySubscriber(droppedFor),
        event_type: originalEvent.eventType,
        original_module_id: originalEvent.moduleId,
      },
    );
    for (const sub of this._subscribers) {
      if (sub === droppedFor) continue;
      try {
        const r = sub.onEvent(droppedEvent);
        // Intentionally do not track this Promise in _pending — at-cap by design.
        // Async handlers swallow their own errors; attach a guard so unhandled
        // rejections don't escape.
        if (r instanceof Promise) {
          r.catch((err) => {
            console.warn('[apcore:events] Subscriber failed handling delivery_dropped:', err);
          });
        }
      } catch (err) {
        console.warn('[apcore:events] Subscriber failed handling delivery_dropped:', err);
      }
    }
  }

  private _identifySubscriber(sub: EventSubscriber): string {
    if (sub.subscriberId) return sub.subscriberId;
    const ctorName = (sub as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== 'Object') return ctorName;
    return `subscriber@${this._subscribers.indexOf(sub)}`;
  }

  /**
   * Wait for all pending async event deliveries to complete.
   * @param timeoutMs - Maximum milliseconds to wait. Defaults to 5000 (5s);
   *                   pass `0` to wait indefinitely.
   *                   Cross-language note: Rust uses ms (matches here);
   *                   Python's flush() uses seconds (5.0 default) — same wall-clock semantics.
   *                   (sync finding A-D-503)
   */
  async flush(timeoutMs: number = 5000): Promise<void> {
    // A-D-027: per-pending semantics (Python canonical) — each pending delivery
    // gets up to `timeoutMs` to settle, rather than sharing one total deadline.
    // A delivery that exceeds its budget is abandoned (the next call to flush
    // can re-await any that are still tracked).
    const pending = [...this._pending];
    this._pending = [];
    for (const p of pending) {
      if (timeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([p.catch(() => {}), timeout]);
        if (timer !== undefined) clearTimeout(timer);
      } else {
        await p.catch(() => {});
      }
    }
  }
}
