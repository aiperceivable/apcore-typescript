/**
 * D-89 (spec v1.49.0) — at most one `x-deprecation` warning per
 * `(moduleId, version)` per registry instance.
 *
 * `getDefinition` is a read hosts call in loops, so warning on every read is
 * log spam proportional to traffic — which is how operators learn to filter the
 * advisory out. This SDK was the decision's AUTHORITY and had no test for the
 * module-deprecation warning at all: the one test labelled "D-89 cadence" lives
 * in test-version-hint-deprecation.test.ts and covers a DIFFERENT warning (the
 * D-126 version-hint deprecation, which reuses the same dedupe set). The
 * mechanism the decision is about was unpinned.
 *
 * What makes these RED: removing the `_deprecationWarned` guard in
 * `_warnModuleDeprecated` (the first test), or narrowing its key — dropping the
 * version makes the version test red, keying it on something process-global
 * makes the per-instance test red.
 *
 * Two dimensions are deliberately NOT asserted here, because the three SDKs
 * disagree and D-89 settles neither: WHERE the warning fires (this SDK and
 * apcore-python warn on the read, apcore-rust on registration) and what an
 * unregister + re-register does (apcore-python re-warns, this SDK and
 * apcore-rust stay silent). See the open item beside D-89 in the decision log.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Registry } from '../../src/registry/registry.js';

const DEPRECATION = {
  deprecated_since: '1.0.0',
  sunset_version: '3.0.0',
  migration_guide: 'Use mod.new instead.',
};

function deprecatedModule() {
  return {
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    description: 'a deprecated module',
    execute: async () => ({}),
  };
}

async function register(reg: Registry, moduleId: string, version = '1.0.0'): Promise<void> {
  await reg.register(moduleId, deprecatedModule(), version, {
    'x-deprecation': { ...DEPRECATION },
  });
}

/** Count `x-deprecation` warnings emitted while `f` runs. */
function countWarnings(f: () => void): number {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    f();
    return spy.mock.calls.filter((c) => String(c[0]).includes('is deprecated')).length;
  } finally {
    spy.mockRestore();
  }
}

describe('D-89: the deprecation warning fires once per (moduleId, version)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ten reads produce one warning', async () => {
    const reg = new Registry();
    await register(reg, 'cadence.once');

    expect(
      countWarnings(() => {
        for (let i = 0; i < 10; i++) reg.getDefinition('cadence.once');
      }),
    ).toBe(1);
  });

  it('control: a module with no x-deprecation never warns', () => {
    // Without this, "exactly one warning" would also hold for an SDK that warns
    // once per registry for any module at all.
    const reg = new Registry();
    void reg.register('cadence.plain', deprecatedModule(), '1.0.0');

    expect(
      countWarnings(() => {
        for (let i = 0; i < 10; i++) reg.getDefinition('cadence.plain');
      }),
    ).toBe(0);
  });

  it('distinct modules warn separately', async () => {
    const reg = new Registry();
    await register(reg, 'cadence.first');
    await register(reg, 'cadence.second');

    expect(
      countWarnings(() => {
        for (let i = 0; i < 3; i++) {
          reg.getDefinition('cadence.first');
          reg.getDefinition('cadence.second');
        }
      }),
    ).toBe(2);
  });

  it('the dedupe is per registry INSTANCE, not process-global', async () => {
    // A process-global set would silence the second registry's advisory for a
    // module its operator has never been told about.
    const a = new Registry();
    const b = new Registry();
    await register(a, 'cadence.instance');
    await register(b, 'cadence.instance');

    expect(
      countWarnings(() => {
        a.getDefinition('cadence.instance');
        b.getDefinition('cadence.instance');
      }),
    ).toBe(2);
  });

  it('the dedupe key includes the version', async () => {
    // A newly registered version is a new deprecation notice, with its own
    // sunset. Keying on the module id alone silences it.
    const reg = new Registry();
    await register(reg, 'cadence.versions', '1.0.0');

    const first = countWarnings(() => {
      reg.getDefinition('cadence.versions');
      reg.getDefinition('cadence.versions');
    });
    expect(first).toBe(1);

    await reg.unregister('cadence.versions');
    await register(reg, 'cadence.versions', '2.0.0');

    expect(
      countWarnings(() => {
        reg.getDefinition('cadence.versions');
        reg.getDefinition('cadence.versions');
      }),
    ).toBe(1);
  });
});
