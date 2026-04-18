/**
 * ACL (Access Control List) types and implementation for apcore.
 */

import yaml from 'js-yaml';
import type { Context } from './context.js';
import { ACLRuleError, ConfigNotFoundError } from './errors.js';
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

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
try { _nodeFs = await import('node:fs'); } catch { /* browser environment */ }

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
}

export type AuditLogger = (entry: AuditEntry) => void;

function parseAclRule(rawRule: unknown, index: number): ACLRule {
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

  return {
    callers: callers as string[],
    targets: targets as string[],
    effect,
    description: (ruleObj['description'] as string) ?? '',
    conditions: (ruleObj['conditions'] as Record<string, unknown>) ?? null,
  };
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

  static _evaluateConditions(conditions: Record<string, unknown>, context: Context): boolean {
    for (const [key, value] of Object.entries(conditions)) {
      const handler = ACL.conditionHandlers.get(key);
      if (handler === undefined) {
        console.warn(`[apcore:acl] Unknown ACL condition '${key}' — treated as unsatisfied`);
        return false;
      }
      try {
        const result = handler.evaluate(value, context);
        if (result instanceof Promise) {
          // Async handler in sync context — fail-closed
          console.warn(
            `[apcore:acl] Async condition '${key}' in sync context — treated as unsatisfied. Use asyncCheck().`,
          );
          return false;
        }
        if (!result) return false;
      } catch {
        console.warn(`[apcore:acl] Handler for condition '${key}' threw — treated as unsatisfied`);
        return false;
      }
    }
    return true;
  }

  static async _evaluateConditionsAsync(conditions: Record<string, unknown>, context: Context): Promise<boolean> {
    for (const [key, value] of Object.entries(conditions)) {
      const handler = ACL.asyncConditionHandlers.get(key) ?? ACL.conditionHandlers.get(key);
      if (handler === undefined) {
        console.warn(`[apcore:acl] Unknown ACL condition '${key}' — treated as unsatisfied`);
        return false;
      }
      try {
        const result = await handler.evaluate(value, context);
        if (!result) return false;
      } catch {
        console.warn(`[apcore:acl] Handler for condition '${key}' threw — treated as unsatisfied`);
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
    const { existsSync, readFileSync } = _nodeFs!;
    if (!existsSync(yamlPath)) {
      throw new ConfigNotFoundError(yamlPath);
    }

    let data: unknown;
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      data = yaml.load(content);
    } catch (e) {
      if (e instanceof ConfigNotFoundError) throw e;
      throw new ACLRuleError(`Invalid YAML in ${yamlPath}: ${e}`);
    }

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new ACLRuleError(`ACL config must be a mapping, got ${typeof data}`);
    }

    const dataObj = data as Record<string, unknown>;
    if (!('rules' in dataObj)) {
      throw new ACLRuleError("ACL config missing required 'rules' key");
    }

    const rawRules = dataObj['rules'];
    if (!Array.isArray(rawRules)) {
      throw new ACLRuleError(`'rules' must be a list, got ${typeof rawRules}`);
    }

    const defaultEffect = (dataObj['default_effect'] as string) ?? 'deny';
    const rules = rawRules.map((raw, i) => parseAclRule(raw, i));

    const acl = new ACL(rules, defaultEffect);
    acl._yamlPath = yamlPath;
    return acl;
  }

  check(callerId: string | null, targetId: string, context?: Context | null): boolean {
    const effectiveCaller = callerId === null ? '@external' : callerId;
    const ctx = context ?? null;

    for (let idx = 0; idx < this._rules.length; idx++) {
      const rule = this._rules[idx];
      if (this._matchesRule(rule, effectiveCaller, targetId, ctx)) {
        const decision = rule.effect === 'allow';
        if (this._auditLogger) {
          this._auditLogger(this._buildAuditEntry(
            effectiveCaller, targetId, decision ? 'allow' : 'deny',
            'rule_match', rule, idx, ctx,
          ));
        }
        return decision;
      }
    }

    const defaultDecision = this._defaultEffect === 'allow';
    if (this._auditLogger) {
      const reason = this._rules.length === 0 ? 'no_rules' : 'default_effect';
      this._auditLogger(this._buildAuditEntry(
        effectiveCaller, targetId, defaultDecision ? 'allow' : 'deny',
        reason, null, null, ctx,
      ));
    }
    return defaultDecision;
  }

  async asyncCheck(callerId: string | null, targetId: string, context?: Context | null): Promise<boolean> {
    const effectiveCaller = callerId === null ? '@external' : callerId;
    const ctx = context ?? null;

    for (let idx = 0; idx < this._rules.length; idx++) {
      const rule = this._rules[idx];
      if (await this._matchesRuleAsync(rule, effectiveCaller, targetId, ctx)) {
        const decision = rule.effect === 'allow';
        if (this._auditLogger) {
          this._auditLogger(this._buildAuditEntry(
            effectiveCaller, targetId, decision ? 'allow' : 'deny',
            'rule_match', rule, idx, ctx,
          ));
        }
        return decision;
      }
    }

    const defaultDecision = this._defaultEffect === 'allow';
    if (this._auditLogger) {
      const reason = this._rules.length === 0 ? 'no_rules' : 'default_effect';
      this._auditLogger(this._buildAuditEntry(
        effectiveCaller, targetId, defaultDecision ? 'allow' : 'deny',
        reason, null, null, ctx,
      ));
    }
    return defaultDecision;
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
      if (conditions !== undefined && !deepEqual(rule.conditions ?? null, conditions ?? null)) continue;
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
