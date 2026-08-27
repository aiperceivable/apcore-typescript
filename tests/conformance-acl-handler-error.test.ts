/**
 * Cross-language conformance driver for acl_handler_error.json
 * (A-D-011 fail-closed / A-D-012 handler_error surfaced in audit).
 *
 * Fixture source: apcore/conformance/fixtures/acl_handler_error.json
 * (single source of truth). See that fixture's `description` for the driver
 * contract.
 *
 * SECURITY: a condition that cannot be EVALUATED is not a condition that is
 * FALSE, and the rule's `effect` decides what the difference means
 * (PROTOCOL_SPEC §6.1.1, spec v1.22.0, apcore#100). An unevaluable condition
 * resolves the rule toward refusing access: a `deny` rule takes effect and the
 * call is DENIED, an `allow` rule does not match and MUST NOT grant. The
 * emitted AuditEntry MUST carry a non-null handlerError in both directions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ACL, ACLRule, AuditEntry } from '../src/acl.js';
import { Context } from '../src/context.js';
import type { ACLConditionHandler } from '../src/acl-handlers.js';
import { findFixturesRoot } from './spec-repo.js';

const FIXTURES_ROOT = findFixturesRoot();

function loadFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, `${name}.json`), 'utf-8'));
}

/**
 * Fixture cases superseded by spec v1.22.0 §6.1.1, keyed by case id.
 *
 * `conformance/fixtures/acl_handler_error.json` still pins the pre-v1.22.0
 * decision for one case: a `deny` rule whose condition handler throws was
 * expected to let the call through to `default_effect: allow`, which is
 * exactly the fail-open §6.1.1 was written to close. The corrected fixture is
 * staged in the spec repo at
 * `planning/acl-unevaluable-conditions/staged-fixtures/acl_handler_error.json`
 * and lands in `conformance/fixtures/` only once all three SDK drivers do, so
 * that CI does not go red across every SDK repository for the duration of the
 * rollout.
 *
 * Until then this driver asserts the spec-v1.22.0 outcome for that one case
 * and says so. The entry is keyed by the OLD case id, which the corrected
 * fixture drops entirely (it is replaced by `throwing_handler_on_deny_rule_denies`),
 * so this table goes inert by itself the moment the new fixture lands.
 *
 * DO NOT "fix" a failure here by weakening the implementation: the fixture is
 * wrong relative to v1.22.0, not the other way round.
 */
const SUPERSEDED_BY_SPEC_V1_22_0: Record<string, { expected: boolean; reason: string }> = {
  throwing_handler_does_not_flip_default_allow_to_deny_unsafely: {
    expected: false,
    reason:
      'PROTOCOL_SPEC §6.1.1: a deny rule whose condition is unevaluable MUST take effect. ' +
      'The fixture still expects the pre-v1.22.0 fall-through to default_effect: allow.',
  },
};

describe('Conformance: ACL unevaluable condition handler (§6.1.1 / A-D-011 / A-D-012)', () => {
  const fixture = loadFixture('acl_handler_error');
  const throwingKey: string = fixture.throwing_condition_key;
  // Present only in the corrected fixture; absent from the one on disk today.
  const unknownKey: string | undefined = fixture.unknown_condition_key;

  // Register a built-in test condition handler whose evaluate() throws, so the
  // ACL exercises its handler-error path. ACL keeps handlers in a static
  // registry; remove the registered key after each case to avoid leakage.
  const throwingHandler: ACLConditionHandler = {
    evaluate(): boolean {
      throw new Error('intentional throwing condition handler');
    },
  };

  afterEach(() => {
    // ACL has no public deregister API; overwrite the static map entry by
    // re-registering a benign handler is not equivalent, so delete via the
    // internal map. The conformance contract only requires the throwing key
    // not to leak into other suites — registering a fresh throwing handler per
    // run is idempotent, and the suppress-warning console output is expected.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ACL as any).conditionHandlers?.delete(throwingKey);
  });

  fixture.test_cases.forEach((tc: any) => {
    it(tc.id, () => {
      ACL.registerCondition(throwingKey, throwingHandler);
      // The fixture's unknown key must stay unregistered — that is the whole
      // point of the case. Assert it rather than trusting suite ordering.
      if (unknownKey !== undefined) {
        expect((ACL as any).conditionHandlers.has(unknownKey)).toBe(false);
      }

      const rules: ACLRule[] = (tc.rules as any[]).map((r) => ({
        callers: r.callers,
        targets: r.targets,
        effect: r.effect,
        description: r.description ?? '',
        conditions: r.conditions ?? null,
      }));

      const captured: AuditEntry[] = [];
      const acl = new ACL(rules, tc.default_effect, (entry) => captured.push(entry));

      // A condition-bearing rule requires a Context to be evaluated.
      const ctx = new Context('trace-id', tc.caller_id, [], null, null);
      const decision = acl.check(tc.caller_id, tc.target_id, ctx);

      const superseded = SUPERSEDED_BY_SPEC_V1_22_0[tc.id as string];
      expect(decision, superseded?.reason).toBe(superseded ? superseded.expected : tc.expected);

      if (tc.expected_audit_handler_error_present) {
        expect(captured.length).toBeGreaterThan(0);
        const last = captured[captured.length - 1];
        expect(last.handlerError).not.toBeNull();
      }
    });
  });
});
