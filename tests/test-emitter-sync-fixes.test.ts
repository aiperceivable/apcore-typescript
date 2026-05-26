/**
 * Regression tests for the EventEmitter cross-SDK alignment fixes:
 *   A-D-028 — emit() is a no-op after shutdown().
 *   A-D-026 — DLQ events are not delivered to catch-all ('*'/no-pattern) subscribers.
 *   A-D-029 — DLQ subscriber_type comes from a declared subscriberType field.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter, createEvent } from '../src/events/emitter.js';
import type { ApCoreEvent, EventSubscriber } from '../src/events/emitter.js';

describe('EventEmitter.shutdown (A-D-028)', () => {
  it('emit() delivers nothing after shutdown()', async () => {
    const emitter = new EventEmitter();
    const received: string[] = [];
    emitter.subscribe({ onEvent: (e) => { received.push(e.eventType); } });

    await emitter.shutdown();
    emitter.emit(createEvent('test.after.shutdown', null, 'info', {}));
    await emitter.flush();

    expect(received).toHaveLength(0);
  });

  it('emit() still works before shutdown()', async () => {
    const emitter = new EventEmitter();
    const received: string[] = [];
    emitter.subscribe({ onEvent: (e) => { received.push(e.eventType); } });

    emitter.emit(createEvent('test.before.shutdown', null, 'info', {}));
    await emitter.flush();

    expect(received).toEqual(['test.before.shutdown']);
  });
});

describe('DLQ excludes catch-all subscribers (A-D-026)', () => {
  it("a '*' wildcard subscriber does NOT receive apcore.event.delivery_failed", async () => {
    const emitter = new EventEmitter();
    const wildcardEvents: string[] = [];
    // Catch-all wildcard subscriber.
    emitter.subscribe({
      eventPattern: '*',
      onEvent: (e) => { wildcardEvents.push(e.eventType); },
    });
    // A subscriber scoped to the failing event so it triggers the DLQ.
    emitter.subscribe({
      subscriberId: 'failing',
      eventPattern: 'test.fail',
      retry: { maxAttempts: 1 },
      async onEvent() { throw new Error('boom'); },
    });

    emitter.emit(createEvent('test.fail', null, 'info', {}));
    await emitter.flush();

    // The wildcard subscriber saw the original event but NOT the DLQ event.
    expect(wildcardEvents).toContain('test.fail');
    expect(wildcardEvents).not.toContain('apcore.event.delivery_failed');
  });

  it('a no-pattern (catch-all) subscriber does NOT receive the DLQ event', async () => {
    const emitter = new EventEmitter();
    const catchAllEvents: string[] = [];
    emitter.subscribe({ onEvent: (e) => { catchAllEvents.push(e.eventType); } });
    emitter.subscribe({
      eventPattern: 'test.fail2',
      retry: { maxAttempts: 1 },
      async onEvent() { throw new Error('boom'); },
    });

    emitter.emit(createEvent('test.fail2', null, 'info', {}));
    await emitter.flush();

    expect(catchAllEvents).not.toContain('apcore.event.delivery_failed');
  });

  it('an explicitly-scoped DLQ subscriber still receives the DLQ event', async () => {
    const emitter = new EventEmitter();
    const dlq: ApCoreEvent[] = [];
    emitter.subscribe({
      eventPattern: 'apcore.event.delivery_failed',
      onEvent: (e) => { dlq.push(e); },
    });
    emitter.subscribe({
      eventPattern: 'test.fail3',
      retry: { maxAttempts: 1 },
      async onEvent() { throw new Error('boom'); },
    });

    emitter.emit(createEvent('test.fail3', null, 'info', {}));
    await emitter.flush();

    expect(dlq).toHaveLength(1);
  });
});

describe('DLQ subscriber_type from declared field (A-D-029)', () => {
  it('uses the declared subscriberType in the DLQ payload', async () => {
    const emitter = new EventEmitter();
    const dlq: ApCoreEvent[] = [];
    emitter.subscribe({
      eventPattern: 'apcore.event.delivery_failed',
      onEvent: (e) => { dlq.push(e); },
    });
    const failing: EventSubscriber = {
      subscriberId: 'declared-type-sub',
      subscriberType: 'my-custom-kind',
      eventPattern: 'test.fail4',
      retry: { maxAttempts: 1 },
      async onEvent() { throw new Error('boom'); },
    };
    emitter.subscribe(failing);

    emitter.emit(createEvent('test.fail4', null, 'info', {}));
    await emitter.flush();

    expect(dlq).toHaveLength(1);
    expect(dlq[0].data['subscriber_type']).toBe('my-custom-kind');
  });
});
