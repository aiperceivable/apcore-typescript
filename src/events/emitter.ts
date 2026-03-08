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
 * Global event bus with non-blocking fan-out delivery.
 * Errors in one subscriber do not affect others.
 */
export class EventEmitter {
  private _subscribers: EventSubscriber[] = [];
  private _pending: Promise<void>[] = [];

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
      } catch (err) {
        console.warn(`[apcore:events] Subscriber failed handling event ${event.eventType}:`, err);
      }
    }
  }

  /**
   * Wait for all pending async event deliveries to complete.
   */
  async flush(maxRounds: number = 10): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      const pending = [...this._pending];
      this._pending = [];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      if (this._pending.length === 0) return;
    }
  }
}
