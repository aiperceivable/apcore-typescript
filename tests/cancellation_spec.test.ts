/**
 * Spec-traced contract tests for the cancellation feature.
 *
 * Mirrors the canonical Python suite:
 *   apcore-python/tests/test_cancellation_spec.py
 *
 * Generated from: apcore/docs/features/cancellation.md
 * Feature spec declares 2 '## Contract:' blocks:
 *   - CancelToken.cancel
 *   - CancelToken.raise_if_cancelled
 *
 * Each test carries a verbatim clause id of the form
 * 'cancellation.<method>.<kind>.<detail>' so cross-language diffs line up by
 * exact clause id.
 *
 * NOTE (cross-language gap): the contract block names the second method
 * 'CancelToken.raise_if_cancelled', but the TypeScript SDK source
 * (src/cancel.ts) implements the cancellation check as 'check()'. There is no
 * 'raiseIfCancelled'/'raise_if_cancelled' symbol. Per the missing-symbol rule,
 * every clause under that contract is emitted as a skip documenting the gap.
 */

import { describe, it, expect } from 'vitest';
import { CancelToken, ExecutionCancelledError } from '../src/cancel.js';
import { ModuleError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// Contract: CancelToken.cancel
// ---------------------------------------------------------------------------

describe('Contract: CancelToken.cancel', () => {
  it('cancellation.cancel.property.thread_safe: >=8 concurrent cancel() on distinct tokens converge consistently', async () => {
    const tokens = Array.from({ length: 16 }, () => new CancelToken());

    const doCancel = async (tok: CancelToken): Promise<void> => {
      // Yield control so calls genuinely interleave on the event loop.
      await Promise.resolve();
      tok.cancel();
    };

    await Promise.all(tokens.map((t) => doCancel(t)));

    // Final state must be consistent: all tokens cancelled, none raised.
    expect(tokens.every((t) => t.isCancelled === true)).toBe(true);
  });

  it('cancellation.cancel.property.thread_safe: concurrent cancel() of a shared token converges to one cancelled state', async () => {
    const shared = new CancelToken();

    const doCancel = async (): Promise<void> => {
      await Promise.resolve();
      shared.cancel();
    };

    await Promise.all(Array.from({ length: 16 }, () => doCancel()));

    expect(shared.isCancelled).toBe(true);
  });

  it('cancellation.cancel.property.idempotent: calling cancel() twice is a safe no-op with identical state', () => {
    const token = new CancelToken();

    token.cancel();
    const firstState = token.isCancelled;
    token.cancel(); // Second call must be a safe no-op.
    const secondState = token.isCancelled;

    expect(firstState).toBe(true);
    expect(secondState).toBe(true);
    expect(firstState).toBe(secondState);
    // check() must behave identically after the repeated cancel.
    expect(() => token.check()).toThrow(ExecutionCancelledError);
  });
});

// ---------------------------------------------------------------------------
// Contract: CancelToken.raise_if_cancelled
//
// MISSING SYMBOL: the TypeScript SDK has no 'raiseIfCancelled' method on
// CancelToken (the equivalent behavior is 'check()'). These clauses are
// recorded as skips so the cross-language naming gap is documented as a skip
// rather than a coarse import/compile failure.
// ---------------------------------------------------------------------------

describe('Contract: CancelToken.raise_if_cancelled', () => {
  it.skip('cancellation.raise_if_cancelled.error.EXECUTION_CANCELLED: missing symbol CancelToken.raiseIfCancelled (contract gap) — TS SDK implements this as CancelToken.check()', () => {
    // intentionally skipped — see file header
  });

  it.skip('cancellation.raise_if_cancelled.property.thread_safe: missing symbol CancelToken.raiseIfCancelled (contract gap) — TS SDK implements this as CancelToken.check()', () => {
    // intentionally skipped — see file header
  });

  it.skip('cancellation.raise_if_cancelled.property.pure: missing symbol CancelToken.raiseIfCancelled (contract gap) — TS SDK implements this as CancelToken.check()', () => {
    // intentionally skipped — see file header
  });
});

// ---------------------------------------------------------------------------
// Sanity guard: ensure the declared error type/code referenced by the
// raise_if_cancelled contract actually exists with the spec'd code, so the
// gap above is purely a method-name mismatch (not a missing error type).
// ---------------------------------------------------------------------------

describe('Contract: CancelToken.raise_if_cancelled (error-type guard)', () => {
  it('cancellation.raise_if_cancelled.error.EXECUTION_CANCELLED: ExecutionCancelledError is a ModuleError with code EXECUTION_CANCELLED via the live check() path', () => {
    const token = new CancelToken();
    token.cancel();

    let caught: unknown;
    try {
      token.check();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ExecutionCancelledError);
    expect(caught).toBeInstanceOf(ModuleError);
    expect((caught as ModuleError).code).toBe('EXECUTION_CANCELLED');
  });
});
