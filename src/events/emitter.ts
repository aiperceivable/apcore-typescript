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
   * Optional glob pattern (supports * and ? wildcards). When set, the emitter
   * only delivers events whose `eventType` matches the pattern.
   */
  readonly eventPattern?: string;
  /**
   * Optional retry configuration. When absent, delivery uses a single attempt
   * (fire-and-forget, backward-compatible). When present, delivery is retried
   * with exponential backoff using DEFAULT_RETRY as the base.
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

/**
 * Emit a canonical event AND a legacy alias for the same event during the
 * deprecation window. The legacy event payload is augmented with
 * `deprecated: true` and `canonical_event: <canonicalType>` so subscribers
 * still listening to the legacy name can migrate.
 *
 * The two emissions share an identical timestamp so they appear atomic to
 * downstream consumers ordering by `timestamp`.
 */
export function emitWithLegacy(
  emitter: EventEmitter,
  canonicalType: string,
  legacyType: string,
  moduleId: string | null,
  severity: string,
  data: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  emitter.emit({ eventType: canonicalType, moduleId, timestamp, severity, data });
  emitter.emit({
    eventType: legacyType,
    moduleId,
    timestamp,
    severity,
    data: { ...data, deprecated: true, canonical_event: canonicalType },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_MAX_PENDING = 1000;

/**
 * Global event bus with fan-out delivery, per-subscriber retry, and DLQ.
 *
 * Key behaviors:
 * - Subscribers without a `retry` config get single-attempt fire-and-forget delivery
 *   (backward-compatible). Errors are logged via console.warn.
 * - Subscribers with `retry` config get exponential-backoff retries up to
 *   `maxAttempts`. After exhaustion: DLQ event + optional `onFailure` callback.
 * - `eventPattern` (glob) filters which events a subscriber receives.
 * - `flush()` drains all in-flight async deliveries.
 */
export class EventEmitter {
  private _subscribers: EventSubscriber[] = [];
  private _pending: Promise<void>[] = [];
  private readonly _maxPending: number;

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

  emit(event: ApCoreEvent): void {
    const snapshot = this._getMatchingSubscribers(event.eventType);
    for (const subscriber of snapshot) {
      // Single-attempt (no retry config) subscribers: preserve old fire-and-forget behavior
      // with synchronous error isolation for sync throws and async error logging.
      if (!subscriber.retry) {
        this._emitSingleAttempt(subscriber, event);
        continue;
      }

      // Retry-enabled subscribers: async delivery with backoff and DLQ.
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

  /**
   * Single-attempt delivery that preserves the original fire-and-forget behavior.
   * Sync errors are caught and logged immediately; async errors are tracked in _pending.
   */
  private _emitSingleAttempt(subscriber: EventSubscriber, event: ApCoreEvent): void {
    try {
      const result = subscriber.onEvent(event);
      if (result instanceof Promise) {
        if (this._pending.length >= this._maxPending) {
          console.warn(
            `[apcore:events] _pending cap (${this._maxPending}) reached — dropping async delivery for event ${event.eventType}`,
          );
          this._dispatchDroppedEvent(subscriber, event);
        } else {
          const tracked = result.catch((err) => {
            console.warn(`[apcore:events] Subscriber failed handling event ${event.eventType}:`, err);
          });
          this._pending.push(tracked);
          tracked.then(() => {
            const idx = this._pending.indexOf(tracked);
            if (idx !== -1) this._pending.splice(idx, 1);
          });
        }
      }
    } catch (err) {
      console.warn(`[apcore:events] Subscriber failed handling event ${event.eventType}:`, err);
    }
  }

  private _getMatchingSubscribers(eventType: string): EventSubscriber[] {
    return this._subscribers.filter((sub) => {
      if (!sub.eventPattern) return true;
      return fnmatch(eventType, sub.eventPattern);
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
    const subscriberType = (subscriber as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
    const subscriberId = subscriber.subscriberId ?? this._identifySubscriber(subscriber);

    const dlqEvent = createEvent(
      'apcore.event.delivery_failed',
      null,
      'error',
      {
        subscriber_type: subscriberType.replace('Subscriber', '').toLowerCase(),
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

    // Deliver DLQ event with NO retry — single attempt only; DLQ subscriber errors are logged
    const dlqSubscribers = this._getMatchingSubscribers(dlqEvent.eventType);
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
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    while (this._pending.length > 0) {
      if (Date.now() >= deadline) return;
      const pending = [...this._pending];
      this._pending = [];
      await Promise.allSettled(pending);
    }
  }
}
