/**
 * Cross-language driver for `acl_argument_scoped_approval.json`.
 *
 * PROTOCOL_SPEC §6.1.6 / §6.1.7 / §6.1.8 / §6.8.1 (spec v1.28.0, apcore#108).
 *
 * An ACL rule answers two independent questions — may this caller reach this
 * target at all, and must *this particular call* be put to a human first. The
 * orthogonal `approval` field carries the second, and the built-in
 * structure-only `arguments` condition decides whether a rule matches this call.
 *
 * The two cases worth reading before the rest are
 * `no_projection_must_not_grant_via_an_empty_stand_in` and
 * `no_projection_makes_a_deny_rule_take_effect`: they bracket the same
 * fail-open bug from both directions. Substituting an empty key set for an
 * absent projection makes `has_none_of` vacuously satisfied, so an `allow` rule
 * grants for a call whose arguments were never seen — and leaves `has_key`
 * unsatisfied, so a `deny` rule fails to take effect. Only the UNEVALUABLE
 * reading of §6.1.8 rule 1 refuses in both directions.
 *
 * This SDK carries the projection in `AccessCheckOptions` rather than on
 * `Context`. §6.1.8 rule 4 leaves that route idiomatic and unconstrained; what
 * it fixes is that the condition sees the projection and that a caller cannot
 * forge one.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ACL, type ACLRule, type AuditEntry } from '../src/acl.js';
import { buildGovernanceProjection } from '../src/acl-handlers.js';
import { ACLRuleError } from '../src/errors.js';
import { Context, Identity } from '../src/context.js';
import { findFixturesRoot } from './spec-repo.js';

const FIXTURE = 'acl_argument_scoped_approval.json';
const FIXTURE_PATH = path.join(findFixturesRoot(), FIXTURE);
const PRESENT = fs.existsSync(FIXTURE_PATH);

// The fixture lands in the spec repo one push after this driver, so that
// `check_driver_coverage.py --strict` has a driver to find for it. Until then
// the suite skips and names the unexercised fixture — "not verified", never
// "passed".
const describeIfPresent = PRESENT ? describe : describe.skip;

interface Case {
  id: string;
  note: string;
  default_effect: string;
  rules: Array<Record<string, unknown>>;
  caller_id: string;
  target_id: string;
  arguments: Record<string, unknown> | null;
  expected_access: 'allow' | 'deny';
  expected_approval_required: boolean;
  expected_legacy_check: boolean;
  expected_matched_rule_index: number | null;
  expected_audit_handler_error_present: boolean;
  expected_validation_finding_path: string | null;
}

const cases: Case[] = PRESENT
  ? (JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as { test_cases: Case[] }).test_cases
  : [];

function build(tc: Case): { acl: ACL; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const rules = tc.rules.map(
    (r) =>
      ({
        callers: r.callers as string[],
        targets: r.targets as string[],
        effect: r.effect as string,
        description: '',
        ...(r.conditions !== undefined ? { conditions: r.conditions as Record<string, unknown> } : {}),
        ...(r.approval !== undefined ? { approval: r.approval } : {}),
      }) as ACLRule,
  );
  return { acl: new ACL(rules, tc.default_effect, (e) => entries.push(e)), entries };
}

/**
 * `arguments: null` means NO PROJECTION AT ALL (§6.1.8 rule 1), which is a
 * different case from an empty one — so the option stays absent rather than
 * being set to a projection of `{}`.
 */
function options(tc: Case) {
  return tc.arguments === null ? undefined : { arguments: buildGovernanceProjection(tc.arguments) };
}

function context(_tc: Case): Context {
  return Context.create(new Identity('u', 'user', ['dev']));
}

describeIfPresent('Conformance: argument-scoped approval (§6.1.6/§6.1.7/§6.1.8, spec v1.28.0)', () => {
  for (const tc of cases) {
    it(tc.id, () => {
      const { acl, entries } = build(tc);

      const decision = acl.checkAccess(tc.caller_id, tc.target_id, context(tc), options(tc));
      expect(decision.access, tc.note).toBe(tc.expected_access);
      expect(decision.approvalRequired, tc.note).toBe(tc.expected_approval_required);
      expect(decision.matchedRuleIndex, tc.note).toBe(tc.expected_matched_rule_index);

      // §6.3.1: handlerError is non-null IF AND ONLY IF a condition was
      // unevaluable. Read before the legacy call below, which emits its own entry.
      expect(entries.length, `${tc.note}\n  checkAccess must emit exactly one audit entry`).toBe(1);
      const entry = entries[0];
      expect(entry.handlerError !== null, `${tc.note}\n  handlerError was ${entry.handlerError}`).toBe(
        tc.expected_audit_handler_error_present,
      );
      expect(entry.approvalRequired, tc.note).toBe(tc.expected_approval_required);

      // §6.8.1: the legacy boolean fails closed on an approval requirement.
      expect(acl.check(tc.caller_id, tc.target_id, context(tc), options(tc)), tc.note).toBe(
        tc.expected_legacy_check,
      );

      // §6.1.8 closing paragraph: the well-formedness cases are decidable with
      // no context and no handler, so validateRules() must surface them at
      // deploy time rather than at the first call that trips them.
      const findings = acl.validateRules();
      if (tc.expected_validation_finding_path !== null) {
        const at = findings.filter((f) => f.conditionPath === tc.expected_validation_finding_path);
        expect(
          at.length,
          `${tc.note}\n  no finding at '${tc.expected_validation_finding_path}': ${JSON.stringify(findings)}`,
        ).toBeGreaterThan(0);
        expect(at[0].syncResolvable, tc.note).toBe(false);
        expect(at[0].asyncResolvable, tc.note).toBe(false);
      } else {
        expect(findings, `${tc.note}\n  unexpected findings`).toEqual([]);
      }
    });
  }

  it('deny + approval: required is rejected at every entry point (§6.1.6 rule 3)', () => {
    expect(
      () =>
        new ACL([
          { callers: ['*'], targets: ['x.y'], effect: 'deny', description: '', approval: 'required' },
        ]),
    ).toThrow(ACLRuleError);
  });
});
