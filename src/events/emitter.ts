/**
 * Global event bus with fan-out delivery and subscriber error isolation.
 */

export interface ApCoreEvent {
  readonly eventType: string;
  readonly moduleId: string | null;
  readonly timestamp: string;
  readonly severity: string;
  readonly data: Record<string, unknown>;
}

export interface EventSubscriber {
  onEvent(event: ApCoreEvent): void | Promise<void>;
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

const DEFAULT_MAX_PENDING = 1000;

/**
 * Global event bus with non-blocking fan-out delivery.
 * Errors in one subscriber do not affect others.
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
    const snapshot = [...this._subscribers];
    for (const subscriber of snapshot) {
      try {
        const result = subscriber.onEvent(event);
        if (result instanceof Promise) {
          if (this._pending.length >= this._maxPending) {
            // Overflow: instead of silently dropping, emit a structured event
            // so observers can track delivery loss. (sync finding A-D-504)
            console.warn(
              `[apcore:events] _pending cap (${this._maxPending}) reached — dropping async delivery for event ${event.eventType}`,
            );
            this._dispatchDroppedEvent(subscriber, event);
          } else {
            const tracked = result.catch((err) => {
              console.warn(`[apcore:events] Subscriber failed handling event ${event.eventType}:`, err);
            });
            this._pending.push(tracked);
            // Auto-cleanup when resolved to prevent unbounded growth
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
      if (sub === droppedFor) continue; // avoid recursive drop on the same sink
      try {
        const r = sub.onEvent(droppedEvent);
        // Intentionally do not track this Promise in _pending — at-cap by design.
        // Async handlers swallow their own errors; attach a guard so unhandled
        // rejections don't escape.
        if (r instanceof Promise) {
          r.catch((err) => {
            console.warn(`[apcore:events] Subscriber failed handling delivery_dropped:`, err);
          });
        }
      } catch (err) {
        console.warn(`[apcore:events] Subscriber failed handling delivery_dropped:`, err);
      }
    }
  }

  private _identifySubscriber(sub: EventSubscriber): string {
    const ctorName = (sub as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== 'Object') return ctorName;
    // Fall back to a stable hash-ish string based on identity.
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
