/**
 * ACL (Access Control List) types and implementation for apcore.
 */

import type { Context } from './context.js';
import { ACLRuleError } from './errors.js';
import { matchPattern } from './utils/pattern.js';
import type { ACLConditionHandler } from './acl-handlers.js';
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
  private static _currentFrame: { error: string | null } | null = null;

  /** @internal — open a capture frame; returns [frame, previousFrame]. */
  private static _pushHandlerErrorFrame(): [{ error: string | null }, { error: string | null } | null] {
    const previous = ACL._currentFrame;
    const frame = { error: null as string | null };
    ACL._currentFrame = frame;
    return [frame, previous];
  }

  /** @internal — restore the caller's capture frame. */
  private static _popHandlerErrorFrame(previous: { error: string | null } | null): void {
    ACL._currentFrame = previous;
  }

  /** @internal — read-and-clear this evaluation's captured handler error. */
  private static _takeFrameError(frame: { error: string | null }): string | null {
    const err = frame.error;
    frame.error = null;
    return err;
  }

  static _evaluateConditions(conditions: Record<string, unknown>, context: Context): boolean {
    // Bind the frame at entry so writes land on this evaluation's slot even if
    // another evaluation becomes current in the meantime.
    const frame = ACL._currentFrame;
    const record = (msg: string): void => {
      if (frame !== null) frame.error = msg;
    };
    // Fail closed on a malformed `conditions`. `_parseAclRule` rejects these at load
    // time, but rules built programmatically (`new ACL([...])`, `addRule()`) skip the
    // parser entirely, and a scalar here would make `Object.entries()` return `[]` —
    // satisfying the AND-loop vacuously and turning an `allow` rule unconditional.
    if (!isConditionsObject(conditions)) {
      const msg = `ACL conditions must be a mapping, got ${aclTypeName(conditions)}`;
      record(msg);
      console.warn(`[apcore:acl] ${msg} — treated as unsatisfied`);
      return false;
    }
    for (const [key, value] of Object.entries(conditions)) {
      const handler = ACL.conditionHandlers.get(key);
      if (handler === undefined) {
        const msg = `Unknown ACL condition '${key}'`;
        record(msg);
        console.warn(`[apcore:acl] ${msg} — treated as unsatisfied`);
        return false;
      }
      try {
        const result = handler.evaluate(value, context);
        if (result instanceof Promise) {
          // Async handler in sync context — fail-closed
          const msg = `Async condition '${key}' in sync context — use asyncCheck()`;
          record(msg);
          console.warn(`[apcore:acl] ${msg}`);
          return false;
        }
        if (!result) return false;
      } catch (e) {
        const msg = `Handler for condition '${key}' threw: ${e instanceof Error ? e.message : String(e)}`;
        record(msg);
        console.warn(`[apcore:acl] ${msg} — treated as unsatisfied`);
        return false;
      }
    }
    return true;
  }

  static async _evaluateConditionsAsync(conditions: Record<string, unknown>, context: Context): Promise<boolean> {
    // Bind the frame at entry — after an `await` the static may point at
    // another in-flight evaluation's frame.
    const frame = ACL._currentFrame;
    const record = (msg: string): void => {
      if (frame !== null) frame.error = msg;
    };
    // Same fail-closed guard as the sync path — see _evaluateConditions.
    if (!isConditionsObject(conditions)) {
      const msg = `ACL conditions must be a mapping, got ${aclTypeName(conditions)}`;
      record(msg);
      console.warn(`[apcore:acl] ${msg} — treated as unsatisfied`);
      return false;
    }
    for (const [key, value] of Object.entries(conditions)) {
      const handler = ACL.asyncConditionHandlers.get(key) ?? ACL.conditionHandlers.get(key);
      if (handler === undefined) {
        const msg = `Unknown ACL condition '${key}'`;
        record(msg);
        console.warn(`[apcore:acl] ${msg} — treated as unsatisfied`);
        return false;
      }
      try {
        const result = await handler.evaluate(value, context);
        if (!result) return false;
      } catch (e) {
        const msg = `Handler for condition '${key}' threw: ${e instanceof Error ? e.message : String(e)}`;
        record(msg);
        console.warn(`[apcore:acl] ${msg} — treated as unsatisfied`);
        return false;
      }
    }
    return true;
  }

  private _rules: ACLRule[];
  private _defaultEffect: string;
  private _yamlPath: string | null = null;
  private _auditLogger: AuditLogger | null = null;
  debug: boolean = false;

  constructor(rules: ACLRule[], defaultEffect: string = 'deny', auditLogger?: AuditLogger | null) {
    if (defaultEffect !== 'allow' && defaultEffect !== 'deny') {
      throw new ACLRuleError(`Invalid default_effect '${defaultEffect}', must be 'allow' or 'deny'`);
    }
    this._rules = [...rules];
    this._defaultEffect = defaultEffect;
    this._auditLogger = auditLogger ?? null;
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
        if (this._matchesRule(rule, effectiveCaller, targetId, ctx)) {
          const decision = rule.effect === 'allow';
          if (auditLogger) {
            auditLogger(this._buildAuditEntry(
              effectiveCaller, targetId, decision ? 'allow' : 'deny',
              'rule_match', rule, idx, ctx, ACL._takeFrameError(frame),
            ));
          }
          return decision;
        }
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
        if (await this._matchesRuleAsync(rule, effectiveCaller, targetId, ctx)) {
          const decision = rule.effect === 'allow';
          if (auditLogger) {
            auditLogger(this._buildAuditEntry(
              effectiveCaller, targetId, decision ? 'allow' : 'deny',
              'rule_match', rule, idx, ctx, ACL._takeFrameError(frame),
            ));
          }
          return decision;
        }
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

  private async _matchesRuleAsync(rule: ACLRule, caller: string, target: string, context: Context | null): Promise<boolean> {
    if (!this._matchPatternsAsync(rule.callers, caller, context)) return false;
    if (!this._matchPatternsAsync(rule.targets, target, context)) return false;

    if (rule.conditions != null) {
      if (context === null) return false;
      if (!await ACL._evaluateConditionsAsync(rule.conditions, context)) return false;
    }

    return true;
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

  private _matchesRule(rule: ACLRule, caller: string, target: string, context: Context | null): boolean {
    if (!this._matchPatterns(rule.callers, caller, context)) return false;
    if (!this._matchPatterns(rule.targets, target, context)) return false;

    if (rule.conditions != null) {
      if (!this._checkConditions(rule.conditions, context)) return false;
    }

    return true;
  }

  private _checkConditions(conditions: Record<string, unknown>, context: Context | null): boolean {
    if (context === null) return false;
    return ACL._evaluateConditions(conditions, context);
  }

  addRule(rule: ACLRule): void {
    this._rules.unshift(rule);
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
