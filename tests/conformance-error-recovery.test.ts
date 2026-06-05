/**
 * Cross-language conformance driver for error_recovery_metadata.json.
 *
 * Fixture source: apcore/conformance/fixtures/error_recovery_metadata.json
 * (single source of truth). See that fixture's `description` for the contract.
 *
 * Mirrors apcore-python tests/test_conformance.py::test_error_recovery_user_fixable
 * and ::test_error_recovery_fixture_matches_source.
 *
 * Locks the framework-deterministic `user_fixable` default: a base ModuleError
 * constructed with a given `code` (and no explicit override) MUST resolve
 * `userFixable` from USER_FIXABLE_BY_CODE. Only `user_fixable` is part of the
 * cross-language contract here — `retryable` is class-based and verified
 * elsewhere; `ai_guidance` is human-readable and intentionally not pinned.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ModuleError, USER_FIXABLE_BY_CODE } from '../src/errors.js';

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

describe('Conformance: error recovery metadata (user_fixable)', () => {
  const fixture = loadFixture('error_recovery_metadata');

  fixture.test_cases.forEach((tc: any) => {
    it(tc.id, () => {
      // Construct a base ModuleError with only the code — no explicit
      // user_fixable override — so the framework-deterministic default is
      // resolved from the code. user_fixable is null/unset when the code is
      // absent from the source-of-truth map (fixture expects null too).
      const err = new ModuleError(tc.code, 'conformance check');
      const expected = tc.expected.user_fixable ?? null;
      expect(err.userFixable).toBe(expected);
    });
  });

  it('fixture map matches USER_FIXABLE_BY_CODE source of truth', () => {
    // The fixture's code->user_fixable map (excluding the intentionally-unset
    // null entries) must equal the single source of truth in errors.ts.
    const fixtureMap: Record<string, boolean> = {};
    for (const tc of fixture.test_cases as any[]) {
      if (tc.expected.user_fixable !== null) {
        fixtureMap[tc.code] = tc.expected.user_fixable;
      }
    }
    expect(fixtureMap).toEqual({ ...USER_FIXABLE_BY_CODE });
  });
});
