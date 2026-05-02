import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, createEvent } from '../src/events/index.js';
import type { ApCoreEvent, EventSubscriber } from '../src/events/index.js';

describe('createEvent', () => {
  it('creates an event with timestamp', () => {
    const event = createEvent('test_event', 'mod.a', 'info', { key: 'val' });
    expect(event.eventType).toBe('test_event');
    expect(event.moduleId).toBe('mod.a');
    expect(event.severity).toBe('info');
    expect(event.data).toEqual({ key: 'val' });
    expect(event.timestamp).toBeTruthy();
  });

  it('allows null moduleId', () => {
    const event = createEvent('global', null, 'warning', {});
    expect(event.moduleId).toBeNull();
  });
});

describe('EventEmitter', () => {
  it('delivers event to subscriber', () => {
    const emitter = new EventEmitter();
    const received: ApCoreEvent[] = [];
    const sub: EventSubscriber = { onEvent: (e) => { received.push(e); } };
    emitter.subscribe(sub);
    const event = createEvent('test', null, 'info', {});
    emitter.emit(event);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('delivers to multiple subscribers', () => {
    const emitter = new EventEmitter();
    let count = 0;
    emitter.subscribe({ onEvent: () => { count++; } });
    emitter.subscribe({ onEvent: () => { count++; } });
    emitter.emit(createEvent('test', null, 'info', {}));
    expect(count).toBe(2);
  });

  it('unsubscribe removes subscriber', () => {
    const emitter = new EventEmitter();
    let count = 0;
    const sub: EventSubscriber = { onEvent: () => { count++; } };
    emitter.subscribe(sub);
    emitter.unsubscribe(sub);
    emitter.emit(createEvent('test', null, 'info', {}));
    expect(count).toBe(0);
  });

  it('unsubscribe is no-op for unknown subscriber', () => {
    const emitter = new EventEmitter();
    emitter.unsubscribe({ onEvent: () => {} });
  });

  it('isolates subscriber errors', () => {
    const emitter = new EventEmitter();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let secondCalled = false;
    emitter.subscribe({ onEvent: () => { throw new Error('boom'); } });
    emitter.subscribe({ onEvent: () => { secondCalled = true; } });
    emitter.emit(createEvent('test', null, 'info', {}));
    expect(secondCalled).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handles async subscriber errors gracefully', async () => {
    const emitter = new EventEmitter();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitter.subscribe({ onEvent: async () => { throw new Error('async boom'); } });
    emitter.emit(createEvent('test', null, 'info', {}));
    await emitter.flush();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('flush waits for all pending async deliveries', async () => {
    const emitter = new EventEmitter();
    let resolved = false;
    emitter.subscribe({
      onEvent: async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
      },
    });
    emitter.emit(createEvent('test', null, 'info', {}));
    expect(resolved).toBe(false);
    await emitter.flush();
    expect(resolved).toBe(true);
  });

  it('flush handles recursive pending promises', async () => {
    const emitter = new EventEmitter();
    let round2Done = false;
    emitter.subscribe({
      onEvent: async (event) => {
        if (event.data['round'] === 1) {
          emitter.emit(createEvent('test', null, 'info', { round: 2 }));
        }
        if (event.data['round'] === 2) {
          round2Done = true;
        }
      },
    });
    emitter.emit(createEvent('test', null, 'info', { round: 1 }));
    await emitter.flush();
    expect(round2Done).toBe(true);
  });

  it('flush is safe to call when no pending promises', async () => {
    const emitter = new EventEmitter();
    await emitter.flush();
  });

  it('auto-cleans resolved async deliveries from pending without flush', async () => {
    const emitter = new EventEmitter();
    let done = false;
    emitter.subscribe({
      onEvent: async () => {
        await Promise.resolve();
        done = true;
      },
    });
    emitter.emit(createEvent('test', null, 'info', {}));
    // Wait for the subscriber to resolve naturally, without calling flush()
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(done).toBe(true);
    // _pending should be empty now (auto-cleaned) — flush is a no-op
    await emitter.flush();
  });

  it('flush with non-zero timeoutMs completes normally when within deadline', async () => {
    const emitter = new EventEmitter();
    let done = false;
    emitter.subscribe({
      onEvent: async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        done = true;
      },
    });
    emitter.emit(createEvent('test', null, 'info', {}));
    await emitter.flush(500);
    expect(done).toBe(true);
  });

  it('flush with expired timeout aborts on subsequent pending round', async () => {
    const emitter = new EventEmitter();
    let round2Done = false;
    emitter.subscribe({
      onEvent: async (event) => {
        if (event.data['round'] === 1) {
          await new Promise<void>((r) => setTimeout(r, 50));
          // Adds a second round of pending promises after deadline has passed
          emitter.emit(createEvent('test', null, 'info', { round: 2 }));
        }
        if (event.data['round'] === 2) {
          // Make round 2 async so it is tracked in _pending (not set synchronously)
          await new Promise<void>((r) => setTimeout(r, 10));
          round2Done = true;
        }
      },
    });
    emitter.emit(createEvent('test', null, 'info', { round: 1 }));
    // 10ms deadline — round 1 takes 50ms, so deadline is exceeded before round 2 starts
    await emitter.flush(10);
    expect(round2Done).toBe(false);
  });

  it('emits delivery_dropped event instead of silently dropping when _pending cap is reached (sync A-D-504)', async () => {
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnMessages.push(String(args[0])); };

    try {
      const emitter = new EventEmitter(2); // cap of 2
      let resolved = 0;
      // Subscriber that holds 50ms async delivery
      const slowSubscriber: EventSubscriber = {
        onEvent: () => new Promise<void>((r) => setTimeout(() => { resolved++; r(); }, 50)),
      };
      emitter.subscribe(slowSubscriber);

      // Drop-event observer (sync, never produces a Promise so it never fills _pending).
      const droppedEvents: ApCoreEvent[] = [];
      emitter.subscribe({
        onEvent: (e) => {
          if (e.eventType === 'apcore.subscriber.delivery_dropped') {
            droppedEvents.push(e);
          }
        },
      });

      // First two slow subscriber promises occupy _pending (cap=2).
      emitter.emit(createEvent('test_event', null, 'info', {}));
      emitter.emit(createEvent('test_event', null, 'info', {}));
      // Third triggers drop on the slow subscriber — expect a structured event.
      emitter.emit(createEvent('test_event', null, 'info', { round: 3 }));

      expect(droppedEvents.length).toBeGreaterThan(0);
      const dropped = droppedEvents[0];
      expect(dropped.severity).toBe('warning');
      expect(dropped.data['event_type']).toBe('test_event');
      expect(dropped.data['subscriber_id']).toBeTruthy();

      await emitter.flush();
      expect(resolved).toBe(2); // only 2 tracked, 1 dropped — but as a visible event
    } finally {
      console.warn = origWarn;
    }
  });

  it('flush defaults to a finite 5000ms deadline rather than 0=infinite (sync A-D-503)', async () => {
    // Multi-round scenario: round-1 subscriber spawns round-2 deliveries.
    // With a virtualised clock pushed past 5000ms after round-1 completes,
    // flush() with no argument must abort *before* the round-2 promises start.
    // If the default were 0 (=infinite), it would still drain round-2.
    const emitter = new EventEmitter();
    let round2Done = false;
    emitter.subscribe({
      onEvent: async (event) => {
        if (event.data['round'] === 1) {
          // Brief real wait so flush()'s first allSettled round actually settles.
          await new Promise<void>((r) => setTimeout(r, 5));
          // Spawn a second pending round with a payload that *would* resolve.
          emitter.emit(createEvent('test', null, 'info', { round: 2 }));
        }
        if (event.data['round'] === 2) {
          await new Promise<void>((r) => setTimeout(r, 10));
          round2Done = true;
        }
      },
    });

    const realNow = Date.now;
    const startReal = realNow();
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      emitter.emit(createEvent('test', null, 'info', { round: 1 }));
      // Fast-forward past the 5000ms default deadline before round-2 starts.
      setTimeout(() => { offset = 6000; }, 1);
      await emitter.flush(); // no arg — must use 5000ms default
      // Round 2 should not have completed because deadline expired between rounds.
      expect(round2Done).toBe(false);
      const elapsedReal = realNow() - startReal;
      // And we should not have actually waited 5 real seconds.
      expect(elapsedReal).toBeLessThan(2000);
    } finally {
      Date.now = realNow;
    }
  });

  it('snapshot prevents mutation during delivery', () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    emitter.subscribe({
      onEvent: () => {
        calls.push('sub1');
        emitter.subscribe({ onEvent: () => { calls.push('sub3'); } });
      },
    });
    emitter.subscribe({ onEvent: () => { calls.push('sub2'); } });
    emitter.emit(createEvent('test', null, 'info', {}));
    expect(calls).toEqual(['sub1', 'sub2']);
  });
});
