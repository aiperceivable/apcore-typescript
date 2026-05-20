import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, createEvent } from '../../src/events/emitter.js';
import type { ApCoreEvent, EventSubscriber } from '../../src/events/emitter.js';

describe('Event delivery semantics (#61)', () => {
  describe('eventPattern filtering', () => {
    it('subscriber with eventPattern receives only matching events', async () => {
      const emitter = new EventEmitter();
      const received: string[] = [];
      const sub: EventSubscriber = {
        eventPattern: 'apcore.module.*',
        onEvent: (e) => { received.push(e.eventType); },
      };
      emitter.subscribe(sub);
      emitter.emit(createEvent('apcore.module.executed', null, 'info', {}));
      emitter.emit(createEvent('apcore.registry.registered', null, 'info', {}));
      emitter.emit(createEvent('apcore.module.failed', null, 'info', {}));
      await emitter.flush();
      expect(received).toEqual(['apcore.module.executed', 'apcore.module.failed']);
    });

    it('subscriber without eventPattern receives all events', async () => {
      const emitter = new EventEmitter();
      let count = 0;
      emitter.subscribe({ onEvent: () => { count++; } });
      emitter.emit(createEvent('a', null, 'info', {}));
      emitter.emit(createEvent('b', null, 'info', {}));
      await emitter.flush();
      expect(count).toBe(2);
    });

    it('eventPattern with ? wildcard', async () => {
      const emitter = new EventEmitter();
      const received: string[] = [];
      emitter.subscribe({
        eventPattern: 'apcore.?.done',
        onEvent: (e) => { received.push(e.eventType); },
      });
      emitter.emit(createEvent('apcore.x.done', null, 'info', {}));
      emitter.emit(createEvent('apcore.xy.done', null, 'info', {})); // no match: ? = 1 char
      await emitter.flush();
      expect(received).toEqual(['apcore.x.done']);
    });
  });

  describe('per-subscriber retry', () => {
    it('subscriber with retry config retries on failure', async () => {
      const emitter = new EventEmitter();
      let attempts = 0;
      const sub: EventSubscriber = {
        subscriberId: 'retry-sub',
        retry: { maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 1 },
        async onEvent() {
          attempts++;
          if (attempts < 3) throw new Error('transient');
        },
      };
      emitter.subscribe(sub);
      emitter.emit(createEvent('test', null, 'info', {}));
      await emitter.flush();
      expect(attempts).toBe(3);
    });

    it('DLQ event emitted after all retries exhausted', async () => {
      const emitter = new EventEmitter();
      const dlqEvents: ApCoreEvent[] = [];
      emitter.subscribe({
        eventPattern: 'apcore.event.delivery_failed',
        onEvent: (e) => { dlqEvents.push(e); },
      });
      emitter.subscribe({
        subscriberId: 'failing-sub',
        retry: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 1 },
        async onEvent() { throw new Error('permanent fail'); },
      });
      emitter.emit(createEvent('test.event', null, 'info', {}));
      await emitter.flush();
      expect(dlqEvents.length).toBe(1);
      const dlq = dlqEvents[0];
      expect(dlq.data['subscriber_id']).toBe('failing-sub');
      expect(dlq.data['attempt_count']).toBe(2);
      expect((dlq.data['original_event'] as Record<string,unknown>)['name']).toBe('test.event');
      expect((dlq.data['error'] as Record<string,unknown>)['message']).toBe('permanent fail');
    });

    it('onFailure callback invoked after retry exhaustion', async () => {
      const emitter = new EventEmitter();
      let failureCalled = false;
      let failureError: Error | undefined = undefined;
      let failureAttempts = 0;
      emitter.subscribe({
        subscriberId: 'onfailure-sub',
        retry: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 1 },
        async onEvent() { throw new Error('boom'); },
        onFailure(_ev, err, count) {
          failureCalled = true;
          failureError = err;
          failureAttempts = count;
        },
      });
      emitter.emit(createEvent('test', null, 'info', {}));
      await emitter.flush();
      expect(failureCalled).toBe(true);
      expect((failureError as Error | undefined)?.message).toBe('boom');
      expect(failureAttempts).toBe(2);
    });
  });

  describe('subscriberId', () => {
    it('subscriberId is used in DLQ payload', async () => {
      const emitter = new EventEmitter();
      const dlqEvents: ApCoreEvent[] = [];
      emitter.subscribe({
        eventPattern: 'apcore.event.delivery_failed',
        onEvent: (e) => { dlqEvents.push(e); },
      });
      emitter.subscribe({
        subscriberId: 'my-custom-id',
        retry: { maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 1 },
        async onEvent() { throw new Error('x'); },
      });
      emitter.emit(createEvent('test', null, 'info', {}));
      await emitter.flush();
      expect(dlqEvents[0].data['subscriber_id']).toBe('my-custom-id');
    });
  });

  describe('fan-out isolation', () => {
    it('second subscriber delivers even when first subscriber fails after retries', async () => {
      const emitter = new EventEmitter();
      let secondCalled = false;
      emitter.subscribe({
        retry: { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 1 },
        async onEvent() { throw new Error('fail'); },
      });
      emitter.subscribe({ onEvent: () => { secondCalled = true; } });
      emitter.emit(createEvent('test', null, 'info', {}));
      await emitter.flush();
      expect(secondCalled).toBe(true);
    });
  });
});
