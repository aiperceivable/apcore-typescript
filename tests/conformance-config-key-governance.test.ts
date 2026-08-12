/**
 * Drive `config_key_governance.json` — the configuration key-surface guard.
 *
 * The fixture derives its `allowed_keys` / `canonical_defaults` from the
 * canonical schemas, so this suite is really asking: does `src/config.ts`'s idea
 * of the config surface still match `apcore/schemas/`?
 *
 * It exists because four separate instances of the same defect shipped
 * undetected: `schema.validation.*` validated by every SDK and declared by no
 * schema, a frozen `version`/`project` default pair that made the required-field
 * check unreachable, `middleware.circuit_breaker.*` forbidden by
 * `apcore-config.schema.json` yet validated everywhere and read nowhere, and a
 * missing Rust default table that resolved 15 documented keys to null. None was
 * findable by any existing test.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONSTRAINTS } from '../src/config.js';
import { DEFAULTS } from '../src/config-defaults.js';

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

interface GovernanceFixture {
  allowed_keys: string[];
  canonical_defaults: Record<string, unknown>;
  canonical_sources: string[];
  driver_contract: { sources: string };
}

const fixture: GovernanceFixture = JSON.parse(
  fs.readFileSync(path.join(findFixturesRoot(), 'config_key_governance.json'), 'utf-8'),
);
const allowed = new Set(fixture.allowed_keys);
const canonical = fixture.canonical_defaults;

/** Flatten a nested default table to { dotPath: value }. An empty object is a
 * leaf — a declared value, not a subtree to descend. */
function flatten(tree: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(tree)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)
        && Object.keys(val as object).length > 0) {
      Object.assign(out, flatten(val as Record<string, unknown>, dotPath));
    } else {
      out[dotPath] = val;
    }
  }
  return out;
}

const defaultKeys = flatten(DEFAULTS);
const constraintKeys = Object.keys(CONSTRAINTS);

describe('Conformance: configuration key-surface governance', () => {
  it('DEFAULTS declares no key the canonical schemas do not allow', () => {
    // apcore-config.schema.json is additionalProperties:false, so a user config
    // carrying such a key fails the canonical schema while the SDK quietly
    // supplies a value for it.
    const violations = Object.keys(defaultKeys).filter((k) => !allowed.has(k)).sort();
    expect(
      violations,
      `DEFAULTS declares keys no canonical schema allows:\n  ${violations
        .map((k) => `${k} = ${JSON.stringify(defaultKeys[k])}`)
        .join('\n  ')}\nEither add them to a schema in apcore/schemas/ (and regenerate ` +
        'the fixture) or remove them from DEFAULTS.',
    ).toEqual([]);
  });

  it('CONSTRAINTS validates no key the canonical schemas do not allow', () => {
    // Validating a key the canonical schema forbids is worse than not
    // validating it: it tells the operator the key is understood.
    const violations = constraintKeys.filter((k) => !allowed.has(k)).sort();
    expect(
      violations,
      `CONSTRAINTS validates keys no canonical schema allows:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reproduces every canonical default', () => {
    // A missing entry means the key resolves to undefined here while its peers
    // return the documented value.
    const missing = Object.keys(canonical).filter((k) => !(k in defaultKeys)).sort();
    expect(
      missing,
      `defaults.schema.json declares defaults DEFAULTS does not carry:\n  ${missing
        .map((k) => `${k} = ${JSON.stringify(canonical[k])}`)
        .join('\n  ')}`,
    ).toEqual([]);
  });

  it.each(Object.keys(canonical).sort())('default for %s matches the canonical value', (key) => {
    expect(defaultKeys[key]).toEqual(canonical[key]);
  });

  it('the fixture is derived, not authored', () => {
    // Guard the guard: if the fixture ever stops naming its generator, the next
    // person to hand-edit it will make it a second source of truth.
    expect(fixture.driver_contract.sources).toContain('regenerated');
    expect(fixture.driver_contract.sources).toContain('do NOT hand-edit');
    expect(fixture.canonical_sources).toEqual([
      'schemas/apcore-config.schema.json',
      'schemas/defaults.schema.json',
      'schemas/sys-modules.schema.json',
    ]);
  });
});
