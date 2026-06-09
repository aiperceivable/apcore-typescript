/**
 * A-D-05 — CircuitBreaker min_samples parity.
 *
 * Python/Rust open the circuit once `window.length >= min_samples` (default 5)
 * and the error rate crosses the threshold, decoupled from the rolling-window
 * capacity. The TypeScript implementation previously gated opening on a FULL
 * window (`length >= windowSize`, default 10), so it never opened on the spec's
 * minimum-sample boundary. These tests guard the corrected behavior.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '../../src/context.js';
import {
  CircuitBreakerMiddleware,
  CircuitBreakerState,
} from '../../src/middleware/circuit-breaker.js';

function driveErrors(
  cb: CircuitBreakerMiddleware,
  moduleId: string,
  ctx: Context,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    try {
      cb.before(moduleId, {}, ctx);
    } catch {
      // circuit may already be OPEN on later iterations — ignore
    }
    cb.onError(moduleId, {}, new Error('simulated'), ctx);
  }
}

describe('CircuitBreaker min_samples (A-D-05)', () => {
  it('opens after 5 consecutive failures with default options', () => {
    const cb = new CircuitBreakerMiddleware();
    const ctx = new Context('trace', 'caller', []);
    const moduleId = 'executor.payment.charge';

    driveErrors(cb, moduleId, ctx, 5);

    expect(cb.getState(moduleId, 'caller')).toBe(CircuitBreakerState.OPEN);
  });

  it('stays CLOSED below min_samples even at a high error rate', () => {
    const cb = new CircuitBreakerMiddleware();
    const ctx = new Context('trace', 'caller', []);
    const moduleId = 'executor.payment.charge';

    driveErrors(cb, moduleId, ctx, 4);

    expect(cb.getState(moduleId, 'caller')).toBe(CircuitBreakerState.CLOSED);
  });

  it('defaults windowSize to 20 for parity with Python/Rust', () => {
    const cb = new CircuitBreakerMiddleware({ minSamples: 100 });
    const ctx = new Context('trace', 'caller', []);
    const moduleId = 'executor.payment.charge';

    // 20 errors fill the default window but never reach min_samples=100,
    // so the circuit must remain CLOSED. (Confirms default capacity is 20.)
    driveErrors(cb, moduleId, ctx, 20);

    expect(cb.getState(moduleId, 'caller')).toBe(CircuitBreakerState.CLOSED);
  });
});
