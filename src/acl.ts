/**
 * ACL (Access Control List) types and implementation for apcore.
 */

import type { Context } from './context.js';
import { ACLRuleError } from './errors.js';
import { matchPattern } from './utils/pattern.js';
import type { ACLConditionHandler, ConditionOutcome } from './acl-handlers.js';
import {
  IdentityTypesHandler,
  RolesHandler,
  MaxCallDepthHandler,
  OrHandler,
  NotHandler,
  OrHandlerAsync,
  NotHandlerAsync,
  arraysEqual,
  deepEqual,
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

export interface ACLRule {
  callers: string[];
  targets: string[];
  effect: string;
  description: string;
  conditions?: Record<string, unknown> | null;
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
}

export type AuditLogger = (entry: AuditEntry) => void;

export type { ConditionOutcome } from './acl-handlers.js';

/**
 * One rule/condition pair reported by {@link ACL.validateConditions}
 * (PROTOCOL_SPEC §6.1.2 rule 3, §6.1.3).
 *
 * `syncRegistered` and `asyncRegistered` are reported separately and MUST NOT
 * be collapsed into one boolean: `asyncCheck()` consults the async registry
 * and falls back to the sync one, while `check()` consults only the sync
 * registry, so a key registered *only* as an async handler is a working
 * condition on one path and an unevaluable one on the other.
 */
export interface ConditionValidationFinding {
  /** Index of the offending rule in definition order. */
  readonly ruleIndex: number;
  /** The condition key that does not resolve on the sync path. */
  readonly conditionKey: string;
  /** The rule's effect — a finding on a `deny` rule is the consequential one. */
  readonly effect: string;
  /** Whether the key resolves for `check()`. Always `false` on a finding. */
  readonly syncRegistered: boolean;
  /** Whether the key resolves for `asyncCheck()`. */
  readonly asyncRegistered: boolean;
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
 * Per-`check()` capture slot for unevaluable conditions.
 *
 * `errors` is keyed by condition key so the same key reported twice in one
 * evaluation collapses to one message and the set can be ordered
 * lexicographically on the way out. `pending` records, in evaluation order,
 * the keys recorded since the rule loop last drained it, so the loop can name
 * exactly the keys that made the rule it just evaluated unevaluable (§6.1.1
 * rule 3 requires the warning to name the key, the rule index and the effect).
 */
interface HandlerErrorFrame {
  readonly errors: Map<string, string>;
  pending: string[];
}

/**
 * Synthetic `handler_error` key used when a rule's `conditions` value is not a
 * mapping at all, so no real condition key exists to name.
 */
const MALFORMED_CONDITIONS_KEY = '$conditions';

/**
 * Every condition key a `conditions` object references, including keys nested
 * inside `$or` / `$not` sub-objects (PROTOCOL_SPEC §6.1.2 rule 2).
 *
 * Tolerates a malformed `conditions` value by yielding nothing: load-time
 * validation warns, it never throws, and `_parseAclRule` already rejects the
 * malformed shape on the file path.
 */
function collectConditionKeys(conditions: unknown, out: string[]): void {
  if (!isConditionsObject(conditions)) return;
  for (const [key, value] of Object.entries(conditions)) {
    out.push(key);
    if (key === '$or') {
      if (Array.isArray(value)) {
        for (const sub of value) collectConditionKeys(sub, out);
      }
    } else if (key === '$not') {
      collectConditionKeys(value, out);
    }
  }
}

/** @internal — exported so `./acl-file.ts` can reuse the parser. */
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

  return {
    callers: callers as string[],
    targets: targets as string[],
    effect,
    description: (ruleObj['description'] as string) ?? '',
    conditions: (rawConditions as Record<string, unknown>) ?? null,
  };
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
  private static _currentFrame: HandlerErrorFrame | null = null;

  /** @internal — open a capture frame; returns [frame, previousFrame]. */
  private static _pushHandlerErrorFrame(): [HandlerErrorFrame, HandlerErrorFrame | null] {
    const previous = ACL._currentFrame;
    const frame: HandlerErrorFrame = { errors: new Map<string, string>(), pending: [] };
    ACL._currentFrame = frame;
    return [frame, previous];
  }

  /** @internal — restore the caller's capture frame. */
  private static _popHandlerErrorFrame(previous: HandlerErrorFrame | null): void {
    ACL._currentFrame = previous;
  }

  /**
   * @internal — read-and-clear this evaluation's captured handler errors.
   *
   * PROTOCOL_SPEC §6.1.1 rule 2: when more than one condition in a single
   * `check()` is unevaluable, `handler_error` MUST report every one of them,
   * ordered **lexicographically by condition key** and separated by `"; "`.
   * Lexicographic rather than evaluation order because the two are not the
   * same across languages — `serde_json`'s map is ordered while a JavaScript
   * object preserves insertion order — so "the first one encountered" would
   * write a different key into the audit log for the same rule per SDK.
   */
  private static _takeFrameError(frame: HandlerErrorFrame): string | null {
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
   * flight and warn about it. Keyed by condition key so §6.1.1 rule 2's
   * lexicographic ordering has something to order.
   */
  private static _recordUnevaluable(
    frame: HandlerErrorFrame | null,
    key: string,
    message: string,
  ): void {
    if (frame !== null) {
      if (!frame.errors.has(key)) frame.errors.set(key, message);
      frame.pending.push(key);
    }
    console.warn(
      `[apcore:acl] ${message} — the condition is UNEVALUABLE, not false ` +
        '(PROTOCOL_SPEC §6.1.1: a deny rule takes effect, an allow rule does not grant)',
    );
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
    value: unknown,
    context: Context,
    frame: HandlerErrorFrame | null,
  ): ConditionOutcome {
    const handler = ACL.conditionHandlers.get(key);
    if (handler === undefined) {
      ACL._recordUnevaluable(frame, key, `Unknown ACL condition '${key}'`);
      return 'unevaluable';
    }
    try {
      const result = isOutcomeHandler(handler)
        ? handler.evaluateOutcome(value, context)
        : handler.evaluate(value, context);
      if (result instanceof Promise) {
        // apcore-typescript cannot inspect a Promise synchronously, so an
        // async handler reached from check() yields no answer at all.
        ACL._recordUnevaluable(
          frame,
          key,
          `Async condition '${key}' in sync context — use asyncCheck()`,
        );
        return 'unevaluable';
      }
      if (typeof result === 'boolean') return result ? 'satisfied' : 'unsatisfied';
      return result;
    } catch (e) {
      ACL._recordUnevaluable(
        frame,
        key,
        `Handler for condition '${key}' threw: ${e instanceof Error ? e.message : String(e)}`,
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
  ): ConditionOutcome {
    // Bind the frame at entry so writes land on this evaluation's slot even if
    // another evaluation becomes current in the meantime.
    const frame = ACL._currentFrame;
    // Fail closed on a malformed `conditions`. `_parseAclRule` rejects these at load
    // time, but rules built programmatically (`new ACL([...])`, `addRule()`) skip the
    // parser entirely, and a scalar here would make `Object.entries()` return `[]` —
    // satisfying the AND-loop vacuously and turning an `allow` rule unconditional.
    if (!isConditionsObject(conditions)) {
      ACL._recordUnevaluable(
        frame,
        MALFORMED_CONDITIONS_KEY,
        `ACL conditions must be a mapping, got ${aclTypeName(conditions)}`,
      );
      return 'unevaluable';
    }
    let sawUnevaluable = false;
    for (const [key, value] of Object.entries(conditions)) {
      const outcome = ACL._evaluateConditionSync(key, value, context, frame);
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
  ): Promise<ConditionOutcome> {
    // Bind the frame at entry — after an `await` the static may point at
    // another in-flight evaluation's frame.
    const frame = ACL._currentFrame;
    // Same fail-closed guard as the sync path — see _evaluateConditions.
    if (!isConditionsObject(conditions)) {
      ACL._recordUnevaluable(
        frame,
        MALFORMED_CONDITIONS_KEY,
        `ACL conditions must be a mapping, got ${aclTypeName(conditions)}`,
      );
      return 'unevaluable';
    }
    let sawUnevaluable = false;
    for (const [key, value] of Object.entries(conditions)) {
      // §6.1.3: the async registry is consulted first, then the sync one.
      const handler = ACL.asyncConditionHandlers.get(key) ?? ACL.conditionHandlers.get(key);
      if (handler === undefined) {
        ACL._recordUnevaluable(frame, key, `Unknown ACL condition '${key}'`);
        sawUnevaluable = true;
        continue;
      }
      let outcome: ConditionOutcome;
      try {
        const result = isOutcomeHandler(handler)
          ? await handler.evaluateOutcome(value, context)
          : await handler.evaluate(value, context);
        outcome = typeof result === 'boolean' ? (result ? 'satisfied' : 'unsatisfied') : result;
      } catch (e) {
        ACL._recordUnevaluable(
          frame,
          key,
          `Handler for condition '${key}' threw: ${e instanceof Error ? e.message : String(e)}`,
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
    // §6.1.2: direct construction is an entry point that accepts rules, so it
    // is covered by load-time validation too — `ACL.load()` reaches this same
    // constructor, which is why the file path needs no separate hook.
    this._warnUnresolvableConditionKeys();
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
   * Report every rule that references a condition key which does not resolve
   * on the **sync** path (PROTOCOL_SPEC §6.1.2 rule 3, §6.1.3).
   *
   * Condition handlers are registered at runtime into a process-wide registry
   * and `acl.root` discovery commonly runs during bootstrap, ahead of the
   * application code that registers them — so loading warns rather than
   * throwing, and this is the deterministic check to run once registration is
   * complete. A pure read: it mutates nothing and registers nothing.
   *
   * A finding is emitted whenever `syncRegistered` is false, **including**
   * when `asyncRegistered` is true: an application calling `check()` then has
   * a condition it cannot evaluate. A caller that only ever uses
   * `asyncCheck()` may ignore such a finding — that judgement belongs to the
   * caller, not to the validator.
   *
   * Findings are ordered by rule index, then lexicographically by condition
   * key, so the collection is comparable across SDKs and across runs.
   */
  validateConditions(): readonly ConditionValidationFinding[] {
    const findings: ConditionValidationFinding[] = [];
    const rules = this._rules.slice();
    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
      const rule = rules[ruleIndex];
      for (const key of ACL._referencedConditionKeys(rule)) {
        if (ACL.conditionHandlers.has(key)) continue;
        findings.push(
          Object.freeze({
            ruleIndex,
            conditionKey: key,
            effect: rule.effect,
            syncRegistered: false,
            asyncRegistered: ACL.asyncConditionHandlers.has(key),
          }),
        );
      }
    }
    return Object.freeze(findings);
  }

  /**
   * @internal — the deduplicated, lexicographically ordered condition keys a
   * rule references, `$or` / `$not` nesting included.
   */
  private static _referencedConditionKeys(rule: ACLRule): string[] {
    if (rule.conditions == null) return [];
    const keys: string[] = [];
    collectConditionKeys(rule.conditions, keys);
    return [...new Set(keys)].sort();
  }

  /**
   * @internal — §6.1.2 rules 1-2 and 4: every entry point that accepts rules
   * warns, and none of them fails, for a condition key that does not resolve
   * on the sync path. The warning names the rule index, the key and the rule's
   * `effect`; the `effect` is in the message because a misconfigured `deny`
   * rule is the consequential case.
   *
   * @param onlyIndex - Validate a single rule index (used by `addRule`).
   */
  private _warnUnresolvableConditionKeys(onlyIndex?: number): void {
    const rules = this._rules;
    for (let i = 0; i < rules.length; i++) {
      if (onlyIndex !== undefined && i !== onlyIndex) continue;
      const rule = rules[i];
      for (const key of ACL._referencedConditionKeys(rule)) {
        if (ACL.conditionHandlers.has(key)) continue;
        const detail = ACL.asyncConditionHandlers.has(key)
          ? 'is registered only as an async handler, so it resolves under asyncCheck() but is UNEVALUABLE under check()'
          : 'has no registered handler';
        console.warn(
          `[apcore:acl] Rule ${i} (effect=${rule.effect}) references condition ` +
            `'${key}', which ${detail}. PROTOCOL_SPEC §6.1.1: an unevaluable condition ` +
            `makes a deny rule DENY and an allow rule not grant. Register a handler, or ` +
            `call acl.validateConditions() once bootstrap is complete.`,
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

  check(callerId: string | null, targetId: string, context?: Context | null): boolean {
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
    const [frame, previousFrame] = ACL._pushHandlerErrorFrame();

    try {
      for (let idx = 0; idx < rules.length; idx++) {
        const rule = rules[idx];
        frame.pending.length = 0;
        const outcome = this._matchesRule(rule, effectiveCaller, targetId, ctx, idx);
        if (outcome === 'unevaluable' && !ACL._resolveUnevaluable(rule, idx, frame)) continue;
        if (outcome === 'no_match') continue;
        const decision = rule.effect === 'allow';
        if (auditLogger) {
          auditLogger(this._buildAuditEntry(
            effectiveCaller, targetId, decision ? 'allow' : 'deny',
            'rule_match', rule, idx, ctx, ACL._takeFrameError(frame),
          ));
        }
        return decision;
      }

      const defaultDecision = defaultEffect === 'allow';
      if (auditLogger) {
        const reason = rules.length === 0 ? 'no_rules' : 'default_effect';
        auditLogger(this._buildAuditEntry(
          effectiveCaller, targetId, defaultDecision ? 'allow' : 'deny',
          reason, null, null, ctx, ACL._takeFrameError(frame),
        ));
      }
      return defaultDecision;
    } finally {
      ACL._popHandlerErrorFrame(previousFrame);
    }
  }

  async asyncCheck(callerId: string | null, targetId: string, context?: Context | null): Promise<boolean> {
    const effectiveCaller = callerId === null ? '@external' : callerId;
    const ctx = context ?? null;
    // Snapshot mutable fields before any await to prevent async-gap races
    // (e.g. a concurrent setDefaultEffect() or addRule() call mid-evaluation).
    const rules = this._rules.slice();
    const defaultEffect = this._defaultEffect;
    const auditLogger = this._auditLogger;
    // Open a capture frame private to this evaluation (see check()).
    const [frame, previousFrame] = ACL._pushHandlerErrorFrame();

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
        const decision = rule.effect === 'allow';
        if (auditLogger) {
          auditLogger(this._buildAuditEntry(
            effectiveCaller, targetId, decision ? 'allow' : 'deny',
            'rule_match', rule, idx, ctx, ACL._takeFrameError(frame),
          ));
        }
        return decision;
      }

      const defaultDecision = defaultEffect === 'allow';
      if (auditLogger) {
        const reason = rules.length === 0 ? 'no_rules' : 'default_effect';
        auditLogger(this._buildAuditEntry(
          effectiveCaller, targetId, defaultDecision ? 'allow' : 'deny',
          reason, null, null, ctx, ACL._takeFrameError(frame),
        ));
      }
      return defaultDecision;
    } finally {
      ACL._popHandlerErrorFrame(previousFrame);
    }
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
    if (!this._matchPatternsAsync(rule.callers, caller, context)) return 'no_match';
    if (!this._matchPatternsAsync(rule.targets, target, context)) return 'no_match';

    if (rule.conditions != null) {
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

  private _matchesRule(
    rule: ACLRule,
    caller: string,
    target: string,
    context: Context | null,
    ruleIndex: number,
  ): RuleOutcome {
    if (!this._matchPatterns(rule.callers, caller, context)) return 'no_match';
    if (!this._matchPatterns(rule.targets, target, context)) return 'no_match';

    if (rule.conditions != null) {
      if (context === null) {
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
    frame: HandlerErrorFrame,
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
    this._rules.unshift(rule);
    // Rule indices shifted by one; drop the per-index dedupe so a §6.5 warning
    // is not suppressed for a different rule that inherited an old index.
    this._warnedMissingContext.clear();
    this._warnUnresolvableConditionKeys(0);
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
ACL.registerCondition('$or', new OrHandler(ACL._evaluateConditions.bind(ACL)));
ACL.registerCondition('$not', new NotHandler(ACL._evaluateConditions.bind(ACL)));
// Async-aware variants used by asyncCheck() so Promise-returning conditions
// inside $or/$not are awaited rather than dropped via fail-closed.
ACL.registerAsyncCondition('$or', new OrHandlerAsync(ACL._evaluateConditionsAsync.bind(ACL)));
ACL.registerAsyncCondition('$not', new NotHandlerAsync(ACL._evaluateConditionsAsync.bind(ACL)));
