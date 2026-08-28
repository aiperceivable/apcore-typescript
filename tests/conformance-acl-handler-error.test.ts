/**
 * Cross-language conformance driver for acl_handler_error.json
 * (PROTOCOL_SPEC §6.1.1 / §6.1.4 / §6.1.4.1 / §6.3.1; A-D-011 / A-D-012).
 *
 * Fixture source, in preference order:
 *   1. `<spec repo>/planning/acl-unevaluable-conditions/staged-fixtures/` —
 *      the spec-v1.25.0 fixture, staged there deliberately so that CI stays
 *      green in every SDK repository until all three drivers have landed.
 *   2. `<spec repo>/conformance/fixtures/` — the canonical location it moves
 *      to as the last step of the rollout.
 *
 * See the fixture's own `description` for the driver contract.
 *
 * SECURITY: a condition that cannot be EVALUATED is not a condition that is
 * FALSE, and the rule's `effect` decides what the difference means. An
 * unevaluable condition resolves the rule toward refusing access: a `deny`
 * rule takes effect and the call is DENIED, an `allow` rule does not match and
 * MUST NOT grant. The emitted AuditEntry carries a non-null handlerError in
 * both directions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ACL } from '../src/acl.js';
import type { ACLRule, AuditEntry } from '../src/acl.js';
import { Context } from '../src/context.js';
import type { ACLConditionHandler } from '../src/acl-handlers.js';
import { findFixturesRoot } from './spec-repo.js';

const FIXTURES_ROOT = findFixturesRoot();

/**
 * Resolve the fixture, preferring the staged spec-v1.25.0 copy.
 *
 * `findFixturesRoot()` returns `<repo>/conformance/fixtures`; the staged file
 * sits beside it under `planning/`, so walk up two levels to reach the repo
 * root. When the staged file is absent — a spec repo checked out before the
 * v1.25.0 work landed — fall back to the canonical fixture.
 */
function loadHandlerErrorFixture(): { data: any; staged: boolean } {
  const specRepoRoot = path.resolve(FIXTURES_ROOT, '..', '..');
  const staged = path.join(
    specRepoRoot,
    'planning',
    'acl-unevaluable-conditions',
    'staged-fixtures',
    'acl_handler_error.json',
  );
  if (fs.existsSync(staged)) {
    return { data: JSON.parse(fs.readFileSync(staged, 'utf-8')), staged: true };
  }
  return {
    data: JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, 'acl_handler_error.json'), 'utf-8')),
    staged: false,
  };
}

/**
 * Fixture cases superseded by spec v1.22.0 §6.1.1, keyed by case id.
 *
 * The canonical `conformance/fixtures/acl_handler_error.json` still pins the
 * pre-v1.22.0 decision for one case: a `deny` rule whose condition handler
 * throws was expected to let the call through to `default_effect: allow`,
 * which is exactly the fail-open §6.1.1 was written to close.
 *
 * This table applies only when the staged fixture is unavailable, and the
 * staged fixture drops the id entirely (it is replaced by
 * `throwing_handler_on_deny_rule_denies`), so the table goes inert by itself
 * the moment the corrected fixture lands in `conformance/fixtures/`.
 *
 * DO NOT "fix" a failure here by weakening the implementation: the old fixture
 * is wrong relative to v1.22.0, not the other way round.
 */
const SUPERSEDED_BY_SPEC_V1_22_0: Record<string, { expected: boolean; reason: string }> = {
  throwing_handler_does_not_flip_default_allow_to_deny_unsafely: {
    expected: false,
    reason:
      'PROTOCOL_SPEC §6.1.1: a deny rule whose condition is unevaluable MUST take effect. ' +
      'The pre-v1.25.0 fixture still expects the fall-through to default_effect: allow.',
  },
};

/**
 * Every §6.1.4 condition path named by a `handler_error`, in the order the
 * message lists them.
 *
 * Each `"; "`-separated part begins with the path in single quotes — "Unknown
 * ACL condition '$or[0].k'", "ACL rule field 'callers' must be…" — so the
 * first quoted token of each part is the path the fixture asserts on.
 */
function handlerErrorPaths(message: string): string[] {
  return message.split('; ').map((part) => {
    const match = /'([^']*)'/.exec(part);
    return match === null ? part : match[1];
  });
}

describe('Conformance: ACL unevaluable conditions (§6.1.1 / §6.1.4 / A-D-011 / A-D-012)', () => {
  const { data: fixture, staged } = loadHandlerErrorFixture();
  const throwingKey: string = fixture.throwing_condition_key;
  // Present only from spec v1.25.0 onward.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ACL as any).conditionHandlers?.delete(throwingKey);
  });

  it('reads the spec-v1.25.0 staged fixture', () => {
    // Not a silent fallback: if the staged file is missing, the suite below is
    // exercising the older, smaller fixture and this case says so out loud.
    expect(
      staged,
      'staged-fixtures/acl_handler_error.json not found in the spec repo — ' +
        'falling back to conformance/fixtures/, which predates spec v1.25.0',
    ).toBe(true);
  });

  fixture.test_cases.forEach((tc: any) => {
    it(tc.id, () => {
      ACL.registerCondition(throwingKey, throwingHandler);
      // The fixture's unknown key must stay unregistered — that is the whole
      // point of the case. Assert it rather than trusting suite ordering.
      if (unknownKey !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((ACL as any).conditionHandlers.has(unknownKey)).toBe(false);
      }

      // `callers_raw` / `targets_raw` carry a deliberately malformed value in
      // place of the pattern list (§6.1.4.1). TypeScript can represent both,
      // so `skip_if_unrepresentable` never applies here — unlike apcore-rust,
      // whose `Vec<String>` makes the value unconstructible.
      const rules: ACLRule[] = (tc.rules as any[]).map((r) => ({
        callers: ('callers_raw' in r ? r.callers_raw : r.callers) as string[],
        targets: ('targets_raw' in r ? r.targets_raw : r.targets) as string[],
        effect: r.effect,
        description: r.description ?? '',
        conditions: r.conditions ?? null,
      }));

      const captured: AuditEntry[] = [];
      const acl = new ACL(rules, tc.default_effect, (entry) => captured.push(entry));

      // §6.1.4: a context is supplied only when the case asks for one. The
      // no-context cases are what pin the precheck's ordering against §6.5.
      const withContext = tc.with_context !== false;
      const ctx = withContext ? new Context('trace-id', tc.caller_id, [], null, null) : null;

      let decision: boolean | undefined;
      // §6.1.1 rule 4 / Contract: ACL.check — nothing may raise out of check().
      expect(() => {
        decision = acl.check(tc.caller_id, tc.target_id, ctx);
      }).not.toThrow();

      const superseded = SUPERSEDED_BY_SPEC_V1_22_0[tc.id as string];
      expect(decision, superseded?.reason).toBe(superseded ? superseded.expected : tc.expected);

      expect(captured.length).toBeGreaterThan(0);
      const last = captured[captured.length - 1];

      if (tc.expected_audit_handler_error_present) {
        expect(last.handlerError).not.toBeNull();
      } else {
        // The control case: a well-formed conditional rule skipped for want of
        // a context is NOT unevaluable. A non-null handlerError here means the
        // precheck is over-reaching.
        expect(last.handlerError).toBeNull();
      }

      if (Array.isArray(tc.expected_handler_error_paths)) {
        expect(handlerErrorPaths(last.handlerError as string)).toEqual(
          tc.expected_handler_error_paths,
        );
      }
    });
  });
});
