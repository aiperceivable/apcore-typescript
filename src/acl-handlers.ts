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

/** Type alias for the recursive evaluation function used by compound handlers. */
export type EvalFn = (
  conditions: Record<string, unknown>,
  context: Context,
) => boolean;

// ---------------------------------------------------------------------------
// Basic handlers
// ---------------------------------------------------------------------------

/** Check context.identity.type is in the allowed list. */
export class IdentityTypesHandler implements ACLConditionHandler {
  evaluate(value: unknown, context: Context): boolean {
    if (context.identity === null) return false;
    const allowed = Array.isArray(value) ? value : [value];
    return allowed.includes(context.identity.type);
  }
}

/** Check at least one role overlaps between identity and required roles. */
export class RolesHandler implements ACLConditionHandler {
  evaluate(value: unknown, context: Context): boolean {
    if (context.identity === null) return false;
    const required = Array.isArray(value) ? value : [value];
    const identityRoles = new Set(context.identity.roles);
    return (required as string[]).some((r: string) => identityRoles.has(r));
  }
}

/** Check call chain length does not exceed threshold. */
export class MaxCallDepthHandler implements ACLConditionHandler {
  evaluate(value: unknown, context: Context): boolean {
    let threshold: number;
    if (typeof value === 'object' && value !== null && 'lte' in (value as any)) {
      threshold = (value as any).lte;
    } else if (typeof value === 'number') {
      threshold = value;
    } else {
      return false;
    }
    return context.callChain.length <= threshold;
  }
}

// ---------------------------------------------------------------------------
// Compound handlers
// ---------------------------------------------------------------------------

/** $or: list of condition dicts. Returns true if ANY sub-set passes. */
export class OrHandler implements ACLConditionHandler {
  private readonly _evaluate: EvalFn;

  constructor(evaluateFn: EvalFn) {
    this._evaluate = evaluateFn;
  }

  evaluate(value: unknown, context: Context): boolean {
    if (!Array.isArray(value)) return false;
    for (const sub of value) {
      if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) continue;
      if (this._evaluate(sub as Record<string, unknown>, context)) return true;
    }
    return false;
  }
}

/** $not: single condition dict. Returns true if the sub-set FAILS. */
export class NotHandler implements ACLConditionHandler {
  private readonly _evaluate: EvalFn;

  constructor(evaluateFn: EvalFn) {
    this._evaluate = evaluateFn;
  }

  evaluate(value: unknown, context: Context): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return !this._evaluate(value as Record<string, unknown>, context);
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
