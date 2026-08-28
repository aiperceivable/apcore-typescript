/**
 * Built-in ACL condition handlers and handler interface.
 *
 * Defines the ACLConditionHandler interface, three basic handlers
 * (identity_types, roles, max_call_depth), and two compound operators ($or, $not).
 */

import type { Context } from './context.js';

/** Handler interface for evaluating a single ACL condition. */
export interface ACLConditionHandler {
  evaluate(value: unknown, context: Context): boolean | Promise<boolean>;
}

/**
 * Three-valued outcome of evaluating an ACL condition (PROTOCOL_SPEC §6.1.1).
 *
 * `'unsatisfied'` means a registered handler ran to completion and answered
 * "no" — an ordinary non-match. `'unevaluable'` means no answer was obtainable
 * at all, which is a different outcome and resolves the enclosing rule toward
 * refusing access: a `deny` rule takes effect, an `allow` rule does not grant.
 * Collapsing the two is the defect §6.1.1 exists to prevent.
 */
export type ConditionOutcome = 'satisfied' | 'unsatisfied' | 'unevaluable';

/**
 * Type alias for the recursive evaluation function used by compound handlers.
 *
 * `path` is the PROTOCOL_SPEC §6.1.4 condition path of the sub-object being
 * evaluated (`$or[1]`, `$or[1].$not`, `''` at the root), so a fault found
 * inside it can be reported at its own position rather than under the
 * operator's key.
 */
export type EvalFn = (
  conditions: Record<string, unknown>,
  context: Context,
  path: string,
) => ConditionOutcome;

/** Async variant of EvalFn for use under asyncCheck(). */
export type AsyncEvalFn = (
  conditions: Record<string, unknown>,
  context: Context,
  path: string,
) => Promise<ConditionOutcome>;

/**
 * A condition handler able to report UNEVALUABLE separately from UNSATISFIED.
 *
 * The public {@link ACLConditionHandler} contract returns a boolean, which
 * cannot carry PROTOCOL_SPEC §6.1.1's third outcome — so the built-in
 * compound operators (`$or`, `$not`), whose children can themselves be
 * unevaluable, implement this richer interface as well. A handler that only
 * implements `evaluate()` keeps the two-outcome contract: `true` is SATISFIED,
 * `false` is UNSATISFIED, a throw is UNEVALUABLE.
 */
export interface ACLOutcomeConditionHandler extends ACLConditionHandler {
  /**
   * @param path - This condition key's own §6.1.4 path (`$or`, `$or[1].$not`),
   *   from which a compound handler derives its children's paths.
   */
  evaluateOutcome(
    value: unknown,
    context: Context,
    path: string,
  ): ConditionOutcome | Promise<ConditionOutcome>;
}

/** True when a handler can report the three-valued outcome directly. */
export function isOutcomeHandler(
  handler: ACLConditionHandler,
): handler is ACLOutcomeConditionHandler {
  return typeof (handler as Partial<ACLOutcomeConditionHandler>).evaluateOutcome === 'function';
}

/** True only for a plain object — excludes null, arrays and every primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Basic handlers
// ---------------------------------------------------------------------------

/** Check context.identity.type is in the allowed list. */
export class IdentityTypesHandler implements ACLConditionHandler {
  evaluate(value: unknown, context: Context): boolean {
    if (context.identity === null) return false;
    if (!Array.isArray(value)) return false;
    return value.includes(context.identity.type);
  }
}

/** Check at least one role overlaps between identity and required roles. */
export class RolesHandler implements ACLConditionHandler {
  evaluate(value: unknown, context: Context): boolean {
    if (context.identity === null) return false;
    if (!Array.isArray(value)) return false;
    const identityRoles = new Set(context.identity.roles);
    return (value as string[]).some((r: string) => identityRoles.has(r));
  }
}

/** Check call chain length does not exceed threshold. */
export class MaxCallDepthHandler implements ACLConditionHandler {
  evaluate(value: unknown, context: Context): boolean {
    let threshold: number;
    if (typeof value === 'number') {
      threshold = value;
    } else if (
      typeof value === 'object' &&
      value !== null &&
      'lte' in value &&
      typeof (value as { lte: unknown }).lte === 'number'
    ) {
      threshold = (value as { lte: number }).lte;
    } else {
      return false;
    }
    // Fail closed on non-integer thresholds (e.g. 5.5). A fractional depth is
    // meaningless and must not silently ALLOW where Python/Rust reject.
    if (!Number.isInteger(threshold)) {
      return false;
    }
    return context.callChain.length <= threshold;
  }
}

// ---------------------------------------------------------------------------
// Compound handlers
// ---------------------------------------------------------------------------

/**
 * `$or`: list of condition dicts. SATISFIED if ANY sub-set passes.
 *
 * Three-valued per PROTOCOL_SPEC §6.1.1: an outright "yes" wins even when a
 * sibling was unevaluable, so a SATISFIED child short-circuits. An UNEVALUABLE
 * child does NOT short-circuit — a later sibling may still be the decisive
 * SATISFIED — and makes the whole `$or` unevaluable only if no child said yes.
 */
export class OrHandler implements ACLOutcomeConditionHandler {
  private readonly _evaluate: EvalFn;

  constructor(evaluateFn: EvalFn) {
    this._evaluate = evaluateFn;
  }

  evaluateOutcome(value: unknown, context: Context, path = '$or'): ConditionOutcome {
    // §6.1.1 case 4: a value malformed for its key is UNEVALUABLE, not false.
    // A handler handed `$or: "typo"` can return false and look exactly like one
    // that answered "no" — which put a deny rule carrying the typo right back
    // into the inert state §6.1.1 exists to end.
    if (!Array.isArray(value)) return 'unevaluable';
    let sawUnevaluable = false;
    for (let i = 0; i < value.length; i++) {
      const sub = value[i];
      if (!isPlainObject(sub)) {
        sawUnevaluable = true;
        continue;
      }
      const outcome = this._evaluate(sub, context, `${path}[${i}]`);
      if (outcome === 'satisfied') return 'satisfied';
      if (outcome === 'unevaluable') sawUnevaluable = true;
    }
    return sawUnevaluable ? 'unevaluable' : 'unsatisfied';
  }

  evaluate(value: unknown, context: Context): boolean {
    return this.evaluateOutcome(value, context) === 'satisfied';
  }
}

/**
 * `$not`: single condition dict. SATISFIED if the sub-set is UNSATISFIED.
 *
 * §6.1.1: `$not` of an UNEVALUABLE child is UNEVALUABLE, never SATISFIED.
 * Negating "no answer" into "yes" would let a misspelled key inside a `$not`
 * satisfy the very rule it was meant to gate.
 */
export class NotHandler implements ACLOutcomeConditionHandler {
  private readonly _evaluate: EvalFn;

  constructor(evaluateFn: EvalFn) {
    this._evaluate = evaluateFn;
  }

  evaluateOutcome(value: unknown, context: Context, path = '$not'): ConditionOutcome {
    // §6.1.1 case 4 — a non-object `$not` cannot be negated into anything
    // meaningful, so it is UNEVALUABLE rather than false.
    if (!isPlainObject(value)) return 'unevaluable';
    const outcome = this._evaluate(value, context, path);
    if (outcome === 'unevaluable') return 'unevaluable';
    return outcome === 'satisfied' ? 'unsatisfied' : 'satisfied';
  }

  evaluate(value: unknown, context: Context): boolean {
    return this.evaluateOutcome(value, context) === 'satisfied';
  }
}

/** `$or` async: list of condition dicts evaluated via the async evaluator. */
export class OrHandlerAsync implements ACLOutcomeConditionHandler {
  private readonly _evaluate: AsyncEvalFn;

  constructor(evaluateFn: AsyncEvalFn) {
    this._evaluate = evaluateFn;
  }

  async evaluateOutcome(
    value: unknown,
    context: Context,
    path = '$or',
  ): Promise<ConditionOutcome> {
    if (!Array.isArray(value)) return 'unevaluable';
    let sawUnevaluable = false;
    for (let i = 0; i < value.length; i++) {
      const sub = value[i];
      if (!isPlainObject(sub)) {
        sawUnevaluable = true;
        continue;
      }
      const outcome = await this._evaluate(sub, context, `${path}[${i}]`);
      if (outcome === 'satisfied') return 'satisfied';
      if (outcome === 'unevaluable') sawUnevaluable = true;
    }
    return sawUnevaluable ? 'unevaluable' : 'unsatisfied';
  }

  async evaluate(value: unknown, context: Context): Promise<boolean> {
    return (await this.evaluateOutcome(value, context)) === 'satisfied';
  }
}

/** `$not` async: single condition dict evaluated via the async evaluator. */
export class NotHandlerAsync implements ACLOutcomeConditionHandler {
  private readonly _evaluate: AsyncEvalFn;

  constructor(evaluateFn: AsyncEvalFn) {
    this._evaluate = evaluateFn;
  }

  async evaluateOutcome(
    value: unknown,
    context: Context,
    path = '$not',
  ): Promise<ConditionOutcome> {
    if (!isPlainObject(value)) return 'unevaluable';
    const outcome = await this._evaluate(value, context, path);
    if (outcome === 'unevaluable') return 'unevaluable';
    return outcome === 'satisfied' ? 'unsatisfied' : 'satisfied';
  }

  async evaluate(value: unknown, context: Context): Promise<boolean> {
    return (await this.evaluateOutcome(value, context)) === 'satisfied';
  }
}

// ---------------------------------------------------------------------------
// Utility functions for element-wise comparison (used by removeRule fix)
// ---------------------------------------------------------------------------

/** Compare two arrays for element-wise equality. */
export function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Deep equality for plain objects (conditions comparison). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!(key in objB)) return false;
    if (!deepEqual(objA[key], objB[key])) return false;
  }
  return true;
}
