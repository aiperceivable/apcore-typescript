/**
 * ERR-002 — every framework error code must be in `ErrorCodes`, because that
 * map is the sole input to `collectFrameworkCodes()`.
 *
 * `collectFrameworkCodes()` is the exact-code half of the A17 collision guard,
 * so a code the framework throws but `ErrorCodes` omits can be claimed by a
 * user module — and the module's code then shadows the framework's.
 *
 * `INVALID_PARENT_ID` (thrown by `TraceContext.inject`) was omitted, and no
 * reserved prefix covers `INVALID_`, so
 * `registry.register("executor.my_mod", ["INVALID_PARENT_ID"])` raised
 * ERROR_CODE_COLLISION on apcore-python and apcore-rust and was ACCEPTED here.
 * `SCHEMA_UNION_NO_MATCH` / `SCHEMA_UNION_AMBIGUOUS` were covered only by the
 * `SCHEMA_` reserved prefix, never by exact code.
 *
 * The comment already in `errors.ts` is about exactly this failure mode; it
 * was applied to the `PIPELINE_*` family alone.
 */

import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '../src/errors.js';
import { ErrorCodeRegistry } from '../src/error-code-registry.js';
import { ErrorCodeCollisionError } from '../src/error-code-registry.js';
import { TraceContext } from '../src/trace-context.js';
import { Context } from '../src/context.js';

describe('framework codes thrown outside errors.ts are still in ErrorCodes (ERR-002)', () => {
  it('INVALID_PARENT_ID is a declared framework code', () => {
    expect(Object.values(ErrorCodes)).toContain('INVALID_PARENT_ID');
  });

  it('the schema union codes are declared by exact code, not only by prefix', () => {
    expect(Object.values(ErrorCodes)).toContain('SCHEMA_UNION_NO_MATCH');
    expect(Object.values(ErrorCodes)).toContain('SCHEMA_UNION_AMBIGUOUS');
  });

  it('a module cannot claim INVALID_PARENT_ID', () => {
    const registry = new ErrorCodeRegistry();
    expect(() => registry.register('executor.my_mod', new Set(['INVALID_PARENT_ID']))).toThrow(
      ErrorCodeCollisionError,
    );
  });

  it('INVALID_PARENT_ID is the code TraceContext.inject actually throws', () => {
    const context = Context.create();
    let thrown: (Error & { code?: string }) | null = null;
    try {
      TraceContext.inject(context, 'not-hex');
    } catch (e) {
      thrown = e as Error & { code?: string };
    }
    expect(thrown?.code).toBe('INVALID_PARENT_ID');
    expect(Object.values(ErrorCodes)).toContain(thrown?.code);
  });

  it('an unrelated module code is still accepted', () => {
    const registry = new ErrorCodeRegistry();
    expect(() => registry.register('executor.my_mod', new Set(['MY_OWN_CODE']))).not.toThrow();
  });
});
