/**
 * ACL (Access Control List) types and implementation for apcore.
 */

import type { Context } from './context.js';
import { ACLRuleError } from './errors.js';
import { matchPattern } from './utils/pattern.js';
import type {
  ACLConditionHandler,
  ConditionOutcome,
  GovernanceProjection,
} from './acl-handlers.js';
import {
  ArgumentsHandler,
  IdentityTypesHandler,
  RolesHandler,
  MaxCallDepthHandler,
  OrHandler,
  NotHandler,
  OrHandlerAsync,
  NotHandlerAsync,
  arraysEqual,
  deepEqual,
  describeArgumentsFault,
  isOutcomeHandler,
} from './acl-handlers.js';

/**
 * Reader for an ACL YAML file. Installed by the Node-only side-effect
 * module `./acl-file.ts`; remains `null` in browser bundles so that
 * `ACL.load()` throws a clear runtime error instead of silently
 * dragging `node:fs` into the browser closure.
 */
type AclFileLoader = (yamlPath: string) => ACL;
let _aclFileLoader: AclFileLoader | null = null;

/**
 * @internal — used by `./acl-file.ts` to install the Node-side reader.
 * Pass `null` to uninstall (used by tests that need to assert the
 * browser-side guidance error).
 */
export function _setAclFileLoader(fn: AclFileLoader | null): void {
  _aclFileLoader = fn;
}

/**
 * Minimal structural view of a `Config` used by `ACL.discover()`.
 *
 * Declared structurally (rather than importing the concrete `Config`
 * class) so `acl.ts` stays free of the `node:fs`-bearing `config.ts`
 * module and the browser closure remains clean. The real `Config`
 * satisfies this shape via its `get()` method and `sourcePath` getter.
 */
export interface AclConfigLike {
  get(key: string, defaultValue?: unknown): unknown;
  readonly sourcePath: string | null;
}

/**
 * Node-side filesystem discovery for `acl.root`. Installed by the Node-only
 * side-effect module `./acl-file.ts`; remains `null` in browser bundles so
 * that `ACL.discover()` throws a clear runtime error instead of pulling
 * `node:fs` / `node:path` into the browser closure.
 */
type AclDiscoverer = (config: AclConfigLike) => ACL | null;
let _aclDiscoverer: AclDiscoverer | null = null;

/**
 * @internal — used by `./acl-file.ts` to install the Node-side discoverer.
 * Pass `null` to uninstall (parity with `_setAclFileLoader`).
 */
export function _setAclDiscoverer(fn: AclDiscoverer | null): void {
  _aclDiscoverer = fn;
}

/**
 * @internal — true when the Node-side ACL discoverer has been installed.
 * Lets the `APCore` bootstrap skip `ACL.discover()` in browser bundles
 * (where the discoverer is never wired) instead of triggering its throw.
 */
export function _isAclDiscovererInstalled(): boolean {
  return _aclDiscoverer !== null;
}

/**
 * A rule's approval requirement (PROTOCOL_SPEC §6.1.6).
 *
 * Orthogonal to `effect`, which carries authorization. A rule answers two
 * independent questions — "may this caller reach this target at all?" and
 * "must *this particular call* be put to a human first?" — and folding them
 * into one enumeration would make the meaningless state "denied and needs
 * approval" representable while forcing the real one, "allowed but ask first",
 * to be spelled as a kind of denial.
 */
export type ACLApproval = 'required' | 'not_required';

export interface ACLRule {
  callers: string[];
  targets: string[];
  effect: string;
  description: string;
  conditions?: Record<string, unknown> | null;
  /**
   * Whether a call matching this rule must be put to a human before it runs
   * (PROTOCOL_SPEC §6.1.6). Absent means `'not_required'`, so every rule
   * written before v1.28.0 keeps its meaning exactly.
   *
   * `'required'` on an `effect: deny` rule is rejected with {@link ACLRuleError}
   * at every entry point that accepts rules. The combination has no meaning,
   * and silently ignoring one half of a governance rule is the failure mode
   * §6.1.5 was written to end.
   */
  approval?: ACLApproval;
}

/**
 * The structured result of an ACL check (PROTOCOL_SPEC §6.8.1).
 *
 * `check()` returns a boolean, which can carry authorization but not the
 * second axis of §6.1.6. This is the accessor that carries both.
 */
export interface AccessDecision {
  /** Authorization — unchanged semantics from today's boolean. */
  readonly access: 'allow' | 'deny';
  /** Whether **this call** must be put to a human before it runs (§6.1.6). */
  readonly approvalRequired: boolean;
  /** Index of the rule that decided, or `null` when none matched. */
  readonly matchedRuleIndex: number | null;
  /** Which branch of §6.3 produced the decision. */
  readonly reason: string;
}

/**
 * Per-call inputs to an ACL check beyond caller, target and `Context`.
 *
 * Optional throughout: an ACL consulted outside the pipeline supplies none,
 * and a condition that needs one it did not get is UNEVALUABLE under §6.1.1
 * rather than quietly answered against an empty stand-in.
 */
export interface AccessCheckOptions {
  /**
   * The §6.1.8 governance projection of the call's arguments — key set and
   * JSON types, never a value. Read by the built-in `arguments` condition
   * (§6.1.7). The pipeline computes it at Step 3 and passes it here at Step 4.
   */
  readonly arguments?: GovernanceProjection | null;
}

/** Structured record of an ACL check decision. */
export interface AuditEntry {
  readonly timestamp: string; // ISO 8601
  readonly callerId: string;
  readonly targetId: string;
  readonly decision: string; // "allow" or "deny"
  readonly reason: string; // "rule_match", "default_effect", "no_rules"
  readonly matchedRule: string | null; // Rule description
  readonly matchedRuleIndex: number | null;
  readonly identityType: string | null;
  readonly roles: readonly string[];
  readonly callDepth: number | null;
  readonly traceId: string | null;
  /** Error message from a condition handler that threw during evaluation, if any.
   *  Cross-language parity with apcore-python AuditEntry.handler_error (sync A-D-024). */
  readonly handlerError: string | null;
  /**
   * Whether the matched rule required this call to be put to a human
   * (PROTOCOL_SPEC §6.3.1, §6.1.6). `false` when no rule matched or the
   * matched rule required none.
   *
   * A field **beside** `decision` rather than a third `decision` value:
   * `decision` is a string downstream consumers parse, and widening it would
   * break every existing parser.
   */
  readonly approvalRequired: boolean;
}

export type AuditLogger = (entry: AuditEntry) => void;

export type { ConditionOutcome, GovernanceProjection } from './acl-handlers.js';

/**
 * One structural or registry fault reported by {@link ACL.validateRules}
 * (PROTOCOL_SPEC §6.1.2 rule 3, §6.1.3, §6.1.4).
 *
 * `syncResolvable` and `asyncResolvable` are reported separately and MUST NOT
 * be collapsed into one boolean: `asyncCheck()` consults the async registry
 * and falls back to the sync one, while `check()` consults only the sync
 * registry, so a key registered *only* as an async handler is a working
 * condition on one path and an unevaluable one on the other.
 */
export interface RuleValidationFinding {
  /** Index of the offending rule in definition order. */
  readonly ruleIndex: number;
  /**
   * Where the fault sits (§6.1.4): `roles`, `$or[1].mispelled`, `$` for a
   * `conditions` that is not a mapping, `callers` / `targets` for §6.1.4.1.
   * Findings order by this, not by key — a nested `$or` can carry one key at
   * several positions, which leaves key ordering undefined.
   */
  readonly conditionPath: string;
  /**
   * The condition key itself, for readers who do not need the path. `null`
   * where the fault has no key: a non-mapping `conditions`, a malformed
   * `callers` / `targets`, or a non-mapping `$or` element.
   */
  readonly conditionKey: string | null;
  /** The rule's effect — a finding on a `deny` rule is the consequential one. */
  readonly effect: string;
  /**
   * Whether the condition resolves for `check()`.
   *
   * Both flags mean **resolvable on that evaluation path**, not "present in
   * that registry" (§6.1.3 rule 2) — which is why they are `*Resolvable` and
   * not `*Registered`. A structural fault is resolvable on neither path, so
   * both are `false`; an async-only key is `false` / `true`.
   */
  readonly syncResolvable: boolean;
  /** Whether the condition resolves for `asyncCheck()` — the union of the two registries. */
  readonly asyncResolvable: boolean;
}

/**
 * The outcome of matching one rule against a call (PROTOCOL_SPEC §6.3).
 *
 * `'unevaluable'` is not a third kind of "no": it resolves toward refusing
 * access, so a `deny` rule carrying it MATCHES and denies while an `allow`
 * rule carrying it does not match and MUST NOT grant (§6.1.1).
 */
type RuleOutcome = 'match' | 'no_match' | 'unevaluable';

/**
 * Per-`check()` state private to one evaluation.
 *
 * `errors` is keyed by §6.1.4 **condition path** so the same path reported
 * twice in one evaluation collapses to one message and the set can be ordered
 * lexicographically on the way out — by path and not by key, because a nested
 * `$or` can carry one key at several positions, which leaves key ordering
 * undefined. `pending` records the paths added since the rule loop last drained
 * it, so the loop can name exactly the ones that made the rule it just
 * evaluated unevaluable (§6.1.1 rule 3 requires the warning to name the path,
 * the rule index and the effect).
 *
 * `projection` rides the same frame because it has exactly the same lifetime
 * and the same hazards: a nested `check()` from inside a condition handler, or
 * a concurrent `asyncCheck()` suspended mid-evaluation, must not read another
 * call's arguments.
 */
interface EvaluationFrame {
  /** §6.1.4 condition path → message. Keyed by path so §6.1.1 rule 2 can order by it. */
  readonly errors: Map<string, string>;
  /** Paths recorded since the rule loop last drained this, in discovery order. */
  pending: string[];
  /** §6.1.8 governance projection supplied for this evaluation, if any. */
  readonly projection: GovernanceProjection | null;
}

/**
 * JSONPath-style root token for the `conditions` object itself (§6.1.4). Used
 * when `conditions` is not a mapping at all, so no key exists to name.
 */
const CONDITIONS_ROOT_PATH = '$';

/** Which registry decides "resolvable" — §6.1.4 checks the path in use. */
type EvaluationPath = 'sync' | 'async';

/**
 * One structural or registry fault found by §6.1.4's precheck.
 *
 * The precheck is context-independent and runs no handler, so a fault is a
 * pure function of the rule — which is what lets every SDK report the same
 * set, in the same order, for the same rule.
 */
interface RuleFault {
  readonly path: string;
  readonly key: string | null;
  readonly message: string;
  readonly syncResolvable: boolean;
  readonly asyncResolvable: boolean;
}

/**
 * §6.1.3 — whether a condition key resolves on each evaluation path.
 *
 * Both flags mean **resolvable on that path**, not "present in that registry":
 * `asyncCheck()` falls back to the sync registry, so `asyncResolvable` is the
 * union of the two and every built-in leaf handler is resolvable on both.
 *
 * Installed by the `ACL` class body below, which owns the two private
 * registries; declaring it here keeps the precheck a plain function.
 */
let conditionResolvability: (key: string) => {
  syncResolvable: boolean;
  asyncResolvable: boolean;
} = () => ({ syncResolvable: false, asyncResolvable: false });

/** Order faults by §6.1.4 condition path (§6.1.1 rule 2, §6.1.2 rule 3). */
function byPath(a: RuleFault, b: RuleFault): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Join a parent path with a child key, per §6.1.4's path table. */
function childPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

/**
 * §6.1.4.1 — `callers` and `targets` MUST be lists of strings.
 *
 * A bare string is iterable in several host languages, so `callers: "admin.*"`
 * written where `["admin.*"]` was meant is read character by character and its
 * `*` matches everything — an `allow` rule carrying that typo grants access to
 * every caller. TypeScript instead threw a `TypeError` out of `check()`, which
 * fails closed but violates `Contract: ACL.check`'s "MUST NOT raise to
 * indicate a deny". Either way the value must never be read as a pattern set:
 * it is a malformed rule, and §6.1.1's effect table decides what that means.
 */
function precheckPatternField(
  field: 'callers' | 'targets',
  value: unknown,
  out: RuleFault[],
): void {
  let detail: string | null = null;
  if (!Array.isArray(value)) {
    detail = `got ${aclTypeName(value)}`;
  } else {
    const badIndex = value.findIndex((p) => typeof p !== 'string');
    if (badIndex !== -1) {
      detail = `got a list whose element ${badIndex} is ${aclTypeName(value[badIndex])}`;
    }
  }
  if (detail === null) return;
  out.push({
    path: field,
    key: null,
    message: `ACL rule field '${field}' must be a list of strings, ${detail}`,
    // A structural fault is resolvable on neither evaluation path.
    syncResolvable: false,
    asyncResolvable: false,
  });
}

/**
 * §6.1.4 — walk a rule's whole `conditions` tree, every `$or` / `$not` branch
 * included, checking structure and the handler registries only.
 *
 * Supplies no context and invokes no handler, so it can run **before** §6.5's
 * "conditions present but no context provided" check — which is what closes
 * the bypass where `conditions: {mispelled: true}` on a `deny` rule passed
 * traffic simply because the caller carried no identity. It never
 * short-circuits: it has no decisive outcome to short-circuit on, and its
 * completeness is what makes §6.1.1 rule 2's deterministic `handler_error`
 * achievable.
 *
 * @param prefix - The §6.1.4 path of the object being walked (`''` at the root).
 */
function precheckConditions(
  conditions: unknown,
  prefix: string,
  mode: EvaluationPath,
  out: RuleFault[],
): void {
  if (!isConditionsObject(conditions)) {
    // §6.1.1 case 5 at the root; a non-mapping `$or` element deeper in.
    const path = prefix === '' ? CONDITIONS_ROOT_PATH : prefix;
    out.push({
      path,
      key: null,
      message: `ACL conditions '${path}' must be a mapping, got ${aclTypeName(conditions)}`,
      syncResolvable: false,
      asyncResolvable: false,
    });
    return;
  }

  for (const [key, value] of Object.entries(conditions)) {
    const path = childPath(prefix, key);

    if (key === '$or') {
      // §6.1.1 case 4 — a value malformed for its key.
      if (!Array.isArray(value)) {
        out.push({
          path,
          key,
          message: `ACL condition '${path}' must be a list of condition objects, got ${aclTypeName(value)}`,
          syncResolvable: false,
          asyncResolvable: false,
        });
        continue;
      }
      value.forEach((sub, i) => precheckConditions(sub, `${path}[${i}]`, mode, out));
      continue;
    }

    if (key === '$not') {
      if (!isConditionsObject(value)) {
        out.push({
          path,
          key,
          message: `ACL condition '${path}' must be a condition object, got ${aclTypeName(value)}`,
          syncResolvable: false,
          asyncResolvable: false,
        });
        continue;
      }
      precheckConditions(value, path, mode, out);
      continue;
    }

    if (key === 'arguments') {
      // §6.1.7's predicate vocabulary is closed and its values are structural,
      // so the whole condition is checkable here — context-free, handler-free
      // and therefore identical across SDKs. Whether a projection was supplied
      // is a per-call question and deliberately NOT asked here, exactly as
      // `roles` is not faulted for a caller who supplied no identity.
      const fault = describeArgumentsFault(value, path);
      if (fault !== null) {
        out.push({ path, key, message: fault, syncResolvable: false, asyncResolvable: false });
      }
      continue;
    }

    // §6.1.1 case 1 / §6.1.3 — resolvable on the evaluation path in use.
    const { syncResolvable, asyncResolvable } = conditionResolvability(key);
    const resolvable = mode === 'sync' ? syncResolvable : asyncResolvable;
    if (resolvable) continue;
    out.push({
      path,
      key,
      message: `Unknown ACL condition '${path}'`,
      syncResolvable,
      asyncResolvable,
    });
  }
}

/**
 * §6.1.4 — the complete, ordered fault set for one rule, structural pattern
 * fields included. Ordered by path so every SDK reports the same sequence.
 */
function precheckRule(rule: ACLRule, mode: EvaluationPath): RuleFault[] {
  const faults: RuleFault[] = [];
  precheckPatternField('callers', rule.callers, faults);
  precheckPatternField('targets', rule.targets, faults);
  if (rule.conditions != null) precheckConditions(rule.conditions, '', mode, faults);
  faults.sort(byPath);
  return faults;
}

/** @internal — exported so `./acl-file.ts` can reuse the parser. */
/**
 * The complete set of keys an ACL rule may carry (PROTOCOL_SPEC §6.1).
 *
 * Closed on purpose: a key nothing evaluates is otherwise dropped in silence,
 * which widens an `allow` rule with no warning (#107).
 */
const RULE_KEYS = new Set([
  'callers',
  'targets',
  'effect',
  'description',
  'conditions',
  // §6.1.6 (v1.28.0). Adding it was only safe once v1.27.0 closed this set: an
  // SDK that still dropped unknown keys would read a `deny`-with-`approval`
  // rule as a bare rule and act on half of what its author wrote.
  'approval',
]);

/** The two values §6.1.6 defines for a rule's `approval` field. */
const APPROVAL_VALUES = new Set<string>(['required', 'not_required']);

/**
 * §6.1.6 rule 2 — `approval: required` on a `deny` rule is rejected.
 *
 * "Denied **and** needs approval" is not a state that means anything. Loading
 * it and enforcing only the `deny` half would be acting on half of a
 * governance rule, which is the failure mode §6.1.5 was written to end.
 *
 * Applied at every entry point that accepts rules — file loading, direct
 * construction and runtime insertion — because a rule built in code is exactly
 * as meaningless as one parsed from YAML.
 */
function rejectDenyWithApproval(rule: ACLRule, index: number): void {
  if (rule.approval !== 'required') return;
  if (rule.effect !== 'deny') return;
  throw new ACLRuleError(
    `Rule ${index} carries approval: 'required' on an effect: 'deny' rule. ` +
      'Authorization and approval are two independent results (PROTOCOL_SPEC §6.1.6) ' +
      'and "denied and needs approval" is not a state that means anything — a denied ' +
      'call never reaches the approval gate. Drop the approval field, or make the rule ' +
      "effect: 'allow' with approval: 'required' if the intent was \"allowed but ask first\".",
  );
}

/**
 * Reserved in earlier revisions of §6.1 and evaluated by no implementation.
 * Rejected like any other unknown key, but named as reserved in the message: an
 * operator who wrote `actions: ["describe"]` meant to restrict the rule and is
 * better served by "not implemented" than by "unknown key".
 */
const RESERVED_RULE_KEYS = new Set(['id', 'actions', 'priority']);

function rejectUnknownRuleKeys(index: number, ruleObj: Record<string, unknown>): void {
  const unknown = Object.keys(ruleObj)
    .filter((k) => !RULE_KEYS.has(k))
    .sort();
  if (unknown.length === 0) return;
  const reserved = unknown.filter((k) => RESERVED_RULE_KEYS.has(k));
  const other = unknown.filter((k) => !RESERVED_RULE_KEYS.has(k));
  const parts: string[] = [];
  if (reserved.length > 0) {
    parts.push(
      `${reserved.map((k) => `'${k}'`).join(', ')} reserved for a future ` +
        'specification version and evaluated by no implementation',
    );
  }
  if (other.length > 0) {
    parts.push(`${other.map((k) => `'${k}'`).join(', ')} unrecognised`);
  }
  throw new ACLRuleError(
    `Rule ${index} carries ${parts.join('; ')}. The rule key set is closed ` +
      `(${[...RULE_KEYS].sort().join(', ')}); a key nothing evaluates would be ` +
      'dropped silently and leave the rule wider than written.',
  );
}

export function _parseAclRule(rawRule: unknown, index: number): ACLRule {
  if (typeof rawRule !== 'object' || rawRule === null || Array.isArray(rawRule)) {
    throw new ACLRuleError(`Rule ${index} must be a mapping, got ${typeof rawRule}`);
  }

  const ruleObj = rawRule as Record<string, unknown>;
  for (const key of ['callers', 'targets', 'effect']) {
    if (!(key in ruleObj)) {
      throw new ACLRuleError(`Rule ${index} missing required key '${key}'`);
    }
  }

  // A missing key was already rejected above so an omission cannot render a
  // rule inert; an unknown key is the same hazard pointing the other way, and
  // was dropped in silence until #107.
  rejectUnknownRuleKeys(index, ruleObj);

  const effect = ruleObj['effect'] as string;
  if (effect !== 'allow' && effect !== 'deny') {
    throw new ACLRuleError(`Rule ${index} has invalid effect '${effect}', must be 'allow' or 'deny'`);
  }

  const callers = ruleObj['callers'];
  if (!Array.isArray(callers)) {
    throw new ACLRuleError(`Rule ${index} 'callers' must be a list, got ${typeof callers}`);
  }

  const targets = ruleObj['targets'];
  if (!Array.isArray(targets)) {
    throw new ACLRuleError(`Rule ${index} 'targets' must be a list, got ${typeof targets}`);
  }

  // `conditions` was previously taken with a bare `as` cast, which asserts a shape
  // TypeScript cannot check at runtime. A scalar therefore reached the gate, where
  // `Object.entries(5)` is `[]` and the AND-loop is vacuously satisfied — an
  // `effect: allow` rule became unconditional. Validate it here like every sibling key.
  const rawConditions = ruleObj['conditions'];
  if (rawConditions !== undefined && rawConditions !== null && !isConditionsObject(rawConditions)) {
    throw new ACLRuleError(
      `Rule ${index} 'conditions' must be a mapping, got ${aclTypeName(rawConditions)}`,
    );
  }

  // §6.1.6: `approval` is optional and its absence means 'not_required', so
  // every rule written before v1.28.0 keeps its meaning exactly. A value
  // outside the two-member enumeration is rejected rather than coerced — a
  // governance field set by truthiness is a decision made by accident.
  const rawApproval = ruleObj['approval'];
  let approval: ACLApproval = 'not_required';
  if (rawApproval !== undefined && rawApproval !== null) {
    if (typeof rawApproval !== 'string' || !APPROVAL_VALUES.has(rawApproval)) {
      throw new ACLRuleError(
        `Rule ${index} has invalid approval '${String(rawApproval)}', ` +
          "must be 'required' or 'not_required'",
      );
    }
    approval = rawApproval as ACLApproval;
  }

  const rule: ACLRule = {
    callers: callers as string[],
    targets: targets as string[],
    effect,
    description: (ruleObj['description'] as string) ?? '',
    conditions: (rawConditions as Record<string, unknown>) ?? null,
    approval,
  };
  rejectDenyWithApproval(rule, index);
  return rule;
}

/** True only for a plain object — excludes null, arrays and every primitive. */
function isConditionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-ish type name for diagnostics, mirroring executor.ts's `jsonTypeName`. */
function aclTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export class ACL {
  private static conditionHandlers = new Map<string, ACLConditionHandler>();
  private static asyncConditionHandlers = new Map<string, ACLConditionHandler>();

  static {
    // Give the module-level precheck read access to the two private
    // registries without widening the class's public surface.
    conditionResolvability = (key: string) => {
      const syncResolvable = ACL.conditionHandlers.has(key);
      return {
        syncResolvable,
        asyncResolvable: syncResolvable || ACL.asyncConditionHandlers.has(key),
      };
    };
  }

  static registerCondition(key: string, handler: ACLConditionHandler): void {
    ACL.conditionHandlers.set(key, handler);
  }

  /** Register an async-aware handler for use specifically under asyncCheck(). Falls back to conditionHandlers. */
  static registerAsyncCondition(key: string, handler: ACLConditionHandler): void {
    ACL.asyncConditionHandlers.set(key, handler);
  }

  /**
   * Per-`check()` / per-`asyncCheck()` capture slot for the handler-error
   * message produced by `_evaluateConditions[Async]`.
   *
   * `_currentFrame` names the frame belonging to the evaluation *currently*
   * on the stack. `_evaluateConditions[Async]` captures the reference at
   * entry and writes to that captured object, never back through the static
   * — so neither a nested `check()` (which pushes and pops its own frame)
   * nor a concurrent `asyncCheck()` suspended mid-evaluation can steal or
   * clobber another call's error. This is the JS equivalent of
   * apcore-python's `_handler_error_var` ContextVar token pair and
   * apcore-rust's depth-tracked thread-local / tokio task-local
   * (sync findings A-D-026, W2).
   */
  private static _currentFrame: EvaluationFrame | null = null;

  /** @internal — open a capture frame; returns [frame, previousFrame]. */
  private static _pushEvaluationFrame(
    projection: GovernanceProjection | null,
  ): [EvaluationFrame, EvaluationFrame | null] {
    const previous = ACL._currentFrame;
    const frame: EvaluationFrame = {
      errors: new Map<string, string>(),
      pending: [],
      projection,
    };
    ACL._currentFrame = frame;
    return [frame, previous];
  }

  /**
   * @internal — the §6.1.8 governance projection bound to the evaluation
   * currently in flight, or `null` when the caller supplied none.
   *
   * Read by the built-in `arguments` handler. It rides the evaluation frame
   * rather than a bare static so a nested `check()` from inside a condition
   * handler, or a concurrent `asyncCheck()` suspended mid-evaluation, cannot
   * read another call's arguments.
   */
  static _currentGovernanceProjection(): GovernanceProjection | null {
    return ACL._currentFrame?.projection ?? null;
  }

  /** @internal — restore the caller's capture frame. */
  private static _popEvaluationFrame(previous: EvaluationFrame | null): void {
    ACL._currentFrame = previous;
  }

  /**
   * @internal — read-and-clear this evaluation's captured handler errors.
   *
   * PROTOCOL_SPEC §6.1.1 rule 2: when more than one condition in a single
   * `check()` is unevaluable, `handler_error` MUST report every one it
   * determined, ordered **lexicographically by condition path** and separated
   * by `"; "`. By path rather than evaluation order because the two are not the
   * same across languages — `serde_json`'s map is ordered while a JavaScript
   * object preserves insertion order — and by path rather than key because a
   * key may occur at several positions in a nested `$or` / `$not` tree.
   */
  private static _takeFrameError(frame: EvaluationFrame): string | null {
    if (frame.errors.size === 0) return null;
    const message = [...frame.errors.keys()]
      .sort()
      .map((key) => frame.errors.get(key) as string)
      .join('; ');
    frame.errors.clear();
    frame.pending.length = 0;
    return message;
  }

  /**
   * @internal — record an unevaluable condition on the evaluation currently in
   * flight and warn about it. Keyed by §6.1.4 condition path so §6.1.1 rule 2's
   * lexicographic ordering has something well-defined to order.
   */
  private static _recordUnevaluable(
    frame: EvaluationFrame | null,
    path: string,
    message: string,
  ): void {
    if (frame !== null) {
      if (!frame.errors.has(path)) frame.errors.set(path, message);
      frame.pending.push(path);
    }
    console.warn(
      `[apcore:acl] ${message} — the condition is UNEVALUABLE, not false ` +
        '(PROTOCOL_SPEC §6.1.1: a deny rule takes effect, an allow rule does not grant)',
    );
  }

  /**
   * @internal — §6.3.1's if-and-only-if, for a handler that reports UNEVALUABLE
   * by *returning* it rather than by throwing.
   *
   * The three producers above all record as they go. An
   * {@link ACLOutcomeConditionHandler} can also just return `'unevaluable'` —
   * the built-in `arguments` condition does, when no governance projection was
   * supplied (§6.1.8 rule 1) — and nothing would then reach `handlerError`,
   * leaving an operator with a denial and no reason for it.
   *
   * `$or` and `$not` return `'unevaluable'` too, but only when *propagating* a
   * child's, and that child has already recorded the precise path; a generic
   * entry at the operator's own path would duplicate it while naming a less
   * useful location. `sizeBefore` tells the two apart: anything recorded during
   * the call means the subtree spoke for itself.
   */
  private static _recordBareUnevaluable(
    frame: EvaluationFrame | null,
    path: string,
    sizeBefore: number,
  ): void {
    if (frame !== null && frame.errors.size > sizeBefore) return;
    ACL._recordUnevaluable(frame, path, `Handler for condition '${path}' could not evaluate it as written`);
  }

  /**
   * Evaluate one condition key on the **sync** path.
   *
   * Three of the four UNEVALUABLE producers live here (§6.1.1): no registered
   * handler, a handler that threw, and a handler that returned a Promise —
   * which JavaScript cannot inspect synchronously, so no answer is obtainable
   * at all on this path. (The fourth is a `conditions` value that is not a
   * mapping, handled by the caller.)
   */
  private static _evaluateConditionSync(
    key: string,
    path: string,
    value: unknown,
    context: Context,
    frame: EvaluationFrame | null,
  ): ConditionOutcome {
    const handler = ACL.conditionHandlers.get(key);
    if (handler === undefined) {
      ACL._recordUnevaluable(frame, path, `Unknown ACL condition '${path}'`);
      return 'unevaluable';
    }
    const sizeBefore = frame?.errors.size ?? 0;
    try {
      const result = isOutcomeHandler(handler)
        ? handler.evaluateOutcome(value, context, path)
        : handler.evaluate(value, context);
      if (result instanceof Promise) {
        // apcore-typescript cannot inspect a Promise synchronously, so an
        // async handler reached from check() yields no answer at all.
        ACL._recordUnevaluable(
          frame,
          path,
          `Async condition '${path}' in sync context — use asyncCheck()`,
        );
        return 'unevaluable';
      }
      if (typeof result === 'boolean') return result ? 'satisfied' : 'unsatisfied';
      if (result === 'unevaluable') ACL._recordBareUnevaluable(frame, path, sizeBefore);
      return result;
    } catch (e) {
      ACL._recordUnevaluable(
        frame,
        path,
        `Handler for condition '${path}' threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 'unevaluable';
    }
  }

  /**
   * Evaluate a `conditions` object on the sync path, AND-ing its keys with
   * PROTOCOL_SPEC §6.1.1's three-valued composition:
   *
   * - any child UNSATISFIED  → UNSATISFIED (an outright "no" wins)
   * - else any child UNEVALUABLE → UNEVALUABLE
   * - else → SATISFIED
   *
   * Short-circuits on the first UNSATISFIED child, which §6.1.1 permits: the
   * decision is identical either way and a child skipped that way was never
   * evaluated, so it is not unevaluable and MUST NOT set `handler_error`.
   * It deliberately does NOT short-circuit on UNEVALUABLE — a later sibling
   * may still produce the decisive UNSATISFIED, and every unevaluable
   * condition that was actually reached has to reach the audit entry.
   */
  static _evaluateConditions(
    conditions: Record<string, unknown>,
    context: Context,
    prefix = '',
  ): ConditionOutcome {
    // Bind the frame at entry so writes land on this evaluation's slot even if
    // another evaluation becomes current in the meantime.
    const frame = ACL._currentFrame;
    // Fail closed on a malformed `conditions`. §6.1.4's precheck normally
    // catches this before evaluation begins; the guard stays because a scalar
    // here would make `Object.entries()` return `[]`, satisfying the AND-loop
    // vacuously and turning an `allow` rule unconditional.
    if (!isConditionsObject(conditions)) {
      const path = prefix === '' ? CONDITIONS_ROOT_PATH : prefix;
      ACL._recordUnevaluable(
        frame,
        path,
        `ACL conditions '${path}' must be a mapping, got ${aclTypeName(conditions)}`,
      );
      return 'unevaluable';
    }
    let sawUnevaluable = false;
    for (const [key, value] of Object.entries(conditions)) {
      const outcome = ACL._evaluateConditionSync(
        key,
        childPath(prefix, key),
        value,
        context,
        frame,
      );
      if (outcome === 'unsatisfied') return 'unsatisfied';
      if (outcome === 'unevaluable') sawUnevaluable = true;
    }
    return sawUnevaluable ? 'unevaluable' : 'satisfied';
  }

  /**
   * Async twin of {@link ACL._evaluateConditions}, with the same three-valued
   * composition. Only two UNEVALUABLE producers apply here: no registered
   * handler on either registry, and a handler that threw — a Promise is simply
   * awaited on this path (§6.1.3).
   */
  static async _evaluateConditionsAsync(
    conditions: Record<string, unknown>,
    context: Context,
    prefix = '',
  ): Promise<ConditionOutcome> {
    // Bind the frame at entry — after an `await` the static may point at
    // another in-flight evaluation's frame.
    const frame = ACL._currentFrame;
    // Same fail-closed guard as the sync path — see _evaluateConditions.
    if (!isConditionsObject(conditions)) {
      const rootPath = prefix === '' ? CONDITIONS_ROOT_PATH : prefix;
      ACL._recordUnevaluable(
        frame,
        rootPath,
        `ACL conditions '${rootPath}' must be a mapping, got ${aclTypeName(conditions)}`,
      );
      return 'unevaluable';
    }
    let sawUnevaluable = false;
    for (const [key, value] of Object.entries(conditions)) {
      const path = childPath(prefix, key);
      // §6.1.3: the async registry is consulted first, then the sync one.
      const handler = ACL.asyncConditionHandlers.get(key) ?? ACL.conditionHandlers.get(key);
      if (handler === undefined) {
        ACL._recordUnevaluable(frame, path, `Unknown ACL condition '${path}'`);
        sawUnevaluable = true;
        continue;
      }
      let outcome: ConditionOutcome;
      const sizeBefore = frame?.errors.size ?? 0;
      try {
        const result = isOutcomeHandler(handler)
          ? await handler.evaluateOutcome(value, context, path)
          : await handler.evaluate(value, context);
        outcome = typeof result === 'boolean' ? (result ? 'satisfied' : 'unsatisfied') : result;
        if (outcome === 'unevaluable') ACL._recordBareUnevaluable(frame, path, sizeBefore);
      } catch (e) {
        ACL._recordUnevaluable(
          frame,
          path,
          `Handler for condition '${path}' threw: ${e instanceof Error ? e.message : String(e)}`,
        );
        outcome = 'unevaluable';
      }
      if (outcome === 'unsatisfied') return 'unsatisfied';
      if (outcome === 'unevaluable') sawUnevaluable = true;
    }
    return sawUnevaluable ? 'unevaluable' : 'satisfied';
  }

  private _rules: ACLRule[];
  private _defaultEffect: string;
  private _yamlPath: string | null = null;
  private _auditLogger: AuditLogger | null = null;
  /** Rule indices already warned about for want of a context (§6.5). */
  private readonly _warnedMissingContext = new Set<number>();
  debug: boolean = false;

  constructor(rules: ACLRule[], defaultEffect: string = 'deny', auditLogger?: AuditLogger | null) {
    if (defaultEffect !== 'allow' && defaultEffect !== 'deny') {
      throw new ACLRuleError(`Invalid default_effect '${defaultEffect}', must be 'allow' or 'deny'`);
    }
    this._rules = [...rules];
    this._defaultEffect = defaultEffect;
    this._auditLogger = auditLogger ?? null;
    // §6.1.6 rule 2 is fatal, not a warning: unlike an unregistered condition
    // key (§6.1.2 rule 1, which must not break bootstrap order) a
    // `deny` + `approval: required` rule can never become meaningful later.
    this._rules.forEach(rejectDenyWithApproval);
    // §6.1.2: direct construction is an entry point that accepts rules, so it
    // is covered by load-time validation too — `ACL.load()` reaches this same
    // constructor, which is why the file path needs no separate hook.
    this._warnRuleFaults();
  }

  /**
   * The effect applied when no rule matches (PROTOCOL_SPEC §6.8).
   *
   * A pure read: it emits no audit event, mutates nothing, and takes no lock.
   * Reflects a {@link ACL.reload}, because it reads the live object rather
   * than a cached parse.
   */
  get defaultEffect(): string {
    return this._defaultEffect;
  }

  /**
   * The current rule list in definition order — the order `check()` evaluates
   * it in (PROTOCOL_SPEC §6.8).
   *
   * Returns a frozen snapshot, never the ACL's own array: §6.8 rule 3 forbids
   * handing out a reference through which a caller could mutate the enforced
   * policy. Use {@link ACL.addRule} / {@link ACL.removeRule} to change it.
   */
  get rules(): readonly ACLRule[] {
    return Object.freeze(this._rules.slice());
  }

  /**
   * Report every rule that fails §6.1.4's precheck on the **sync** path
   * (PROTOCOL_SPEC §6.1.2 rule 3, §6.1.3, §6.1.4).
   *
   * Named `validateRules` and not `validateConditions` because it reports
   * structural faults in `callers` and `targets` as well (§6.1.4.1), not only
   * faults inside `conditions`.
   *
   * Condition handlers are registered at runtime into a process-wide registry
   * and `acl.root` discovery commonly runs during bootstrap, ahead of the
   * application code that registers them — so loading warns rather than
   * throwing, and this is the deterministic check to run once registration is
   * complete. A pure read: it mutates nothing and registers nothing.
   *
   * A finding is emitted whenever `syncResolvable` is false, **including**
   * when `asyncResolvable` is true: an application calling `check()` then has
   * a condition it cannot evaluate. A caller that only ever uses
   * `asyncCheck()` may ignore such a finding — that judgement belongs to the
   * caller, not to the validator.
   *
   * Findings are ordered by rule index, then lexicographically by **condition
   * path** — by path and not by key, because a nested `$or` may carry the same
   * key at several positions, which leaves key ordering undefined.
   */
  validateRules(): readonly RuleValidationFinding[] {
    const findings: RuleValidationFinding[] = [];
    const rules = this._rules.slice();
    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
      const rule = rules[ruleIndex];
      for (const fault of precheckRule(rule, 'sync')) {
        findings.push(
          Object.freeze({
            ruleIndex,
            conditionPath: fault.path,
            conditionKey: fault.key,
            effect: rule.effect,
            syncResolvable: fault.syncResolvable,
            asyncResolvable: fault.asyncResolvable,
          }),
        );
      }
    }
    return Object.freeze(findings);
  }

  /**
   * @internal — §6.1.2 rules 1-2 and 4: every entry point that accepts rules
   * warns, and none of them fails, for a rule that fails §6.1.4's precheck on
   * the sync path. The warning names the rule index, the condition path and
   * the rule's `effect`; the `effect` is in the message because a misconfigured
   * `deny` rule is the consequential case.
   *
   * @param onlyIndex - Validate a single rule index (used by `addRule`).
   */
  private _warnRuleFaults(onlyIndex?: number): void {
    const rules = this._rules;
    for (let i = 0; i < rules.length; i++) {
      if (onlyIndex !== undefined && i !== onlyIndex) continue;
      const rule = rules[i];
      for (const fault of precheckRule(rule, 'sync')) {
        const detail =
          fault.key !== null && !fault.syncResolvable && fault.asyncResolvable
            ? `${fault.message} — registered only as an async handler, so it resolves under asyncCheck() but is UNEVALUABLE under check()`
            : fault.message;
        console.warn(
          `[apcore:acl] Rule ${i} (effect=${rule.effect}): ${detail}. ` +
            'PROTOCOL_SPEC §6.1.1: an unevaluable condition makes a deny rule DENY and an ' +
            'allow rule not grant. Fix the rule or register a handler, and call ' +
            'acl.validateRules() once bootstrap is complete.',
        );
      }
    }
  }

  static load(yamlPath: string): ACL {
    if (_aclFileLoader === null) {
      throw new ACLRuleError(
        'ACL.load(yamlPath) requires the Node entry of apcore-js. The browser ' +
          'build does not bundle the file reader. Construct ACL programmatically ' +
          'with `new ACL([...rules])` instead.',
      );
    }
    return _aclFileLoader(yamlPath);
  }

  /**
   * Config-driven ACL discovery (D-64 / issue #74).
   *
   * Reads `acl.root` from `config` (defaulting to `"./acl"` when unset),
   * resolves it relative to the directory of the config's source file when
   * `config.sourcePath` is known — otherwise relative to the process CWD —
   * and loads the ACL from that directory if it exists.
   *
   * Returns `null` when the resolved path does NOT exist. A missing path
   * MUST NOT synthesize an empty default-deny ACL: an empty ACL would deny
   * every inter-module call in every project lacking an `acl/` directory, a
   * silent and severe break. Missing path = no enforcement, identical to a
   * project that never configured an ACL. `acl.default_effect` only takes
   * effect once an ACL is actually loaded from a file.
   *
   * Node-only: filesystem access lives on `./acl-file.ts`. In browser
   * bundles the discoverer is never installed and this throws a clear
   * runtime error (parity with {@link ACL.load}).
   */
  static discover(config: AclConfigLike): ACL | null {
    if (_aclDiscoverer === null) {
      throw new ACLRuleError(
        'ACL.discover(config) requires the Node entry of apcore-js. The browser ' +
          'build does not bundle the filesystem discoverer. Construct ACL ' +
          'programmatically with `new ACL([...rules])` instead.',
      );
    }
    return _aclDiscoverer(config);
  }

  /** @internal — used by `./acl-file.ts` to set `_yamlPath` after parsing. */
  _setYamlPath(yamlPath: string): void {
    this._yamlPath = yamlPath;
  }

  /**
   * Whether the call is authorized — the legacy boolean entry point.
   *
   * **It fails closed on an approval requirement** (PROTOCOL_SPEC §6.8.1): a
   * rule resolving to `allow` with `approvalRequired: true` makes this return
   * `false`. `check()` is public API consumed by callers that are not the
   * Executor — tooling, preflight helpers, third-party integrations — and such
   * a caller can only read a boolean as "let it through / do not". Returning
   * `true` would let it execute a call the ACL said needed a human. `false` is
   * wrong in the benign direction: the caller sees a refusal where the truth
   * was "ask first". Use {@link ACL.checkAccess} to see both axes.
   */
  check(
    callerId: string | null,
    targetId: string,
    context?: Context | null,
    options?: AccessCheckOptions | null,
  ): boolean {
    const decision = this.checkAccess(callerId, targetId, context, options);
    return decision.access === 'allow' && !decision.approvalRequired;
  }

  /**
   * The structured decision for a call (PROTOCOL_SPEC §6.8.1) — authorization
   * and approval requirement as the two independent results §6.1.6 defines.
   *
   * Emits exactly one audit entry, like {@link ACL.check}, which delegates here.
   */
  checkAccess(
    callerId: string | null,
    targetId: string,
    context?: Context | null,
    options?: AccessCheckOptions | null,
  ): AccessDecision {
    const effectiveCaller = callerId === null ? '@external' : callerId;
    const ctx = context ?? null;
    // Snapshot rules + defaultEffect + auditLogger atomically so concurrent
    // addRule/removeRule/setDefaultEffect calls cannot mutate state mid-evaluation.
    // Mirrors asyncCheck snapshot semantics for sync/async parity.
    const rules = this._rules.slice();
    const defaultEffect = this._defaultEffect;
    const auditLogger = this._auditLogger;
    // Open a capture frame private to this evaluation. A nested check()
    // invoked from a condition handler pushes its own frame and restores
    // ours on exit, so it can no longer consume our handler error.
    const [frame, previousFrame] = ACL._pushEvaluationFrame(options?.arguments ?? null);

    try {
      for (let idx = 0; idx < rules.length; idx++) {
        const rule = rules[idx];
        frame.pending.length = 0;
        const outcome = this._matchesRule(rule, effectiveCaller, targetId, ctx, idx);
        if (outcome === 'unevaluable' && !ACL._resolveUnevaluable(rule, idx, frame)) continue;
        if (outcome === 'no_match') continue;
        return this._decideByRule(effectiveCaller, targetId, rule, idx, ctx, auditLogger, frame);
      }

      return this._decideByDefault(
        effectiveCaller, targetId, defaultEffect, rules.length, ctx, auditLogger, frame,
      );
    } finally {
      ACL._popEvaluationFrame(previousFrame);
    }
  }

  /** Async twin of {@link ACL.check}, with the same §6.8.1 fail-closed rule. */
  async asyncCheck(
    callerId: string | null,
    targetId: string,
    context?: Context | null,
    options?: AccessCheckOptions | null,
  ): Promise<boolean> {
    const decision = await this.asyncCheckAccess(callerId, targetId, context, options);
    return decision.access === 'allow' && !decision.approvalRequired;
  }

  /** Async twin of {@link ACL.checkAccess} (PROTOCOL_SPEC §6.8.1). */
  async asyncCheckAccess(
    callerId: string | null,
    targetId: string,
    context?: Context | null,
    options?: AccessCheckOptions | null,
  ): Promise<AccessDecision> {
    const effectiveCaller = callerId === null ? '@external' : callerId;
    const ctx = context ?? null;
    // Snapshot mutable fields before any await to prevent async-gap races
    // (e.g. a concurrent setDefaultEffect() or addRule() call mid-evaluation).
    const rules = this._rules.slice();
    const defaultEffect = this._defaultEffect;
    const auditLogger = this._auditLogger;
    // Open a capture frame private to this evaluation (see checkAccess()).
    const [frame, previousFrame] = ACL._pushEvaluationFrame(options?.arguments ?? null);

    try {
      for (let idx = 0; idx < rules.length; idx++) {
        // Re-arm the current frame after every await gap: a concurrent
        // asyncCheck() may have become "current" while we were suspended.
        ACL._currentFrame = frame;
        const rule = rules[idx];
        frame.pending.length = 0;
        const outcome = await this._matchesRuleAsync(rule, effectiveCaller, targetId, ctx, idx);
        // Re-arm again: the await above may have yielded to another evaluation.
        ACL._currentFrame = frame;
        if (outcome === 'unevaluable' && !ACL._resolveUnevaluable(rule, idx, frame)) continue;
        if (outcome === 'no_match') continue;
        return this._decideByRule(effectiveCaller, targetId, rule, idx, ctx, auditLogger, frame);
      }

      return this._decideByDefault(
        effectiveCaller, targetId, defaultEffect, rules.length, ctx, auditLogger, frame,
      );
    } finally {
      ACL._popEvaluationFrame(previousFrame);
    }
  }

  /**
   * @internal — build the {@link AccessDecision} for a matched rule and emit
   * its audit entry. Shared by the sync and async paths so the two cannot
   * drift on §6.1.6's second axis.
   */
  private _decideByRule(
    callerId: string,
    targetId: string,
    rule: ACLRule,
    ruleIndex: number,
    ctx: Context | null,
    auditLogger: AuditLogger | null,
    frame: EvaluationFrame,
  ): AccessDecision {
    const access = rule.effect === 'allow' ? 'allow' : 'deny';
    // §6.1.6: the two results are orthogonal, and `approval: required` on a
    // `deny` rule is rejected at every entry point — the `access` guard is
    // belt-and-braces against a rule object mutated in place after load.
    const approvalRequired = access === 'allow' && rule.approval === 'required';
    if (auditLogger) {
      auditLogger(
        this._buildAuditEntry(
          callerId, targetId, access, 'rule_match', rule, ruleIndex, ctx,
          ACL._takeFrameError(frame), approvalRequired,
        ),
      );
    }
    return Object.freeze({ access, approvalRequired, matchedRuleIndex: ruleIndex, reason: 'rule_match' });
  }

  /**
   * @internal — build the {@link AccessDecision} for the no-rule-matched path.
   *
   * §6.9 row 2: `default_effect` stays `allow` / `deny` only. There is no
   * default approval requirement, so no match means `false`.
   */
  private _decideByDefault(
    callerId: string,
    targetId: string,
    defaultEffect: string,
    ruleCount: number,
    ctx: Context | null,
    auditLogger: AuditLogger | null,
    frame: EvaluationFrame,
  ): AccessDecision {
    const access = defaultEffect === 'allow' ? 'allow' : 'deny';
    const reason = ruleCount === 0 ? 'no_rules' : 'default_effect';
    if (auditLogger) {
      auditLogger(
        this._buildAuditEntry(
          callerId, targetId, access, reason, null, null, ctx,
          ACL._takeFrameError(frame), false,
        ),
      );
    }
    return Object.freeze({ access, approvalRequired: false, matchedRuleIndex: null, reason });
  }

  private _matchPatternsAsync(patterns: string[], value: string, context: Context | null): boolean {
    if (patterns.length === 0) return false;

    // Check for compound operators
    const first = patterns[0];
    if (first === '$or') {
      for (const p of patterns.slice(1)) {
        if (this._matchPattern(p, value, context)) return true;
      }
      return false;
    }
    if (first === '$not') {
      if (patterns.length < 2) return false;
      return !this._matchPattern(patterns[1], value, context);
    }

    // Standard OR behavior for flat list
    return patterns.some((p) => this._matchPattern(p, value, context));
  }

  private async _matchesRuleAsync(
    rule: ACLRule,
    caller: string,
    target: string,
    context: Context | null,
    ruleIndex: number,
  ): Promise<RuleOutcome> {
    const frame = ACL._currentFrame;

    const structural = ACL._precheckPatternFields(rule);
    if (structural.length > 0) {
      ACL._recordFaults(structural, frame);
      return 'unevaluable';
    }

    if (!this._matchPatternsAsync(rule.callers, caller, context)) return 'no_match';
    if (!this._matchPatternsAsync(rule.targets, target, context)) return 'no_match';

    if (rule.conditions != null) {
      // §6.1.4, async path: "resolvable" is decided against the async registry
      // with its fallback to the sync one (§6.1.3), so an async-only key is a
      // live condition here and a precheck fault under check().
      const faults: RuleFault[] = [];
      precheckConditions(rule.conditions, '', 'async', faults);
      if (faults.length > 0) {
        ACL._recordFaults(faults.sort(byPath), frame);
        return 'unevaluable';
      }
      if (context === null) {
        this._warnConditionalRuleWithoutContext(rule, ruleIndex);
        return 'no_match';
      }
      const outcome = await ACL._evaluateConditionsAsync(rule.conditions, context);
      if (outcome === 'unsatisfied') return 'no_match';
      if (outcome === 'unevaluable') return 'unevaluable';
    }

    return 'match';
  }

  private _buildAuditEntry(
    callerId: string,
    targetId: string,
    decision: string,
    reason: string,
    matchedRule: ACLRule | null,
    matchedRuleIndex: number | null,
    context: Context | null,
    handlerError: string | null = null,
    approvalRequired = false,
  ): AuditEntry {
    let identityType: string | null = null;
    let roles: readonly string[] = [];
    let callDepth: number | null = null;
    let traceId: string | null = null;

    if (context !== null) {
      traceId = context.traceId;
      callDepth = context.callChain.length;
      if (context.identity !== null) {
        identityType = context.identity.type;
        roles = context.identity.roles;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      callerId,
      targetId,
      decision,
      reason,
      matchedRule: matchedRule?.description ?? null,
      matchedRuleIndex,
      identityType,
      roles,
      callDepth,
      traceId,
      handlerError,
      approvalRequired,
    };
  }

  private _matchPattern(pattern: string, value: string, context: Context | null): boolean {
    if (pattern === '@external') return value === '@external';
    if (pattern === '@system') {
      return context !== null && context.identity !== null && context.identity.type === 'system';
    }
    return matchPattern(pattern, value);
  }

  private _matchPatterns(patterns: string[], value: string, context: Context | null): boolean {
    if (patterns.length === 0) return false;

    // Check for compound operators
    const first = patterns[0];
    if (first === '$or') {
      return patterns.slice(1).some((p) => this._matchPattern(p, value, context));
    }
    if (first === '$not') {
      if (patterns.length < 2) return false;
      return !this._matchPattern(patterns[1], value, context);
    }

    // Standard OR behavior for flat list
    return patterns.some((p) => this._matchPattern(p, value, context));
  }

  /**
   * @internal — §6.1.4.1: `callers` / `targets` are checked for structure
   * before they are read as pattern sets, so a malformed one is unevaluable
   * rather than a `TypeError` out of `check()` (or, in a language where a bare
   * string is iterable, a wildcard that grants everything).
   *
   * Both fields are checked even when the first is already malformed, and
   * before the patterns are matched at all: the precheck does not
   * short-circuit, and a rule whose fields cannot be read is not a rule that
   * can be said to miss.
   */
  private static _precheckPatternFields(rule: ACLRule): RuleFault[] {
    const faults: RuleFault[] = [];
    precheckPatternField('callers', rule.callers, faults);
    precheckPatternField('targets', rule.targets, faults);
    return faults;
  }

  /** @internal — record a precheck's faults on the in-flight evaluation. */
  private static _recordFaults(faults: RuleFault[], frame: EvaluationFrame | null): void {
    for (const fault of faults) ACL._recordUnevaluable(frame, fault.path, fault.message);
  }

  private _matchesRule(
    rule: ACLRule,
    caller: string,
    target: string,
    context: Context | null,
    ruleIndex: number,
  ): RuleOutcome {
    const frame = ACL._currentFrame;

    const structural = ACL._precheckPatternFields(rule);
    if (structural.length > 0) {
      ACL._recordFaults(structural, frame);
      return 'unevaluable';
    }

    if (!this._matchPatterns(rule.callers, caller, context)) return 'no_match';
    if (!this._matchPatterns(rule.targets, target, context)) return 'no_match';

    if (rule.conditions != null) {
      // §6.1.4: the structural and registry precheck is context-independent,
      // runs no handler, and MUST run BEFORE §6.5's no-context check — that
      // ordering is what closes the bypass where `conditions: {mispelled: true}`
      // on a deny rule passed traffic simply because the caller carried no
      // identity. It also cannot short-circuit, so every configuration fault in
      // the tree reaches handler_error whatever a sibling would have done.
      const faults: RuleFault[] = [];
      precheckConditions(rule.conditions, '', 'sync', faults);
      if (faults.length > 0) {
        ACL._recordFaults(faults.sort(byPath), frame);
        return 'unevaluable';
      }
      if (context === null) {
        // §6.1.4 rule 2: a rule that PASSES the precheck and then finds no
        // context takes §6.5's path. `roles` is answerable in principle; this
        // caller merely supplied no input for it.
        this._warnConditionalRuleWithoutContext(rule, ruleIndex);
        return 'no_match';
      }
      const outcome = ACL._evaluateConditions(rule.conditions, context);
      if (outcome === 'unsatisfied') return 'no_match';
      if (outcome === 'unevaluable') return 'unevaluable';
    }

    return 'match';
  }

  /**
   * @internal — §6.5: "conditions present but no context provided" is a plain
   * non-match, NOT an unevaluable condition. Calling with no context is a
   * legitimate shape for an external entry point, not a misconfiguration, and
   * treating it as an evaluation failure would flip the decision for every
   * `@external` call meeting a conditional `deny` rule.
   *
   * The consequence still needs saying out loud: a conditional `deny` rule is
   * therefore not a backstop for context-less callers. §6.5 asks for a warning
   * the first time such a rule is skipped, naming the rule index and effect.
   */
  private _warnConditionalRuleWithoutContext(rule: ACLRule, ruleIndex: number): void {
    if (this._warnedMissingContext.has(ruleIndex)) return;
    this._warnedMissingContext.add(ruleIndex);
    console.warn(
      `[apcore:acl] Rule ${ruleIndex} (effect=${rule.effect}) carries conditions but the call ` +
        'supplied no Context, so the rule does not match (PROTOCOL_SPEC §6.5). A conditional ' +
        'deny rule is not a backstop for context-less callers — express a backstop as an ' +
        'unconditional deny rule or as default_effect: deny.',
    );
  }

  /**
   * @internal — apply §6.1.1's effect rule to a rule whose conditions could not
   * be evaluated, warn as rule 3 requires, and say whether the rule takes
   * effect.
   *
   * | effect  | condition unevaluable                     |
   * |---------|-------------------------------------------|
   * | `allow` | does not match → continue (MUST NOT grant)|
   * | `deny`  | rule MUST take effect → the call is denied |
   *
   * @returns true when the rule matches and its effect stands.
   */
  private static _resolveUnevaluable(
    rule: ACLRule,
    ruleIndex: number,
    frame: EvaluationFrame,
  ): boolean {
    const takesEffect = rule.effect === 'deny';
    const keys = [...new Set(frame.pending)];
    const named = keys.length > 0 ? keys.map((k) => `'${k}'`).join(', ') : '(see handler_error)';
    console.warn(
      `[apcore:acl] Rule ${ruleIndex} (effect=${rule.effect}) has unevaluable condition(s) ` +
        `${named}. PROTOCOL_SPEC §6.1.1 resolves this toward refusing access: ` +
        (takesEffect
          ? 'the deny rule takes effect and the call is DENIED.'
          : 'the allow rule does not match and MUST NOT grant.'),
    );
    frame.pending.length = 0;
    return takesEffect;
  }

  /**
   * Insert a rule at the head of the list (highest priority).
   *
   * §6.1.2 rule 4 makes runtime insertion an entry point that must be covered
   * by load-time validation, so an unresolvable condition key on the new rule
   * warns here exactly as it does on construction. Insertion still succeeds:
   * warn, never fail.
   */
  addRule(rule: ACLRule): void {
    // §6.1.6 rule 2 — rejected before insertion, so a meaningless rule never
    // enters the list (§6.1.2 rule 4: runtime insertion is an entry point too).
    rejectDenyWithApproval(rule, 0);
    this._rules.unshift(rule);
    // Rule indices shifted by one; drop the per-index dedupe so a §6.5 warning
    // is not suppressed for a different rule that inherited an old index.
    this._warnedMissingContext.clear();
    this._warnRuleFaults(0);
  }

  removeRule(callers: string[], targets: string[], conditions?: Record<string, unknown> | null): boolean {
    for (let i = 0; i < this._rules.length; i++) {
      const rule = this._rules[i];
      if (!arraysEqual(rule.callers, callers) || !arraysEqual(rule.targets, targets)) continue;
      // Treat an explicit null the same as an omitted/undefined argument:
      // both mean "ignore conditions when matching". Only a concrete
      // conditions object disambiguates by deep equality. Mirrors
      // apcore-python acl.py:631 (`conditions is not None`) and Rust
      // (sync finding A-D-016).
      if (conditions != null && !deepEqual(rule.conditions ?? null, conditions)) continue;
      this._rules.splice(i, 1);
      return true;
    }
    return false;
  }

  reload(): void {
    if (this._yamlPath === null) {
      throw new ACLRuleError('Cannot reload: ACL was not loaded from a YAML file');
    }
    const reloaded = ACL.load(this._yamlPath);
    this._rules = reloaded._rules;
    this._defaultEffect = reloaded._defaultEffect;
    // §6.8 rule 4: `rules` and `defaultEffect` read the live object, so both
    // accessors reflect the reloaded file with no further work.
    this._warnedMissingContext.clear();
    // Preserve auditLogger — reload only refreshes rules and default effect
  }
}

// ---------------------------------------------------------------------------
// Auto-register built-in handlers at module load time
// ---------------------------------------------------------------------------

// Spec PROTOCOL_SPEC.md §6.1 defines only the plural forms
// (`identity_types`, `roles`, `max_call_depth`). Singular aliases
// were removed to align with Python (apcore-python commit 2c204fb)
// and Rust (apcore-rust src/acl_handlers.rs).
ACL.registerCondition('identity_types', new IdentityTypesHandler());
ACL.registerCondition('roles', new RolesHandler());
ACL.registerCondition('max_call_depth', new MaxCallDepthHandler());
// §6.1.7 — `arguments` is BUILT IN and there is no registration point for it.
// It is registered here, with the other built-ins, precisely so that §6.1.4's
// precheck covers it for free: `argument:` written for `arguments:` is then an
// unregistered condition key, so the rule is unevaluable rather than silently
// inert. It reads the §6.1.8 projection bound to the evaluation in flight.
ACL.registerCondition('arguments', new ArgumentsHandler(ACL._currentGovernanceProjection));
ACL.registerCondition('$or', new OrHandler(ACL._evaluateConditions.bind(ACL)));
ACL.registerCondition('$not', new NotHandler(ACL._evaluateConditions.bind(ACL)));
// Async-aware variants used by asyncCheck() so Promise-returning conditions
// inside $or/$not are awaited rather than dropped via fail-closed.
ACL.registerAsyncCondition('$or', new OrHandlerAsync(ACL._evaluateConditionsAsync.bind(ACL)));
ACL.registerAsyncCondition('$not', new NotHandlerAsync(ACL._evaluateConditionsAsync.bind(ACL)));
