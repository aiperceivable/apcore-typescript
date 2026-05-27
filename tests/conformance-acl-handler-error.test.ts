/**
 * Cross-language conformance driver for acl_handler_error.json
 * (A-D-011 fail-closed / A-D-012 handler_error surfaced in audit).
 *
 * Fixture source: apcore/conformance/fixtures/acl_handler_error.json
 * (single source of truth). See that fixture's `description` for the driver
 * contract.
 *
 * SECURITY: a custom condition handler that throws during evaluation MUST fail
 * CLOSED (the rule does not match -> the call is never silently allowed) AND
 * the emitted AuditEntry MUST carry a non-null handlerError.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ACL, ACLRule, AuditEntry } from '../src/acl.js';
import { Context } from '../src/context.js';
import type { ACLConditionHandler } from '../src/acl-handlers.js';

function findFixturesRoot(): string {
  const envPath = process.env.APCORE_SPEC_REPO;
  if (envPath) {
    const fixtures = path.join(envPath, 'conformance', 'fixtures');
    if (fs.existsSync(fixtures)) return fixtures;
    throw new Error(`APCORE_SPEC_REPO=${envPath} does not contain conformance/fixtures/`);
  }
  const repoRoot = path.resolve(__dirname, '..');
  const sibling = path.resolve(repoRoot, '..', 'apcore', 'conformance', 'fixtures');
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(
    'Cannot find apcore conformance fixtures. Set APCORE_SPEC_REPO or clone ' +
      `apcore as a sibling at ${path.resolve(repoRoot, '..', 'apcore')}.`,
  );
}

const FIXTURES_ROOT = findFixturesRoot();

function loadFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, `${name}.json`), 'utf-8'));
}

describe('Conformance: ACL throwing condition handler (A-D-011 / A-D-012)', () => {
  const fixture = loadFixture('acl_handler_error');
  const throwingKey: string = fixture.throwing_condition_key;

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

      expect(decision).toBe(tc.expected);

      if (tc.expected_audit_handler_error_present) {
        expect(captured.length).toBeGreaterThan(0);
        const last = captured[captured.length - 1];
        expect(last.handlerError).not.toBeNull();
      }
    });
  });
});
