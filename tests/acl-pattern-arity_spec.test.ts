/**
 * A `callers` / `targets` pattern array's SHAPE is closed, at every entry point
 * — PROTOCOL_SPEC §6.2.1 with §6.1.4.1 and §6.1.1 (spec v1.31.0, apcore#112).
 *
 * The defect this pins: a pattern array with no operands made the rule inert.
 * `[]`, `['$or']` and `['$not']` can never match, all three SDKs returned
 * `false` from the matcher, and `validateRules()` reported nothing — so the
 * decision tracked `defaultEffect` exactly and the rule contributed nothing. On
 * an `allow` rule that is merely useless. On a `deny` rule under
 * `defaultEffect: 'allow'` it is a **fail-open**: the call the operator wrote
 * the rule to block is permitted, by a rule that loaded without error and a
 * validator that called it clean. It was reachable from a plain YAML file,
 * because `ACL.load` rejected an *omitted* `callers` / `targets` and permitted
 * an *empty* one.
 *
 * Two more shapes ride along, argued in the same section. `['$not', p1, p2, …]`
 * was implementation-defined — consult `p1`, drop the rest — which every SDK
 * did, so an `allow` rule excluding two targets GRANTED the second: a silent
 * privilege escalation from a form the specification blessed. And a pattern
 * array is FLAT — the operators do not nest and there is no precedence, unlike
 * the same tokens in `conditions` — so a reserved token outside index 0 is
 * neither a nested operator nor a usable pattern.
 *
 * Two tiers, and they are not the same mechanism. TIER 1 is structural and is
 * rejected at every door. TIER 2 is semantic — well-formed and still matching
 * nothing — and is a `validateRules()` finding that changes no decision.
 *
 * Deliberately fixture-independent: these run on a checkout with no apcore spec
 * repo beside it. The cross-language contract lives in
 * `conformance/fixtures/acl_pattern_arity.json`, which lands only once all
 * three SDKs have.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ACL } from '../src/acl.js';
import type { ACLApproval, ACLRule, AuditEntry } from '../src/acl.js';
import { ACLRuleError } from '../src/errors.js';
// Side-effect import installs the Node-side YAML loader onto ACL.load.
import '../src/acl-file.js';

interface RuleSpec {
  readonly callers: string[];
  readonly targets: string[];
  readonly effect: string;
  readonly description?: string;
  readonly approval?: ACLApproval;
}

function toRule(spec: RuleSpec): ACLRule {
  return {
    callers: [...spec.callers],
    targets: [...spec.targets],
    effect: spec.effect,
    description: spec.description ?? '',
    conditions: null,
    ...(spec.approval === undefined ? {} : { approval: spec.approval }),
  };
}

/**
 * Write the rule as an ACL file. YAML is a superset of JSON, so the rule is
 * emitted as a flow mapping — which keeps an empty array an empty array rather
 * than something a hand-written block style might round-trip differently.
 */
function writeAclFile(spec: RuleSpec, defaultEffect: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-arity-'));
  const file = path.join(dir, 'acl.yaml');
  const body =
    `default_effect: ${defaultEffect}\n` + `rules:\n  - ${JSON.stringify(toRule(spec))}\n`;
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

/**
 * §6.1.6 rule 3 — a shape legal through one entry point and illegal through
 * another IS the defect, so every case is offered at all three doors and there
 * is deliberately no per-door expectation.
 */
function expectRejectedAtEveryDoor(spec: RuleSpec, defaultEffect: string): void {
  expect(() => ACL.load(writeAclFile(spec, defaultEffect))).toThrow(ACLRuleError);
  expect(() => new ACL([toRule(spec)], defaultEffect)).toThrow(ACLRuleError);
  const acl = new ACL([], defaultEffect);
  expect(() => acl.addRule(toRule(spec))).toThrow(ACLRuleError);
  // A throw leaves the rule list untouched, so a caller that swallowed it
  // cannot end up enforcing the rule anyway.
  expect(acl.rules.length).toBe(0);
}

function expectAcceptedAtEveryDoor(spec: RuleSpec, defaultEffect: string): void {
  expect(ACL.load(writeAclFile(spec, defaultEffect)).rules.length).toBe(1);
  expect(new ACL([toRule(spec)], defaultEffect).rules.length).toBe(1);
  const acl = new ACL([], defaultEffect);
  acl.addRule(toRule(spec));
  expect(acl.rules.length).toBe(1);
}

/**
 * Each `"; "`-separated part of `handlerError` begins with its §6.1.4 path in
 * single quotes — the same reading `tests/conformance-acl-handler-error.test.ts`
 * uses.
 */
function handlerErrorPaths(message: string | null): string[] {
  if (message === null) return [];
  return message.split('; ').map((part) => {
    const match = /'([^']*)'/.exec(part);
    return match === null ? part : match[1];
  });
}

// ---------------------------------------------------------------------------
// TIER 1 — structural, rejected at every entry point
// ---------------------------------------------------------------------------

describe('§6.2.1 tier 1: a pattern array shape outside the closed set is rejected', () => {
  it('accepts the flat single-pattern form — the overwhelmingly common one', () => {
    expectAcceptedAtEveryDoor(
      { callers: ['api.*'], targets: ['executor.*'], effect: 'allow' },
      'deny',
    );
  });

  it('accepts the flat multi-pattern form, which is OR-ed implicitly', () => {
    expectAcceptedAtEveryDoor(
      { callers: ['api.*', 'worker.*'], targets: ['executor.*'], effect: 'allow' },
      'deny',
    );
  });

  it('accepts an explicit $or with two operands', () => {
    expectAcceptedAtEveryDoor(
      { callers: ['$or', 'admin', 'moderator'], targets: ['*'], effect: 'allow' },
      'deny',
    );
  });

  it('accepts a ONE-operand $or — the operator takes AT LEAST one, not at least two', () => {
    // The boundary. A one-operand `$or` is degenerate but meaningful, and an
    // implementation that rejects it has read the closure as `minItems: 2` on
    // the array rather than as an arity rule on the operator.
    expectAcceptedAtEveryDoor(
      { callers: ['$or', 'admin'], targets: ['*'], effect: 'allow' },
      'deny',
    );
  });

  it('accepts a one-operand $not — the only legal $not arity', () => {
    expectAcceptedAtEveryDoor(
      { callers: ['$not', 'banned.*'], targets: ['*'], effect: 'allow' },
      'deny',
    );
  });

  it('accepts a pattern that merely LOOKS like a token — detection is equality', () => {
    // `$orders.*` is an ordinary pattern beginning with the same character. An
    // implementation testing `p.startsWith('$')` passes every rejection case in
    // this file and fails here.
    expectAcceptedAtEveryDoor(
      { callers: ['api.*', '$orders.*'], targets: ['*'], effect: 'allow' },
      'deny',
    );
  });

  it('rejects an empty callers', () => {
    // `schemas/acl-config.schema.json` has always declared `minItems: 1` on
    // this field and nothing validated against it at load — #107 and #111's
    // shape exactly: the normative artefact said it, no door enforced it.
    expectRejectedAtEveryDoor({ callers: [], targets: ['*'], effect: 'allow' }, 'deny');
  });

  it('rejects an empty targets — both fields, never one inferred from the other', () => {
    expectRejectedAtEveryDoor({ callers: ['*'], targets: [], effect: 'allow' }, 'deny');
  });

  it('rejects a rule whose two pattern fields are both empty', () => {
    expectRejectedAtEveryDoor({ callers: [], targets: [], effect: 'allow' }, 'deny');
  });

  it('rejects #112 driving case: an empty targets on a deny rule under default allow', () => {
    // Written as YAML this loaded clean, `validateRules()` returned zero
    // findings, and the check returned ALLOW — the operator has a rule that
    // says "block everything dangerous" and a deployment that blocks nothing.
    expectRejectedAtEveryDoor(
      {
        callers: ['*'],
        targets: [],
        effect: 'deny',
        description: 'block everything dangerous',
      },
      'allow',
    );
  });

  it('rejects $or with no operands — a one-element array that passes minItems: 1', () => {
    expectRejectedAtEveryDoor({ callers: ['*'], targets: ['$or'], effect: 'deny' }, 'allow');
  });

  it('rejects $not with no operands, whose MUST "evaluate to false" is replaced', () => {
    // §6.2.1 through v1.30.0 called that "fail-closed". The parenthetical was
    // wrong: a `deny` rule that never matches refuses nothing, and under
    // `defaultEffect: 'allow'` the blocked call is permitted.
    expectRejectedAtEveryDoor({ callers: ['*'], targets: ['$not'], effect: 'deny' }, 'allow');
  });

  it('rejects a multi-operand $not on an allow rule — the escalation, at the door', () => {
    // §6.2.1 called this implementation-defined and every SDK consulted `p1`
    // and ignored the rest, so the form was uniform across implementations and
    // uniformly wider than written: the operator excluded two targets and the
    // second one was granted.
    expectRejectedAtEveryDoor(
      { callers: ['*'], targets: ['$not', 'secrets.a', 'secrets.b'], effect: 'allow' },
      'deny',
    );
  });

  it('rejects a multi-operand $not on a deny rule for the same reason, not by accident', () => {
    // Here the old reading was over-broad rather than escalating. It must fail
    // for the same reason rather than survive because this effect happens to
    // land on the safe side — right only until someone flips the effect.
    expectRejectedAtEveryDoor(
      { callers: ['*'], targets: ['$not', 'secrets.a', 'secrets.b'], effect: 'deny' },
      'deny',
    );
  });

  it('rejects the empty pattern string, which matches only a non-existent module ID', () => {
    expectRejectedAtEveryDoor({ callers: ['*'], targets: [''], effect: 'deny' }, 'allow');
  });

  it('rejects an empty pattern string as an OPERAND, not only as the whole array', () => {
    // An implementation that checks only `patterns[0]` passes the case above
    // and fails this one.
    expectRejectedAtEveryDoor({ callers: ['*'], targets: ['$or', ''], effect: 'deny' }, 'allow');
  });

  it('rejects a reserved token after an operator — a pattern array does not nest', () => {
    // An operator who learned the CONDITION grammar writes `['$or', '$not', 'a']`
    // expecting or-of-not and got neither: the `$not` was a literal pattern, so
    // the array matched `a` and also matched a module literally named `$not`,
    // which §6.2.1's own reserved-token clause forbids.
    expectRejectedAtEveryDoor(
      { callers: ['*'], targets: ['$or', '$not', 'a'], effect: 'allow' },
      'deny',
    );
  });

  it('rejects a reserved token inside a flat list', () => {
    // `['api.*', '$not', 'cli.*']` is not "api.* but not cli.*" — no such form
    // exists. Rejecting the token outside index 0 makes the reserved-token
    // MUST NOT hold by construction rather than by a check nothing performed.
    expectRejectedAtEveryDoor(
      { callers: ['*'], targets: ['api.*', '$not', 'cli.*'], effect: 'allow' },
      'deny',
    );
  });

  it('rejects a reserved token at index 1 of a flat callers list', () => {
    expectRejectedAtEveryDoor(
      { callers: ['api.*', '$or'], targets: ['*'], effect: 'allow' },
      'deny',
    );
  });

  // --- field parity -------------------------------------------------------
  // §6.2.1 constrains `callers` and `targets` identically, and an
  // implementation validating only `targets` passes almost every rejection
  // above. Every structural shape rejected on `targets` is rejected here on
  // `callers`; the rationale for each shape is on its `targets` twin.

  it('rejects $or with no operands in callers', () => {
    expectRejectedAtEveryDoor({ callers: ['$or'], targets: ['*'], effect: 'deny' }, 'allow');
  });

  it('rejects $not with no operands in callers', () => {
    expectRejectedAtEveryDoor({ callers: ['$not'], targets: ['*'], effect: 'deny' }, 'allow');
  });

  it('rejects a multi-operand $not in callers', () => {
    // On `callers` the pre-v1.31.0 reading granted every caller except
    // `admin.*`, so an allow rule written to exclude two caller families
    // excluded one.
    expectRejectedAtEveryDoor(
      { callers: ['$not', 'admin.*', 'ops.*'], targets: ['*'], effect: 'allow' },
      'deny',
    );
  });

  it('rejects an empty pattern string in callers', () => {
    expectRejectedAtEveryDoor({ callers: [''], targets: ['*'], effect: 'deny' }, 'allow');
  });

  it('rejects an empty pattern string under $or in callers', () => {
    // Not a duplicate of the case above: this one fails only if the
    // implementation scans the OPERANDS of a `$or` on the `callers` side.
    expectRejectedAtEveryDoor({ callers: ['$or', ''], targets: ['*'], effect: 'deny' }, 'allow');
  });

  it('rejects a reserved token after an operator in callers', () => {
    // Distinct from the index-1 case above, where index 0 is an ordinary
    // pattern: here index 0 is an OPERATOR, so an implementation that stops
    // checking positions once it has consumed a leading `$or` fails only here.
    expectRejectedAtEveryDoor(
      { callers: ['$or', '$not', 'admin'], targets: ['*'], effect: 'allow' },
      'deny',
    );
  });

  // --- message shape ------------------------------------------------------

  it('names the field and the rule index, and says which shape rule was broken', () => {
    expect(
      () => new ACL([toRule({ callers: ['*'], targets: [], effect: 'deny' })], 'allow'),
    ).toThrow(/Rule 0 'targets' has an illegal pattern-array shape/);
    expect(
      () =>
        new ACL(
          [
            toRule({ callers: ['*'], targets: ['*'], effect: 'allow' }),
            toRule({ callers: ['$not'], targets: ['*'], effect: 'deny' }),
          ],
          'allow',
        ),
    ).toThrow(/Rule 1 'callers' has an illegal pattern-array shape/);
  });

  it('reports the most basic fault first when a field breaks several clauses', () => {
    // Ordering is empty-array -> empty-element -> token position -> arity, so
    // the message names the fault an operator has to fix first.
    expect(
      () => new ACL([toRule({ callers: ['$not', '', '$or'], targets: ['*'], effect: 'deny' })]),
    ).toThrow(/element 1 is the empty string/);
  });

  it('leaves §6.1.4.1 to classify a field that is not a list of strings', () => {
    // The TYPE fault keeps precedence and is NOT a door rejection: an array
    // whose element 0 is not a string has no meaningful arity reading, and the
    // construction has always been unevaluable rather than rejected.
    const acl = new ACL(
      [
        {
          callers: 'admin.*' as never,
          targets: ['*'],
          effect: 'deny',
          description: '',
          conditions: null,
        },
      ],
      'allow',
    );
    expect(acl.check('caller.a', 'target.b')).toBe(false);
  });

  it('changes nothing for a policy that was already legal', () => {
    const acl = new ACL(
      [toRule({ callers: ['api.*'], targets: ['orders.*'], effect: 'allow' })],
      'deny',
    );
    expect(acl.check('api.gateway', 'orders.create')).toBe(true);
    expect(acl.check('api.gateway', 'billing.charge')).toBe(false);
    expect(acl.validateRules()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TIER 2 — semantic, reported by validateRules() and by nothing else
// ---------------------------------------------------------------------------

describe('§6.2.1 tier 2: a well-formed array that still matches nothing is REPORTED', () => {
  function findingsFor(spec: RuleSpec, defaultEffect = 'allow') {
    return new ACL([toRule(spec)], defaultEffect).validateRules();
  }

  it('loads $not of * at every door and reports it against the targets path', () => {
    // The case that proves the tiers are distinct: legal arity, exactly one
    // operand, and it matches NOTHING — the identical fail-open the arity
    // shapes produce. A driver that rejects it has collapsed the tiers.
    const spec: RuleSpec = { callers: ['*'], targets: ['$not', '*'], effect: 'deny' };
    expectAcceptedAtEveryDoor(spec, 'allow');
    const findings = findingsFor(spec);
    expect(findings.map((f) => f.conditionPath)).toEqual(['targets']);
    // §6.1.3 rule 3's keyless structural fault shape.
    expect(findings[0].conditionKey).toBeNull();
    expect(findings[0].syncResolvable).toBe(false);
    expect(findings[0].asyncResolvable).toBe(false);
    expect(findings[0].effect).toBe('deny');
  });

  it('reports $not of ** too — the criterion is "matches everything", not the literal *', () => {
    const spec: RuleSpec = { callers: ['*'], targets: ['$not', '**'], effect: 'deny' };
    expectAcceptedAtEveryDoor(spec, 'allow');
    expect(findingsFor(spec).map((f) => f.conditionPath)).toEqual(['targets']);
  });

  it('reports @external as a TARGET pattern, where no module ID can match it', () => {
    const spec: RuleSpec = { callers: ['*'], targets: ['@external'], effect: 'deny' };
    expectAcceptedAtEveryDoor(spec, 'allow');
    expect(findingsFor(spec).map((f) => f.conditionPath)).toEqual(['targets']);
  });

  it('does NOT report @external in callers — that is what the token is for', () => {
    const spec: RuleSpec = { callers: ['@external'], targets: ['*'], effect: 'deny' };
    expectAcceptedAtEveryDoor(spec, 'allow');
    // A finding that fired on both fields has read the rule as being about the
    // token rather than about the field.
    expect(findingsFor(spec)).toHaveLength(0);
  });

  it('does NOT report $not of a narrow pattern — negation is not "matches nothing"', () => {
    const spec: RuleSpec = { callers: ['*'], targets: ['$not', 'cli.*'], effect: 'deny' };
    expectAcceptedAtEveryDoor(spec, 'allow');
    expect(findingsFor(spec)).toHaveLength(0);
  });

  it('does NOT change any access decision', () => {
    // Reported, and inert BY DESIGN. The rule matches nothing, so `cli.rm`
    // falls through to `defaultEffect: 'allow'` exactly as it did before
    // v1.31.0. An implementation that denies here has made a well-formed rule
    // deny every call.
    const entries: AuditEntry[] = [];
    const acl = new ACL(
      [toRule({ callers: ['*'], targets: ['$not', '*'], effect: 'deny' })],
      'allow',
      (e) => entries.push(e),
    );
    expect(acl.check('api.gateway', 'cli.rm')).toBe(true);
    // Tier 2 never reaches `handler_error`: it is not a precheck fault.
    expect(entries[0].handlerError).toBeNull();
    expect(acl.validateRules()).toHaveLength(1);
  });

  it('does not change the async decision either', async () => {
    const acl = new ACL(
      [toRule({ callers: ['*'], targets: ['$not', '*'], effect: 'deny' })],
      'allow',
    );
    await expect(acl.asyncCheck('api.gateway', 'cli.rm')).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BACKSTOP — §6.1.4.1, for the one route no door covers
// ---------------------------------------------------------------------------

describe('§6.1.4.1 backstop: a shape assigned onto a constructed rule is UNEVALUABLE', () => {
  /**
   * Build the ACL with a WELL-FORMED rule, then assign the illegal value onto
   * the already-constructed rule. `ACLRule` is a plain interface with mutable
   * properties, so this bypasses every constructor — and unlike an unrecognised
   * `effect`, which is never read again once the doors are closed, a mutated
   * pattern array IS read: the matcher consults it on the next `check()`.
   */
  function mutated(
    spec: RuleSpec,
    defaultEffect: string,
    mutations: readonly { field: 'callers' | 'targets'; value: string[] }[],
  ) {
    const rule = toRule(spec);
    const entries: AuditEntry[] = [];
    const acl = new ACL([rule], defaultEffect, (e) => entries.push(e));
    for (const m of mutations) rule[m.field] = m.value;
    return { acl, rule, entries };
  }

  it('a mutated empty targets makes a deny rule DENY', () => {
    const { acl, entries } = mutated({ callers: ['*'], targets: ['*'], effect: 'deny' }, 'allow', [
      { field: 'targets', value: [] },
    ]);
    expect(acl.check('api.gateway', 'cli.rm')).toBe(false);
    expect(entries[0].handlerError).not.toBeNull();
    expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['targets']);
    expect(acl.validateRules().map((f) => f.conditionPath)).toEqual(['targets']);
    expect(acl.validateRules()[0].conditionKey).toBeNull();
    expect(acl.validateRules()[0].syncResolvable).toBe(false);
    expect(acl.validateRules()[0].asyncResolvable).toBe(false);
  });

  it('a mutated empty targets on an allow rule MUST NOT grant', () => {
    // The observable outcome is unchanged from v1.30.0 — an inert allow rule
    // also failed to grant — but the audit entry and the validator finding are
    // new, and they are what tells the operator the rule is broken rather than
    // merely unmatched.
    const { acl, entries } = mutated({ callers: ['*'], targets: ['*'], effect: 'allow' }, 'deny', [
      { field: 'targets', value: [] },
    ]);
    expect(acl.check('api.gateway', 'cli.rm')).toBe(false);
    expect(entries[0].handlerError).not.toBeNull();
    expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['targets']);
  });

  it('a mutated $or with no operands denies too — not only the empty array', () => {
    const { acl, entries } = mutated({ callers: ['*'], targets: ['*'], effect: 'deny' }, 'allow', [
      { field: 'targets', value: ['$or'] },
    ]);
    expect(acl.check('api.gateway', 'cli.rm')).toBe(false);
    expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['targets']);
  });

  it('a mutated $not with no operands on CALLERS denies — the fault is per field', () => {
    const { acl, entries } = mutated({ callers: ['*'], targets: ['*'], effect: 'deny' }, 'allow', [
      { field: 'callers', value: ['$not'] },
    ]);
    expect(acl.check('api.gateway', 'cli.rm')).toBe(false);
    expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['callers']);
    expect(acl.validateRules().map((f) => f.conditionPath)).toEqual(['callers']);
  });

  it('a mutated multi-operand $not on an allow rule MUST NOT grant the dropped operand', () => {
    // The regression guard for the escalation. Through v1.30.0 this returned
    // ALLOW for `secrets.b` — the second target the operator excluded —
    // because the matcher read `p1` and dropped the rest.
    const { acl, entries } = mutated({ callers: ['*'], targets: ['*'], effect: 'allow' }, 'deny', [
      { field: 'targets', value: ['$not', 'secrets.a', 'secrets.b'] },
    ]);
    expect(acl.check('api.gateway', 'secrets.b')).toBe(false);
    expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['targets']);
  });

  it('examines BOTH fields and reports both paths, lexicographically', () => {
    // §6.1.4 rule 3 — the precheck MUST NOT short-circuit.
    const { acl, entries } = mutated({ callers: ['*'], targets: ['*'], effect: 'deny' }, 'allow', [
      { field: 'callers', value: ['$not'] },
      { field: 'targets', value: [] },
    ]);
    expect(acl.check('api.gateway', 'cli.rm')).toBe(false);
    expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['callers', 'targets']);
    expect(acl.validateRules().map((f) => f.conditionPath)).toEqual(['callers', 'targets']);
  });

  it('raises the PENDING approval requirement — unknowable scope counts as scope', () => {
    // §6.1.1 rule 5. A rule unevaluable because its own pattern field is
    // malformed still raises its approval requirement, because its scope cannot
    // be read and so cannot be shown not to apply here. There is no
    // partially-readable tier: `targets: []` is legible as an empty scope in a
    // way `targets: 3` is not, and acting on that difference is the
    // per-implementation judgement call that produced three answers in #100.
    const { acl, entries } = mutated(
      { callers: ['*'], targets: ['*'], effect: 'allow', approval: 'required' },
      'allow',
      [{ field: 'targets', value: [] }],
    );
    const decision = acl.checkAccess('api.gateway', 'cli.rm');
    expect(decision.access).toBe('allow');
    expect(decision.approvalRequired).toBe(true);
    // The requirement composes onto the grant from `defaultEffect: 'allow'`,
    // so no rule matched — the combination §6.1.1 rule 5 names explicitly.
    expect(decision.matchedRuleIndex).toBeNull();
    expect(entries[0].handlerError).not.toBeNull();
    expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['targets']);
  });

  it('is unevaluable on the async path as well — the two matchers are separate code', () => {
    const { acl, entries } = mutated({ callers: ['*'], targets: ['*'], effect: 'deny' }, 'allow', [
      { field: 'targets', value: ['$not', 'a', 'b'] },
    ]);
    return expect(acl.asyncCheck('api.gateway', 'cli.rm'))
      .resolves.toBe(false)
      .then(() => {
        expect(handlerErrorPaths(entries[0].handlerError)).toEqual(['targets']);
      });
  });

  it('does not raise out of check() — a malformed scope is a decision, not an exception', () => {
    const { acl } = mutated({ callers: ['*'], targets: ['*'], effect: 'deny' }, 'allow', [
      { field: 'targets', value: ['$or'] },
    ]);
    expect(() => acl.check('api.gateway', 'cli.rm')).not.toThrow();
  });

  it('leaves an unmutated rule deciding normally, with no finding and no handler error', () => {
    // The control without which an implementation that reports every rule as
    // faulty passes every other case here.
    const { acl, entries } = mutated(
      { callers: ['*'], targets: ['cli.*'], effect: 'deny' },
      'allow',
      [],
    );
    expect(acl.check('api.gateway', 'cli.rm')).toBe(false);
    expect(entries[0].handlerError).toBeNull();
    expect(acl.validateRules()).toHaveLength(0);
  });
});
