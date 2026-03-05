/**
 * ACL (Access Control List) types and implementation for apcore.
 */

import yaml from 'js-yaml';
import type { Context } from './context.js';
import { ACLRuleError, ConfigNotFoundError } from './errors.js';
import { matchPattern } from './utils/pattern.js';

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

  private _matchesRule(rule: ACLRule, caller: string, target: string, context: Context | null): boolean {
    const callerMatch = rule.callers.some((p) => this._matchPattern(p, caller, context));
    if (!callerMatch) return false;

    const targetMatch = rule.targets.some((p) => this._matchPattern(p, target, context));
    if (!targetMatch) return false;

    if (rule.conditions != null) {
      if (!this._checkConditions(rule.conditions, context)) return false;
    }

    return true;
  }

  private _checkConditions(conditions: Record<string, unknown>, context: Context | null): boolean {
    if (context === null) return false;

    if ('identity_types' in conditions) {
      const types = conditions['identity_types'];
      if (!Array.isArray(types)) {
        console.warn('[apcore:acl] identity_types condition must be an array');
        return false;
      }
      if (context.identity === null || !types.includes(context.identity.type)) return false;
    }

    if ('roles' in conditions) {
      const roles = conditions['roles'];
      if (!Array.isArray(roles)) {
        console.warn('[apcore:acl] roles condition must be an array');
        return false;
      }
      if (context.identity === null) return false;
      const identityRoles = new Set(context.identity.roles);
      if (!roles.some((r: string) => identityRoles.has(r))) return false;
    }

    if ('max_call_depth' in conditions) {
      const maxDepth = conditions['max_call_depth'];
      if (typeof maxDepth !== 'number') {
        console.warn('[apcore:acl] max_call_depth condition must be a number');
        return false;
      }
      if (context.callChain.length > maxDepth) return false;
    }

    return true;
  }

  addRule(rule: ACLRule): void {
    this._rules.unshift(rule);
  }

  removeRule(callers: string[], targets: string[]): boolean {
    for (let i = 0; i < this._rules.length; i++) {
      const rule = this._rules[i];
      if (
        JSON.stringify(rule.callers) === JSON.stringify(callers) &&
        JSON.stringify(rule.targets) === JSON.stringify(targets)
      ) {
        this._rules.splice(i, 1);
        return true;
      }
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
