/**
 * Execution-time governance policy: external overrides for governance annotations.
 *
 * RFC pilot for apcore#76 ("first-class external governance / policy API").
 * An {@link ExecutionPolicy} lets a platform operator override the governance
 * annotations (`requiresApproval`, `destructive`) of already-registered modules
 * at execution time, independent of how the modules were registered. It attaches
 * to the {@link Executor} (`policy` option) and is consulted by the approval
 * gate (Step 5).
 *
 * Precedence: a matched policy rule overrides the module's own declared or
 * scanned annotations — external governance is the platform's word against the
 * module author's. Matching uses the same wildcard semantics as the ACL system
 * (Algorithm A08) and the same specificity scoring (Algorithm A10); on a
 * specificity tie the more restrictive rule wins.
 *
 * Governance principle (apcore#76): a misconfigured or unreachable governance
 * control must warn or error, never silently allow. {@link ExecutionPolicy.fromObject}
 * therefore rejects unknown keys (a typo in a governance file must not silently
 * no-op), and `strict=true` makes the approval gate fail closed when approval is
 * required but no ApprovalHandler is configured.
 */

import type { ModuleAnnotations } from './module.js';
import { calculateSpecificity, matchPattern } from './utils/pattern.js';

const POLICY_KEYS = new Set(['rules', 'gate_destructive', 'strict']);
const RULE_KEYS = new Set(['pattern', 'requires_approval', 'destructive', 'reason']);

/** Overrides accepted by the {@link PolicyRule} constructor. */
export interface PolicyRuleOverrides {
  /**
   * Override for the module's `requiresApproval` annotation. `null`/`undefined`
   * leaves the module's own value in effect.
   */
  requiresApproval?: boolean | null;
  /**
   * Override for the module's `destructive` annotation. `null`/`undefined`
   * leaves the module's own value in effect.
   */
  destructive?: boolean | null;
  /** Human-readable rationale, carried into the audit trail. */
  reason?: string | null;
}

/**
 * A single pattern-based governance override (apcore#76 RFC pilot).
 *
 * Immutable; validates its fields eagerly so a malformed governance rule fails
 * loud at construction rather than silently no-op'ing at execution time.
 */
export class PolicyRule {
  /**
   * Module ID wildcard pattern (Algorithm A08 semantics, same as ACL rules).
   * `*` matches any character sequence including dots.
   */
  readonly pattern: string;
  readonly requiresApproval: boolean | null;
  readonly destructive: boolean | null;
  readonly reason: string | null;

  constructor(pattern: string, overrides: PolicyRuleOverrides = {}) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('PolicyRule.pattern must be a non-empty string');
    }
    const requiresApproval = overrides.requiresApproval ?? null;
    const destructive = overrides.destructive ?? null;
    const reason = overrides.reason ?? null;
    for (const [name, value] of [
      ['requiresApproval', requiresApproval],
      ['destructive', destructive],
    ] as const) {
      if (value !== null && typeof value !== 'boolean') {
        throw new Error(`PolicyRule.${name} must be a boolean or null, got ${typeof value}`);
      }
    }
    if (reason !== null && typeof reason !== 'string') {
      throw new Error(`PolicyRule.reason must be a string or null, got ${typeof reason}`);
    }
    this.pattern = pattern;
    this.requiresApproval = requiresApproval;
    this.destructive = destructive;
    this.reason = reason;
    Object.freeze(this);
  }
}

/**
 * The effective governance verdict for one module under a policy.
 *
 * - `requiresApproval` / `destructive`: effective values after overrides.
 * - `needsApproval`: final approval-gate verdict — true when the effective
 *   `requiresApproval` is true, or when the policy gates destructive modules
 *   and the effective `destructive` is true.
 * - `rule`: the matched {@link PolicyRule}, or `null` when no rule matched.
 * - `overridden`: true when the matched rule changed a base annotation value.
 */
export interface PolicyDecision {
  readonly moduleId: string;
  readonly requiresApproval: boolean;
  readonly destructive: boolean;
  readonly needsApproval: boolean;
  readonly rule: PolicyRule | null;
  readonly overridden: boolean;
}

/** Read a boolean annotation from a ModuleAnnotations object or a dict. */
function readAnnotationBool(annotations: unknown, camelKey: string, snakeKey: string): boolean {
  if (annotations == null || typeof annotations !== 'object') return false;
  const obj = annotations as Record<string, unknown>;
  if (camelKey in obj) return Boolean(obj[camelKey]);
  if (snakeKey in obj) return Boolean(obj[snakeKey]);
  return false;
}

/** Tie-break key: rules that force gating rank above rules that relax it. */
function restrictiveness(rule: PolicyRule): number {
  // (requiresApproval === true) outranks (destructive === true); encode as a
  // 2-bit score so a lexicographic tuple comparison collapses to `>`.
  return (rule.requiresApproval === true ? 2 : 0) + (rule.destructive === true ? 1 : 0);
}

/**
 * Declarative execution-time governance overrides (apcore#76 RFC pilot).
 *
 * @example
 * ```ts
 * const policy = new ExecutionPolicy(
 *   [new PolicyRule('orders.delete_*', { requiresApproval: true, reason: 'human sign-off' })],
 *   { gateDestructive: true, strict: true },
 * );
 * const executor = new Executor({ registry, approvalHandler: handler, policy });
 * ```
 */
export class ExecutionPolicy {
  private readonly _rules: readonly PolicyRule[];
  /**
   * When true, modules whose effective `destructive` annotation is true require
   * approval even if `requiresApproval` is false — the opt-in resolution of the
   * destructive↔approval gap described in apcore#76.
   */
  readonly gateDestructive: boolean;
  /**
   * When true, the approval gate fails closed (denies) when a module needs
   * approval but no ApprovalHandler is configured. When false (default), the
   * gate keeps the PROTOCOL_SPEC §7.4 skip behavior but logs a warning.
   */
  readonly strict: boolean;

  constructor(
    rules: PolicyRule[] | null = null,
    options: { gateDestructive?: boolean; strict?: boolean } = {},
  ) {
    const frozen = Object.freeze([...(rules ?? [])]);
    for (const rule of frozen) {
      if (!(rule instanceof PolicyRule)) {
        throw new Error(`ExecutionPolicy rules must be PolicyRule instances, got ${typeof rule}`);
      }
    }
    this._rules = frozen;
    this.gateDestructive = Boolean(options.gateDestructive);
    this.strict = Boolean(options.strict);
  }

  /** The policy's rules as an immutable array. */
  get rules(): readonly PolicyRule[] {
    return this._rules;
  }

  /**
   * Compute the effective governance decision for a module.
   *
   * @param moduleId - Canonical module ID being invoked.
   * @param annotations - The module's annotations (ModuleAnnotations, dict, or
   *   null). Only `requiresApproval`/`requires_approval` and `destructive` are
   *   consulted.
   */
  resolve(moduleId: string, annotations: unknown = null): PolicyDecision {
    const baseRequiresApproval = readAnnotationBool(
      annotations,
      'requiresApproval',
      'requires_approval',
    );
    const baseDestructive = readAnnotationBool(annotations, 'destructive', 'destructive');

    const rule = this._match(moduleId);
    const effectiveRequiresApproval =
      rule === null || rule.requiresApproval === null
        ? baseRequiresApproval
        : rule.requiresApproval;
    const effectiveDestructive =
      rule === null || rule.destructive === null ? baseDestructive : rule.destructive;

    return {
      moduleId,
      requiresApproval: effectiveRequiresApproval,
      destructive: effectiveDestructive,
      needsApproval: effectiveRequiresApproval || (this.gateDestructive && effectiveDestructive),
      rule,
      overridden:
        effectiveRequiresApproval !== baseRequiresApproval ||
        effectiveDestructive !== baseDestructive,
    };
  }

  /** Return the winning rule for a module ID, or null. */
  private _match(moduleId: string): PolicyRule | null {
    let best: PolicyRule | null = null;
    let bestScore = -1;
    for (const rule of this._rules) {
      if (!matchPattern(rule.pattern, moduleId)) continue;
      const score = calculateSpecificity(rule.pattern);
      if (score > bestScore) {
        best = rule;
        bestScore = score;
      } else if (
        score === bestScore &&
        best !== null &&
        restrictiveness(rule) > restrictiveness(best)
      ) {
        best = rule;
      }
    }
    return best;
  }

  /**
   * Build a policy from a plain object (parsed YAML/JSON governance file).
   *
   * Parsing is strict: unknown keys throw so a typo in a governance file fails
   * loud instead of silently disabling a control.
   *
   * Expected shape:
   * ```yaml
   * gate_destructive: true
   * strict: true
   * rules:
   *   - pattern: "orders.delete_*"
   *     requires_approval: true
   *     reason: "destructive order operations need human sign-off"
   * ```
   *
   * @throws {Error} On unknown keys, missing `pattern`, or wrong types.
   */
  static fromObject(data: unknown): ExecutionPolicy {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      const kind = Array.isArray(data) ? 'array' : typeof data;
      throw new Error(`Policy document must be a mapping, got ${kind}`);
    }
    const obj = data as Record<string, unknown>;
    const unknown = Object.keys(obj).filter((k) => !POLICY_KEYS.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown policy keys ${JSON.stringify(unknown.sort())}; a governance file must not silently no-op`,
      );
    }

    const rulesRaw = obj['rules'] ?? [];
    if (!Array.isArray(rulesRaw)) {
      throw new Error(`Policy 'rules' must be a list, got ${typeof rulesRaw}`);
    }

    const rules: PolicyRule[] = [];
    rulesRaw.forEach((item, index) => {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        const kind = Array.isArray(item) ? 'array' : typeof item;
        throw new Error(`Policy rule #${index} must be a mapping, got ${kind}`);
      }
      const ruleObj = item as Record<string, unknown>;
      const unknownRule = Object.keys(ruleObj).filter((k) => !RULE_KEYS.has(k));
      if (unknownRule.length > 0) {
        throw new Error(
          `Policy rule #${index} has unknown keys ${JSON.stringify(unknownRule.sort())}; ` +
            'a governance rule must not silently no-op',
        );
      }
      if (!('pattern' in ruleObj)) {
        throw new Error(`Policy rule #${index} is missing required key 'pattern'`);
      }
      rules.push(
        new PolicyRule(ruleObj['pattern'] as string, {
          requiresApproval: (ruleObj['requires_approval'] ?? null) as boolean | null,
          destructive: (ruleObj['destructive'] ?? null) as boolean | null,
          reason: (ruleObj['reason'] ?? null) as string | null,
        }),
      );
    });

    return new ExecutionPolicy(rules, {
      gateDestructive: Boolean(obj['gate_destructive'] ?? false),
      strict: Boolean(obj['strict'] ?? false),
    });
  }
}

/**
 * Build effective ModuleAnnotations for an ApprovalRequest under a policy
 * decision, preserving the PROTOCOL_SPEC §7 "requiresApproval is guaranteed
 * true" contract: the handler sees the effective governance values, not the
 * module's raw declaration.
 */
export function applyDecisionToAnnotations(
  annotations: ModuleAnnotations,
  decision: PolicyDecision,
): ModuleAnnotations {
  return Object.freeze({
    ...annotations,
    requiresApproval: true,
    destructive: decision.destructive,
  });
}
