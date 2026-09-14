/**
 * Drive `id_map_from_config.json` — §9.1.1 `id_map.overrides` (#118 D-71).
 *
 * Every case discovers from a real directory with a real `apcore.yaml` and
 * reads the registered module IDs. Calling `loadIdMap` directly would prove the
 * loader works, which was never the question: the mechanism was implemented in
 * all three SDKs and the CONFIG KEY reached none of them.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import yaml from 'js-yaml';

import { Config } from '../src/config.js';
import { Registry } from '../src/registry/registry.js';
import { findFixturesRoot } from './spec-repo.js';

interface IdMapCase {
  readonly id: string;
  readonly input: { readonly declare_override: boolean; readonly explicit_argument: boolean };
  readonly expected: { readonly module_ids: readonly string[] };
}

const fixture: { test_cases: readonly IdMapCase[] } = JSON.parse(
  fs.readFileSync(path.join(findFixturesRoot(), 'id_map_from_config.json'), 'utf-8'),
);

function tree(declareOverride: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-id-map-'));
  const leaf = path.join(root, 'ext', 'executor', 'orig');
  fs.mkdirSync(leaf, { recursive: true });
  // A shape `isModuleClass` accepts: an OBJECT export carrying the two
  // schemas, a description and an execute. A bare class is scanned but not
  // loadable, so the registry would discover the ID and register nothing.
  fs.writeFileSync(
    path.join(leaf, 'mod.ts'),
    [
      'export const Mod = {',
      "  inputSchema: { type: 'object' },",
      "  outputSchema: { type: 'object' },",
      "  description: 'Discoverable probe module.',",
      '  execute: () => ({ ok: true }),',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
  for (const [name, id] of [
    ['map.yaml', 'executor.renamed.mod'],
    ['explicit.yaml', 'executor.explicit.mod'],
  ]) {
    fs.writeFileSync(
      path.join(root, name as string),
      yaml.dump({ mappings: [{ file: 'executor/orig/mod.ts', id }] }),
      'utf-8',
    );
  }
  const doc: Record<string, unknown> = {
    version: '1.0',
    project: { name: 'id-map-probe' },
    extensions: { root: './ext' },
  };
  if (declareOverride) doc['id_map'] = { overrides: './map.yaml' };
  fs.writeFileSync(path.join(root, 'apcore.yaml'), yaml.dump(doc), 'utf-8');
  return root;
}

let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(cwd);
});

describe('id_map_from_config.json', () => {
  for (const testCase of fixture.test_cases) {
    it(testCase.id, async () => {
      const root = tree(testCase.input.declare_override);
      process.chdir(root);
      const config = Config.load(path.join(root, 'apcore.yaml'));
      const registry = new Registry({
        config,
        idMapPath: testCase.input.explicit_argument
          ? path.join(root, 'explicit.yaml')
          : null,
      });
      await registry.discover();
      expect([...registry.moduleIds].sort()).toEqual([...testCase.expected.module_ids]);
    });
  }

  it('uses the same resolution base as extensions.root', async () => {
    // §9.2.1 leaves the base for path-typed keys deliberately unspecified
    // (#113): `acl.root` uses the config file's directory, `schema.root` the
    // CWD. This key follows its SIBLING rather than settling that, because the
    // two are halves of one discovery configuration. Driven from a different
    // working directory: both halves miss together, which is the property.
    const root = tree(true);
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-elsewhere-')));
    const config = Config.load(path.join(root, 'apcore.yaml'));
    await expect(new Registry({ config }).discover()).rejects.toThrow();
  });
});
