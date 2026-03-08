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
