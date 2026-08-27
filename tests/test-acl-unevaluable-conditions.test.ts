/**
 * PROTOCOL_SPEC §6.1.1 / §6.1.2 / §6.1.3 / §6.3 / §6.8 and §7.9.6 —
 * spec v1.22.0 (apcore#100), v1.23.0 (apcore#101), v1.24.0 (apcore#102).
 *
 * The defect #100 was opened for: condition evaluation returned a plain
 * boolean, so "a handler answered no" and "no answer was obtainable" reached
 * the rule loop identically and both meant *this rule does not match*. That is
 * safe in one direction only — an `allow` rule that cannot evaluate its
 * condition does not grant, but a `deny` rule that cannot evaluate its
 * condition does not block. A single misspelled key turned a rule its author
 * believed was blocking into decoration.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACL } from '../src/acl.js';
import type { ACLRule, AuditEntry, ConditionValidationFinding } from '../src/acl.js';
import type { ACLConditionHandler } from '../src/acl-handlers.js';
import { Context, Identity } from '../src/context.js';
import { ExecutionPolicy, PolicyRule } from '../src/policy.js';
import type { PolicyCallSite, PolicyDecision } from '../src/policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keys registered by a test; torn down in afterEach so nothing leaks. */
const registered = new Set<string>();
const registeredAsync = new Set<string>();

function registerSync(key: string, handler: ACLConditionHandler): void {
  registered.add(key);
  ACL.registerCondition(key, handler);
}

function registerAsync(key: string, handler: ACLConditionHandler): void {
  registeredAsync.add(key);
  ACL.registerAsyncCondition(key, handler);
}

afterEach(() => {
  for (const key of registered) (ACL as any).conditionHandlers.delete(key);
  for (const key of registeredAsync) (ACL as any).asyncConditionHandlers.delete(key);
  registered.clear();
  registeredAsync.clear();
});

/** Silence the (normative, and deliberately loud) §6.1.1/§6.1.2 warnings. */
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

function ctxWith(roles: string[] = []): Context {
  return new Context('trace-unevaluable', 'caller.a', [], null, new Identity('u1', 'user', roles));
}

function rule(effect: string, conditions: Record<string, unknown> | null): ACLRule {
  return { callers: ['*'], targets: ['*'], effect, description: `${effect} rule`, conditions };
}

function checkWithAudit(
  rules: ACLRule[],
  defaultEffect: string,
  context: Context = ctxWith(),
): { decision: boolean; entry: AuditEntry } {
  const entries: AuditEntry[] = [];
  const acl = new ACL(rules, defaultEffect, (e) => entries.push(e));
  const decision = acl.check('caller.a', 'target.b', context);
  expect(entries).toHaveLength(1);
  return { decision, entry: entries[0] };
}

const THROWS: ACLConditionHandler = {
  evaluate(): boolean {
    throw new Error('handler exploded');
  },
};
const PROMISE_TRUE: ACLConditionHandler = {
  evaluate: () => Promise.resolve(true),
};

// ---------------------------------------------------------------------------
// §6.1.1 — the three situations that produce UNEVALUABLE
// ---------------------------------------------------------------------------

describe('§6.1.1: an unevaluable condition resolves toward refusing access', () => {
  // The three situations, crossed with the two effects. The `deny` + `allow`
  // default combination is the one that used to fail open.
  const situations: Array<[string, () => string]> = [
    [
      'unregistered condition key (the misspelled-key case)',
      () => 'definitely_not_registered_key',
    ],
    [
      'handler that throws',
      () => {
        registerSync('u_throwing', THROWS);
        return 'u_throwing';
      },
    ],
    [
      'async handler reached from the sync check() path',
      () => {
        registerSync('u_async_in_sync', PROMISE_TRUE);
        return 'u_async_in_sync';
      },
    ],
  ];

  for (const [label, setup] of situations) {
    it(`${label}: a deny rule MATCHES and denies (default_effect allow)`, () => {
      const key = setup();
      const { decision, entry } = checkWithAudit([rule('deny', { [key]: true })], 'allow');
      expect(decision).toBe(false);
      expect(entry.decision).toBe('deny');
      expect(entry.reason).toBe('rule_match');
      expect(entry.matchedRuleIndex).toBe(0);
      expect(entry.handlerError).toContain(key);
    });

    it(`${label}: an allow rule does NOT grant (default_effect deny)`, () => {
      const key = setup();
      const { decision, entry } = checkWithAudit([rule('allow', { [key]: true })], 'deny');
      expect(decision).toBe(false);
      expect(entry.reason).toBe('default_effect');
      expect(entry.matchedRuleIndex).toBeNull();
      expect(entry.handlerError).toContain(key);
    });
  }

  it('an ordinary FALSE condition still leaves the deny rule inert', () => {
    // The contrast case: a registered handler that answered "no" is a plain
    // non-match, and handler_error MUST stay null (§6.3.1).
    const { decision, entry } = checkWithAudit(
      [rule('deny', { roles: ['admin'] })],
      'allow',
      ctxWith(['viewer']),
    );
    expect(decision).toBe(true);
    expect(entry.reason).toBe('default_effect');
    expect(entry.handlerError).toBeNull();
  });

  it('never raises out of check()', () => {
    registerSync('u_throwing2', THROWS);
    const acl = new ACL([rule('allow', { u_throwing2: true })], 'deny');
    expect(() => acl.check('caller.a', 'target.b', ctxWith())).not.toThrow();
  });

  it('warns naming the condition key, the rule index and the rule effect', () => {
    warnSpy.mockRestore();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acl = new ACL([rule('allow', null), rule('deny', { missing_key_xyz: true })], 'allow');
    acl.check('caller.a', 'target.b', ctxWith());
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /Rule 1/.test(m) && /effect=deny/.test(m) && /missing_key_xyz/.test(m))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// §6.1.1 — three-valued composition through AND, $or and $not
// ---------------------------------------------------------------------------

describe('§6.1.1: three-valued composition', () => {
  const MISSING = 'compose_missing_key';

  it('AND: an outright UNSATISFIED wins over an unevaluable sibling', () => {
    // roles is evaluated first and answers "no", so the AND is UNSATISFIED and
    // the deny rule stays inert — decided by a real answer, not by a failure.
    const { decision, entry } = checkWithAudit(
      [rule('deny', { roles: ['admin'], [MISSING]: true })],
      'allow',
      ctxWith(['viewer']),
    );
    expect(decision).toBe(true);
    // A child skipped by a legitimate short-circuit was never evaluated, so it
    // is not unevaluable and MUST NOT set handler_error (§6.1.1 rule 2).
    expect(entry.handlerError).toBeNull();
  });

  it('AND: no UNSATISFIED child and one UNEVALUABLE child is UNEVALUABLE', () => {
    const { decision, entry } = checkWithAudit(
      [rule('deny', { roles: ['admin'], [MISSING]: true })],
      'allow',
      ctxWith(['admin']),
    );
    expect(decision).toBe(false);
    expect(entry.handlerError).toContain(MISSING);
  });

  it('$or: an outright SATISFIED wins over an unevaluable sibling', () => {
    const { decision } = checkWithAudit(
      [rule('allow', { $or: [{ [MISSING]: true }, { roles: ['admin'] }] })],
      'deny',
      ctxWith(['admin']),
    );
    expect(decision).toBe(true);
  });

  it('$or: no SATISFIED child and one UNEVALUABLE child is UNEVALUABLE', () => {
    const { decision, entry } = checkWithAudit(
      [rule('deny', { $or: [{ [MISSING]: true }, { roles: ['admin'] }] })],
      'allow',
      ctxWith(['viewer']),
    );
    expect(decision).toBe(false);
    expect(entry.handlerError).toContain(MISSING);
  });

  it('$or: every child UNSATISFIED is UNSATISFIED, not unevaluable', () => {
    const { decision, entry } = checkWithAudit(
      [rule('deny', { $or: [{ roles: ['admin'] }, { roles: ['finance'] }] })],
      'allow',
      ctxWith(['viewer']),
    );
    expect(decision).toBe(true);
    expect(entry.handlerError).toBeNull();
  });

  it('$not of an UNEVALUABLE child is UNEVALUABLE, never SATISFIED', () => {
    // The bypass this rule closes: negating "no answer" into "yes" would let a
    // misspelled key inside a $not satisfy the rule it was meant to gate.
    const denied = checkWithAudit([rule('deny', { $not: { [MISSING]: true } })], 'allow');
    expect(denied.decision).toBe(false);
    expect(denied.entry.handlerError).toContain(MISSING);

    const notGranted = checkWithAudit([rule('allow', { $not: { [MISSING]: true } })], 'deny');
    expect(notGranted.decision).toBe(false);
    expect(notGranted.entry.handlerError).toContain(MISSING);
  });

  it('$not still negates the two decisive outcomes', () => {
    const satisfied = checkWithAudit(
      [rule('allow', { $not: { roles: ['admin'] } })],
      'deny',
      ctxWith(['viewer']),
    );
    expect(satisfied.decision).toBe(true);

    const unsatisfied = checkWithAudit(
      [rule('allow', { $not: { roles: ['admin'] } })],
      'deny',
      ctxWith(['admin']),
    );
    expect(unsatisfied.decision).toBe(false);
  });

  it('does not short-circuit AND on UNEVALUABLE — a later sibling can still decide', () => {
    let reached = false;
    registerSync('zz_after_missing', {
      evaluate: () => {
        reached = true;
        return false;
      },
    });
    const { decision, entry } = checkWithAudit(
      [rule('deny', { [MISSING]: true, zz_after_missing: true })],
      'allow',
    );
    expect(reached).toBe(true);
    // The later sibling answered an outright "no", which wins the AND.
    expect(decision).toBe(true);
    // ...but the key that WAS reached and was unevaluable still has to surface.
    expect(entry.handlerError).toContain(MISSING);
  });
});

// ---------------------------------------------------------------------------
// §6.1.1 rule 2 — handler_error aggregation and ordering
// ---------------------------------------------------------------------------

describe('§6.1.1 rule 2: handler_error names every unevaluable condition', () => {
  it('orders multiple keys lexicographically, separated by "; "', () => {
    // Insertion order is deliberately the reverse of lexicographic order: a JS
    // object preserves insertion order while serde_json sorts, so "the first
    // one encountered" would put a different key in the audit log per SDK.
    const { entry } = checkWithAudit(
      [rule('allow', { zzz_missing: true, mmm_missing: true, aaa_missing: true })],
      'deny',
    );
    const parts = (entry.handlerError as string).split('; ');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('aaa_missing');
    expect(parts[1]).toContain('mmm_missing');
    expect(parts[2]).toContain('zzz_missing');
  });

  it('aggregates keys reached across several rules in one check()', () => {
    const { entry } = checkWithAudit(
      [rule('allow', { b_missing: true }), rule('allow', { a_missing: true })],
      'deny',
    );
    expect(entry.handlerError).toBe(
      "Unknown ACL condition 'a_missing'; Unknown ACL condition 'b_missing'",
    );
  });

  it('reports a key nested inside $or under its own name', () => {
    const { entry } = checkWithAudit(
      [rule('allow', { $or: [{ nested_missing_key: true }] })],
      'deny',
    );
    expect(entry.handlerError).toContain('nested_missing_key');
    expect(entry.handlerError).not.toContain("'$or'");
  });
});

// ---------------------------------------------------------------------------
// §6.1.3 — sync vs async registries
// ---------------------------------------------------------------------------

describe('§6.1.3: an async-only handler is a live rule on one path only', () => {
  const KEY = 'registry_async_only';

  beforeEach(() => {
    registerAsync(KEY, { evaluate: async () => true });
  });

  it('is UNEVALUABLE under check(), so a deny rule denies', () => {
    const { decision, entry } = checkWithAudit([rule('deny', { [KEY]: true })], 'allow');
    expect(decision).toBe(false);
    expect(entry.handlerError).toContain(KEY);
  });

  it('resolves under asyncCheck(), so the same rule follows the handler', async () => {
    const entries: AuditEntry[] = [];
    const acl = new ACL([rule('deny', { [KEY]: true })], 'allow', (e) => entries.push(e));
    expect(await acl.asyncCheck('caller.a', 'target.b', ctxWith())).toBe(false);
    expect(entries[0].handlerError).toBeNull();
  });

  it('asyncCheck() falls back to the sync registry for a sync-only key', async () => {
    const acl = new ACL([rule('allow', { roles: ['admin'] })], 'deny');
    expect(await acl.asyncCheck('caller.a', 'target.b', ctxWith(['admin']))).toBe(true);
  });

  it('a key on neither registry is UNEVALUABLE under asyncCheck() too', async () => {
    const entries: AuditEntry[] = [];
    const acl = new ACL([rule('deny', { nowhere_key: true })], 'allow', (e) => entries.push(e));
    expect(await acl.asyncCheck('caller.a', 'target.b', ctxWith())).toBe(false);
    expect(entries[0].handlerError).toContain('nowhere_key');
  });

  it('an async handler that throws is UNEVALUABLE under asyncCheck()', async () => {
    registerAsync('async_throwing', {
      evaluate: async () => {
        throw new Error('async boom');
      },
    });
    const entries: AuditEntry[] = [];
    const acl = new ACL([rule('deny', { async_throwing: true })], 'allow', (e) => entries.push(e));
    expect(await acl.asyncCheck('caller.a', 'target.b', ctxWith())).toBe(false);
    expect(entries[0].handlerError).toContain('async boom');
  });

  it('$not of an unevaluable child is UNEVALUABLE on the async path too', async () => {
    const entries: AuditEntry[] = [];
    const acl = new ACL(
      [rule('allow', { $not: { nowhere_key: true } })],
      'deny',
      (e) => entries.push(e),
    );
    expect(await acl.asyncCheck('caller.a', 'target.b', ctxWith())).toBe(false);
    expect(entries[0].handlerError).toContain('nowhere_key');
  });
});

// ---------------------------------------------------------------------------
// §6.1.2 — load-time validation warns and never throws
// ---------------------------------------------------------------------------

describe('§6.1.2: every entry point that accepts rules warns, none of them fails', () => {
  function messages(): string[] {
    return warnSpy.mock.calls.map((c) => String(c[0]));
  }

  it('the constructor warns, naming rule index, key and effect', () => {
    expect(() => new ACL([rule('allow', null), rule('deny', { typo_roles: true })], 'deny')).not.toThrow();
    expect(
      messages().some(
        (m) => m.includes('Rule 1') && m.includes('effect=deny') && m.includes('typo_roles'),
      ),
    ).toBe(true);
  });

  it('addRule() warns for the inserted rule at index 0', () => {
    const acl = new ACL([], 'deny');
    warnSpy.mockClear();
    expect(() => acl.addRule(rule('deny', { added_typo: true }))).not.toThrow();
    expect(
      messages().some(
        (m) => m.includes('Rule 0') && m.includes('effect=deny') && m.includes('added_typo'),
      ),
    ).toBe(true);
    expect(acl.rules).toHaveLength(1);
  });

  it('ACL.load() warns rather than failing on an unregistered key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-unevaluable-'));
    const file = join(dir, 'global_acl.yaml');
    writeFileSync(
      file,
      [
        'rules:',
        '  - callers: ["*"]',
        '    targets: ["*"]',
        '    effect: deny',
        '    conditions:',
        '      role: ["contractor"]',
        'default_effect: allow',
        '',
      ].join('\n'),
    );
    try {
      const acl = ACL.load(file);
      expect(
        messages().some(
          (m) => m.includes('Rule 0') && m.includes('effect=deny') && m.includes("'role'"),
        ),
      ).toBe(true);
      // ...and the misspelling can no longer let traffic through.
      expect(acl.check('caller.a', 'target.b', ctxWith())).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('warns for a key nested inside $or / $not', () => {
    new ACL([rule('deny', { $or: [{ nested_typo: true }], $not: { other_typo: true } })], 'deny');
    const all = messages().join('\n');
    expect(all).toContain('nested_typo');
    expect(all).toContain('other_typo');
  });

  it('says nothing about the built-ins', () => {
    warnSpy.mockClear();
    new ACL(
      [rule('allow', { identity_types: ['user'], roles: ['admin'], max_call_depth: 5 })],
      'deny',
    );
    expect(messages()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6.1.2 rule 3 / §6.1.3 — validateConditions()
// ---------------------------------------------------------------------------

describe('ACL.validateConditions()', () => {
  it('is empty when every referenced key resolves on the sync path', () => {
    const acl = new ACL([rule('allow', { roles: ['admin'], $not: { identity_types: ['bot'] } })], 'deny');
    expect(acl.validateConditions()).toEqual([]);
  });

  it('never reports a rule with no conditions', () => {
    const acl = new ACL([rule('allow', null), rule('deny', null)], 'deny');
    expect(acl.validateConditions()).toHaveLength(0);
  });

  it('reports rule index, key, effect and both registry flags', () => {
    const acl = new ACL([rule('allow', null), rule('deny', { typo_key: true })], 'deny');
    const findings = acl.validateConditions();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      ruleIndex: 1,
      conditionKey: 'typo_key',
      effect: 'deny',
      syncRegistered: false,
      asyncRegistered: false,
    } satisfies ConditionValidationFinding);
  });

  it('reports an async-only key with syncRegistered false and asyncRegistered TRUE', () => {
    // §6.1.3 rule 2: a finding is emitted whenever syncRegistered is false,
    // INCLUDING when asyncRegistered is true. Collapsing the two flags into one
    // boolean would hide that an application calling check() has a condition it
    // cannot evaluate.
    registerAsync('validate_async_only', { evaluate: async () => true });
    const acl = new ACL([rule('deny', { validate_async_only: true })], 'deny');
    const findings = acl.validateConditions();
    expect(findings).toHaveLength(1);
    expect(findings[0].syncRegistered).toBe(false);
    expect(findings[0].asyncRegistered).toBe(true);
  });

  it('does not report a key registered on both paths', () => {
    registerSync('validate_both', { evaluate: () => true });
    registerAsync('validate_both', { evaluate: async () => true });
    const acl = new ACL([rule('deny', { validate_both: true })], 'deny');
    expect(acl.validateConditions()).toHaveLength(0);
  });

  it('reports keys nested inside $or / $not', () => {
    const acl = new ACL(
      [rule('deny', { $or: [{ nested_a: true }, { roles: ['x'] }], $not: { nested_b: true } })],
      'deny',
    );
    expect(acl.validateConditions().map((f) => f.conditionKey)).toEqual(['nested_a', 'nested_b']);
  });

  it('orders findings by rule index, then lexicographically by key', () => {
    const acl = new ACL(
      [rule('deny', { z_one: true, a_one: true }), rule('allow', { m_two: true })],
      'deny',
    );
    expect(acl.validateConditions().map((f) => [f.ruleIndex, f.conditionKey])).toEqual([
      [0, 'a_one'],
      [0, 'z_one'],
      [1, 'm_two'],
    ]);
  });

  it('is a pure read: it mutates nothing and registers nothing', () => {
    const acl = new ACL([rule('deny', { pure_probe: true })], 'allow');
    const before = acl.rules;
    const entries: AuditEntry[] = [];
    const audited = new ACL([rule('deny', { pure_probe: true })], 'allow', (e) => entries.push(e));
    audited.validateConditions();
    expect(entries).toHaveLength(0);
    expect(acl.validateConditions()).toEqual(acl.validateConditions());
    expect(acl.rules).toEqual(before);
    expect((ACL as any).conditionHandlers.has('pure_probe')).toBe(false);
  });

  it('becomes empty once the missing handler is registered', () => {
    const acl = new ACL([rule('deny', { late_bound: true })], 'deny');
    expect(acl.validateConditions()).toHaveLength(1);
    registerSync('late_bound', { evaluate: () => true });
    expect(acl.validateConditions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6.8 — ACL introspection (apcore#101)
// ---------------------------------------------------------------------------

describe('§6.8: ACL introspection accessors', () => {
  it('exposes defaultEffect through a documented public path', () => {
    expect(new ACL([], 'allow').defaultEffect).toBe('allow');
    expect(new ACL([], 'deny').defaultEffect).toBe('deny');
    expect(new ACL([]).defaultEffect).toBe('deny');
  });

  it('exposes rules in definition order', () => {
    const rules = [rule('allow', null), rule('deny', null)];
    rules[0].description = 'first';
    rules[1].description = 'second';
    expect(new ACL(rules, 'deny').rules.map((r) => r.description)).toEqual(['first', 'second']);
  });

  it('does not hand out a mutable reference into the ACL\'s own list', () => {
    const acl = new ACL([rule('allow', null)], 'deny');
    const snapshot = acl.rules;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as ACLRule[]).push(rule('deny', null))).toThrow();
    // A snapshot taken earlier does not observe a later insertion either.
    acl.addRule(rule('deny', null));
    expect(snapshot).toHaveLength(1);
    expect(acl.rules).toHaveLength(2);
  });

  it('is a pure read: no audit entry is emitted', () => {
    const entries: AuditEntry[] = [];
    const acl = new ACL([rule('allow', null)], 'deny', (e) => entries.push(e));
    void acl.rules;
    void acl.defaultEffect;
    expect(entries).toHaveLength(0);
  });

  it('both accessors reflect a reload()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-introspect-'));
    const file = join(dir, 'global_acl.yaml');
    const write = (effect: string, defaultEffect: string): void =>
      writeFileSync(
        file,
        [
          'rules:',
          '  - callers: ["api.*"]',
          '    targets: ["executor.*"]',
          `    effect: ${effect}`,
          `default_effect: ${defaultEffect}`,
          '',
        ].join('\n'),
      );
    try {
      write('allow', 'deny');
      const acl = ACL.load(file);
      expect(acl.defaultEffect).toBe('deny');
      expect(acl.rules).toHaveLength(1);
      expect(acl.rules[0].effect).toBe('allow');

      write('deny', 'allow');
      acl.reload();
      expect(acl.defaultEffect).toBe('allow');
      expect(acl.rules[0].effect).toBe('deny');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §7.9.6 — call-site inputs to policy resolution (apcore#102)
// ---------------------------------------------------------------------------

describe('§7.9.6: policy resolution receives the call site', () => {
  const annotations = { requiresApproval: false, destructive: true };
  const policy = new ExecutionPolicy(
    [new PolicyRule('orders.*', { requiresApproval: true, reason: 'sign-off' })],
    { gateDestructive: true },
  );
  const callSite: PolicyCallSite = {
    arguments: { amount: 10_000 },
    context: new Context('trace-policy', 'api.orders'),
  };

  it('keeps existing two-argument callers compiling and behaving identically', () => {
    expect(policy.resolve('orders.delete', annotations)).toEqual(
      policy.resolve('orders.delete', annotations, null),
    );
  });

  it('produces a bit-for-bit identical verdict with and without the call site', () => {
    for (const moduleId of ['orders.delete', 'reports.render', 'orders.list']) {
      for (const annos of [annotations, { requiresApproval: true }, null]) {
        expect(policy.resolve(moduleId, annos, callSite)).toEqual(policy.resolve(moduleId, annos));
      }
    }
  });

  it('carries both halves of the call site through to a host-supplied policy', () => {
    // §7.9.6(3): the built-in rules MUST NOT consult the call site, but a
    // host-supplied policy may. Subclassing is how a host does that here.
    const seen: Array<PolicyCallSite | null> = [];
    class ArgumentAwarePolicy extends ExecutionPolicy {
      override resolve(
        moduleId: string,
        annos: unknown = null,
        site: PolicyCallSite | null = null,
      ): PolicyDecision {
        seen.push(site);
        const base = super.resolve(moduleId, annos, site);
        const amount = site?.arguments?.['amount'];
        if (typeof amount === 'number' && amount > 1_000) {
          return { ...base, requiresApproval: true, needsApproval: true };
        }
        return base;
      }
    }
    const hostPolicy = new ArgumentAwarePolicy();
    expect(hostPolicy.resolve('orders.refund', null, callSite).needsApproval).toBe(true);
    expect(hostPolicy.resolve('orders.refund', null, { arguments: { amount: 1 }, context: null })
      .needsApproval).toBe(false);
    expect(seen[0]?.context?.traceId).toBe('trace-policy');
  });
});

describe('§7.9.6: the approval gate passes the call site', () => {
  it('hands the gate\'s arguments and Context to resolve()', async () => {
    const captured: Array<PolicyCallSite | null> = [];
    class RecordingPolicy extends ExecutionPolicy {
      override resolve(
        moduleId: string,
        annos: unknown = null,
        site: PolicyCallSite | null = null,
      ): PolicyDecision {
        captured.push(site);
        return super.resolve(moduleId, annos, site);
      }
    }
    const { BuiltinApprovalGate } = await import('../src/builtin-steps.js');
    const gate = new BuiltinApprovalGate(null, new RecordingPolicy());
    const context = new Context('trace-gate', 'api.orders');
    await gate.execute({
      moduleId: 'orders.delete',
      inputs: { orderId: 'o-1' },
      context,
      module: { annotations: { requiresApproval: false, destructive: false } },
    } as never);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.arguments).toEqual({ orderId: 'o-1' });
    expect(captured[0]?.context).toBe(context);
  });
});
