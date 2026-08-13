/**
 * Canonical conformance-fixture locator, shared by every conformance driver.
 *
 * The fixtures are the single source of truth in the apcore spec repo; this
 * SDK reads them in place rather than vendoring a copy, so a spec-side edit
 * reaches TypeScript on the next test run.
 *
 * Search order:
 *   1. `$CONFORMANCE_SPEC_REPO` — the spec repo root (set by CI).
 *   2. `../apcore/` beside this repo — the standard workspace layout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SPEC_REPO_ENV = 'CONFORMANCE_SPEC_REPO';

/**
 * Transitional fallback (apcore#86). The locator used to be
 * `APCORE_SPEC_REPO`, but PROTOCOL_SPEC §9.2 makes *every* `APCORE_*` variable
 * a config override: the suffix is lowercased and split into a dot path, so
 * `APCORE_SPEC_REPO=/path` injected `spec.repo` into the declared config
 * document that §9.1's required-field check runs against. The locator is test
 * infrastructure, not configuration, so it moved out of the claimed prefix.
 * Reading the old name keeps a developer who still exports it working.
 * REMOVE once all three SDK CI workflows are on CONFORMANCE_SPEC_REPO.
 */
const LEGACY_SPEC_REPO_ENV = 'APCORE_SPEC_REPO';

/**
 * Return the spec-repo override as `[variableName, value]`, or `undefined`.
 *
 * The name travels with the value so a failure message can name the variable
 * the developer actually set rather than the one they did not.
 */
export function specRepoEnv(): readonly [string, string] | undefined {
  for (const name of [SPEC_REPO_ENV, LEGACY_SPEC_REPO_ENV]) {
    const value = process.env[name];
    if (value) return [name, value] as const;
  }
  return undefined;
}

/** Resolve the canonical `conformance/fixtures` directory, or throw. */
export function findFixturesRoot(): string {
  const env = specRepoEnv();
  if (env) {
    const [name, value] = env;
    const fixtures = path.join(value, 'conformance', 'fixtures');
    if (fs.existsSync(fixtures)) return fixtures;
    throw new Error(`${name}=${value} does not contain conformance/fixtures/`);
  }

  const repoRoot = path.resolve(__dirname, '..'); // apcore-typescript/
  const sibling = path.resolve(repoRoot, '..', 'apcore', 'conformance', 'fixtures');
  if (fs.existsSync(sibling)) return sibling;

  throw new Error(
    'Cannot find apcore conformance fixtures.\n\n' +
      'Fix one of:\n' +
      `  1. Set ${SPEC_REPO_ENV} to the apcore spec repo path\n` +
      `  2. Clone apcore as a sibling: git clone <apcore-url> ${path.resolve(repoRoot, '..', 'apcore')}\n`,
  );
}
