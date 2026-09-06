/**
 * Cross-language conformance driver for `bindings_dir_resolution.json`
 * (PROTOCOL_SPEC §5.12.6, apcore#114 / apcore-typescript#36).
 *
 * Fixture source: apcore/conformance/fixtures/bindings_dir_resolution.json
 * (canonical, read in place — never vendored).
 *
 * §5.12.6 through v1.34.0 was a MUST with no subject: "if `bindings.dir` is
 * configured, implementations MUST scan files matching `pattern` in that
 * directory", saying neither who scans nor when. v1.35.0 names both — a binding
 * loader invoked WITHOUT an explicit directory resolves it from `bindings.dir`
 * under §9.2 precedence (env > file > default `./bindings`), matches on
 * `bindings.pattern` through the same chain, lets an explicit argument win, and
 * MUST NOT scan at client initialisation.
 *
 * WHAT THE `driver_contract` DEMANDS, AND WHERE EACH DEMAND LANDS
 * ---------------------------------------------------------------
 * - `entry_point`: every case calls the public `BindingLoader.loadBindingDir`.
 *   No private resolution helper is touched — §5.12.6's subject is the loader
 *   as invoked, and a helper that computes the right directory while the public
 *   entry point ignores it satisfies nothing.
 * - `config_construction`: each case's `config_file` block is written to a real
 *   file on disk and loaded through `Config.discover()`. The FILE tier is the
 *   tier under test; an in-memory mapping bypasses it.
 * - `no_explicit_argument`: `explicit_dir: null` cases pass `undefined` as the
 *   directory argument. Handing the loader a directory the driver computed is
 *   the one path that works under BOTH the old and the corrected behaviour.
 * - `env_isolation`: `APCORE_BINDINGS_DIR` and `APCORE_BINDINGS_PATTERN` are
 *   DELETED (not blanked) for every case that does not list them. An empty
 *   string is itself a valid §9.2 override and would blank the config file's
 *   value — the same hazard `APCORE_CONFIG_FILE` posed (CHANGELOG.md:321).
 * - `scan_observation`: `scanned_dir` is read back from the loader's RESULT
 *   against the case's filesystem layout, never from the config value this
 *   driver supplied. Every candidate directory in a case holds a binding file
 *   with a distinct module ID, so the IDs the loader returns identify the
 *   directory it actually enumerated.
 * - `no_startup_scan`: the init case constructs a real `APCore` over a config
 *   whose `bindings.dir` holds a well-formed binding file, and asserts the
 *   module ID is absent from the registry.
 *
 * TWO FIXTURE READINGS THIS DRIVER TAKES (reported, not silently assumed)
 * -----------------------------------------------------------------------
 * 1. MODULE ID COMES FROM THE FILE STEM. The fixture's `binding_file` block is
 *    a single descriptor with `module_id: greet`, yet cases place it under
 *    several names in several directories and expect `loaded_module_ids` to
 *    distinguish them — `env_overrides_config_file_dir` writes
 *    `from_file/file_side.binding.yaml` and `from_env/greet.binding.yaml` and
 *    expects `["greet"]`. That is only discriminating if each file declares the
 *    module ID of its own stem, so this driver derives `module_id` from the
 *    file name and keeps the rest of the descriptor as the fixture states it.
 *    Read the other way, both directories would yield `greet` and the case
 *    would pass on an SDK that ignores the environment tier entirely.
 * 2. `target_id` IS SPELLED `target`. The fixture's descriptor uses
 *    `target_id: "fixture_targets:greet"`, but the canonical
 *    `schemas/binding.schema.json` requires `module_id` + `target` (the
 *    `target_id` spelling appears only in PROTOCOL_SPEC §5.12 prose), and this
 *    SDK — like the canonical `binding_yaml_canonical.yaml` fixture — reads
 *    `target`. The target is also resolved by dynamic import, so it must name a
 *    real ESM module rather than the placeholder `fixture_targets`. The
 *    callable name `greet` is kept.
 *
 * KNOWN DIVERGENCE (case `missing_configured_dir_is_not_an_error`)
 * ----------------------------------------------------------------
 * The fixture requires a configured-but-absent directory to yield an empty
 * result with no error. This SDK throws `BindingFileInvalidError` instead, a
 * behaviour three existing suites pin (tests/test-bindings.test.ts,
 * tests/test-bindings-config-dir.test.ts, tests/decorator-bindings_spec.test.ts).
 * The case is driven under `it.fails` rather than skipped: it stays visible, and
 * it turns red the moment the divergence closes. Today's behaviour is pinned
 * alongside it so the throw cannot change unnoticed either.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

import { BindingLoader } from '../src/bindings.js';
import { APCore } from '../src/client.js';
import { Config, _resetProjectRootDeprecationWarned } from '../src/config.js';
import { BindingFileInvalidError } from '../src/errors.js';
import { Registry } from '../src/registry/registry.js';
import { findFixturesRoot } from './spec-repo.js';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface BindingsDirCase {
  readonly id: string;
  readonly comment?: string;
  readonly config_file?: { readonly path: string; readonly content: Record<string, unknown> };
  readonly env?: Record<string, string>;
  readonly explicit_dir?: string | null;
  readonly invoke_loader?: boolean;
  readonly fs?: Record<string, string>;
  readonly expected: Record<string, unknown>;
}

interface BindingsDirFixture {
  readonly description: string;
  readonly driver_contract: Record<string, string>;
  readonly binding_file: { readonly comment?: string; readonly bindings: readonly JsonRecord[] };
  readonly test_cases: readonly BindingsDirCase[];
}

type JsonRecord = Record<string, unknown>;

const fixture: BindingsDirFixture = JSON.parse(
  fs.readFileSync(path.join(findFixturesRoot(), 'bindings_dir_resolution.json'), 'utf-8'),
);

function caseFor(id: string): BindingsDirCase {
  const found = fixture.test_cases.find((c) => c.id === id);
  if (!found) throw new Error(`Fixture case '${id}' not found in bindings_dir_resolution.json`);
  return found;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalCwd: string;
let loader: BindingLoader;
let registry: Registry;

/** The importable ESM module every binding descriptor targets. */
let targetModule: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'apcore-bindings-dir-')));
  originalCwd = process.cwd();
  loader = new BindingLoader();
  registry = new Registry();
  _resetProjectRootDeprecationWarned();

  // `env_isolation`: DELETED, never set to ''. An empty APCORE_BINDINGS_DIR is
  // a valid §9.2 override that would blank whatever the config file declares,
  // silently converting the discriminating case into the trivial one.
  vi.stubEnv('APCORE_BINDINGS_DIR', undefined);
  vi.stubEnv('APCORE_BINDINGS_PATTERN', undefined);
  vi.stubEnv('APCORE_CONFIG_FILE', undefined);
  // The user-level §9.14 tiers must not reach the real home directory.
  vi.stubEnv('HOME', join(tmpDir, 'nonexistent-home'));

  // The fixture's descriptor carries `auto_schema: true`, and in TypeScript
  // types are erased at run time: the loader infers from a module's
  // `inputSchema` / `outputSchema` exports (src/schema/extractor.ts), which the
  // plain-JSON-Schema adapter accepts. Without them, explicit `auto_schema`
  // raises BINDING_SCHEMA_INFERENCE_FAILED and every case would fail for a
  // reason that has nothing to do with directory resolution.
  targetModule = join(tmpDir, 'fixture_targets.mjs');
  writeFileSync(
    targetModule,
    "export const inputSchema = { type: 'object', properties: {} };\n" +
      "export const outputSchema = { type: 'object', properties: {} };\n" +
      "export function greet() { return { ok: 'greet' }; }\n",
    'utf-8',
  );

  // `loadBindings` warns once per file about the absent `spec_version` (the
  // fixture's descriptor does not carry one) and that noise is not under test.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetProjectRootDeprecationWarned();
});

/**
 * The module ID a binding file declares: its own stem.
 *
 * See reading 1 in the header — `greet.binding.yaml` declares `greet`,
 * `file_side.binding.yaml` declares `file_side`, so the IDs the loader returns
 * name the directory it enumerated.
 */
function moduleIdFor(fileName: string): string {
  return (fileName.split('/').pop() as string).split('.')[0] as string;
}

/** Write the fixture's binding descriptor into `relPath` under the layout. */
function writeBindingFile(relPath: string): void {
  const absPath = join(tmpDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  const descriptor = fixture.binding_file.bindings.map((entry) => {
    const { module_id: _ignoredId, target_id: targetId, ...rest } = entry;
    return {
      ...rest,
      module_id: moduleIdFor(relPath),
      // Reading 2: the canonical binding schema's key is `target`, and it must
      // name an importable module. The callable half of the fixture's
      // `fixture_targets:greet` is preserved.
      target: `${targetModule}:${String(targetId ?? 'fixture_targets:greet').split(':')[1]}`,
    };
  });
  writeFileSync(absPath, yaml.dump({ bindings: descriptor }), 'utf-8');
}

/** Materialise a case's `fs` block. Every value is the fixture's binding file. */
function writeLayout(testCase: BindingsDirCase): void {
  for (const [relPath, kind] of Object.entries(testCase.fs ?? {})) {
    if (kind !== 'binding_file') throw new Error(`Unknown fs payload '${kind}' in ${testCase.id}`);
    writeBindingFile(relPath);
  }
}

/**
 * Write the case's `config_file` block verbatim and load it through discovery.
 *
 * `validate: false` because the fixture's `content` deliberately carries only
 * the keys the case is about; §9.1's two required keys (`version`,
 * `project.name`) are not part of this contract, and inventing them would put
 * content on disk the fixture never declared.
 */
function loadConfig(testCase: BindingsDirCase): Config {
  const block = testCase.config_file;
  if (!block) throw new Error(`Case ${testCase.id} has no config_file block`);
  writeFileSync(join(tmpDir, block.path), yaml.dump(block.content ?? {}), 'utf-8');
  const config = Config.discover({ validate: false });
  expect(config.sourcePath, `${testCase.id}: discovery did not find the case's config file`)
    .toBe(block.path);
  return config;
}

/** Apply a case's `env` block after the isolation deletions. */
function applyEnv(testCase: BindingsDirCase): void {
  for (const [name, value] of Object.entries(testCase.env ?? {})) {
    vi.stubEnv(name, value);
  }
}

/**
 * The directory holding the file that declares `moduleId`, per the case layout.
 *
 * This is the `scan_observation` requirement: the answer is derived from the
 * loader's result and the filesystem layout, NOT from the `bindings.dir` value
 * this driver wrote.
 */
function directoryOf(testCase: BindingsDirCase, moduleId: string): string {
  const entry = Object.keys(testCase.fs ?? {}).find((p) => moduleIdFor(p) === moduleId);
  if (!entry) throw new Error(`${testCase.id}: no layout file declares module '${moduleId}'`);
  return dirname(entry);
}

/** Run one `explicit_dir: null | "..."` case end to end. */
async function runCase(testCase: BindingsDirCase): Promise<{
  scannedDir: string | null;
  loadedModuleIds: string[];
}> {
  writeLayout(testCase);
  applyEnv(testCase);
  process.chdir(tmpDir);
  const config = loadConfig(testCase);

  // `no_explicit_argument`: genuinely absent, not a directory computed here.
  const explicit = testCase.explicit_dir ?? undefined;
  const modules = await loader.loadBindingDir(explicit, registry, undefined, config);

  const loadedModuleIds = modules.map((m) => m.moduleId ?? '').sort();
  const dirs = new Set(loadedModuleIds.map((id) => directoryOf(testCase, id)));
  if (dirs.size > 1) throw new Error(`${testCase.id}: loader spanned directories ${[...dirs]}`);
  return { scannedDir: dirs.size === 1 ? ([...dirs][0] as string) : null, loadedModuleIds };
}

// ---------------------------------------------------------------------------

describe('Conformance: binding-directory resolution (§5.12.6)', () => {
  it('config_file_dir_is_scanned_with_env_unset', async () => {
    // THE DISCRIMINATING CASE. `bindings.dir` in a config FILE,
    // APCORE_BINDINGS_DIR unset, no explicit directory argument. No SDK passed
    // this before v1.35.0, and TypeScript's deleted raw `process.env` read
    // covered only the environment tier.
    const testCase = caseFor('config_file_dir_is_scanned_with_env_unset');
    const observed = await runCase(testCase);

    expect({
      scanned: true,
      scanned_dir: observed.scannedDir,
      loaded_module_ids: observed.loadedModuleIds,
    }).toEqual(testCase.expected);
    expect(registry.has('greet')).toBe(true);
  });

  it('default_dir_when_key_absent', async () => {
    // No `bindings.dir` anywhere and no argument: the §9.1.1 default ./bindings.
    const testCase = caseFor('default_dir_when_key_absent');
    const observed = await runCase(testCase);

    expect({
      scanned: true,
      scanned_dir: observed.scannedDir,
      loaded_module_ids: observed.loadedModuleIds,
    }).toEqual(testCase.expected);
  });

  it('env_overrides_config_file_dir', async () => {
    // §9.2 precedence, top tier. BOTH directories exist and both hold a binding
    // file, so exactly one answer passes — a layout where only the env
    // directory existed would pass on an SDK that ignores the env tier and
    // simply finds nothing.
    const testCase = caseFor('env_overrides_config_file_dir');
    const observed = await runCase(testCase);

    expect({
      scanned: true,
      scanned_dir: observed.scannedDir,
      loaded_module_ids: observed.loadedModuleIds,
    }).toEqual(testCase.expected);
    expect(registry.has('file_side'), 'the config-file directory was scanned instead').toBe(false);
  });

  it('explicit_argument_wins_over_config', async () => {
    // explicit > env > file > default. All three candidates exist and hold a file.
    const testCase = caseFor('explicit_argument_wins_over_config');
    const observed = await runCase(testCase);

    expect({
      scanned: true,
      scanned_dir: observed.scannedDir,
      loaded_module_ids: observed.loadedModuleIds,
    }).toEqual(testCase.expected);
    expect(registry.has('file_side')).toBe(false);
    expect(registry.has('env_side')).toBe(false);
  });

  it('config_file_pattern_is_honoured', async () => {
    // `bindings.pattern` comes from the same precedence chain as the directory,
    // not from a loader-signature default. The decoy matches the DEFAULT
    // pattern, so an SDK that keeps the pattern in its signature loads the
    // wrong file rather than none.
    const testCase = caseFor('config_file_pattern_is_honoured');
    const observed = await runCase(testCase);

    expect({
      scanned: true,
      scanned_dir: observed.scannedDir,
      loaded_module_ids: observed.loadedModuleIds,
    }).toEqual(testCase.expected);
    expect(registry.has('decoy'), 'the *.binding.yaml default was used instead').toBe(false);
  });

  it('default_pattern_when_key_absent', async () => {
    const testCase = caseFor('default_pattern_when_key_absent');
    const observed = await runCase(testCase);

    expect({
      scanned: true,
      scanned_dir: observed.scannedDir,
      loaded_module_ids: observed.loadedModuleIds,
    }).toEqual(testCase.expected);
    expect(registry.has('notes')).toBe(false);
  });

  it.fails(
    'missing_configured_dir_is_not_an_error — KNOWN DIVERGENCE, see the header',
    async () => {
      // The fixture: an absent `bindings.dir` yields an empty result, not an
      // error, because discovery is opportunistic and the key carries a default
      // most projects never create. This SDK throws instead. Driven under
      // `it.fails` so the case stays visible and goes red once the gap closes.
      const testCase = caseFor('missing_configured_dir_is_not_an_error');
      const observed = await runCase(testCase);

      expect({
        scanned: true,
        scanned_dir: observed.scannedDir,
        loaded_module_ids: observed.loadedModuleIds,
        error: null,
      }).toEqual(testCase.expected);
    },
  );

  it("today's behaviour for a missing configured dir: it throws, naming the resolved path", async () => {
    // The other half of the divergence: pinned so the throw cannot change
    // unnoticed either, and so the resolved path stays observable.
    const testCase = caseFor('missing_configured_dir_is_not_an_error');
    applyEnv(testCase);
    process.chdir(tmpDir);
    const config = loadConfig(testCase);

    const error = await loader.loadBindingDir(undefined, registry, undefined, config).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BindingFileInvalidError);
    expect(String((error as BindingFileInvalidError).message)).toContain(
      testCase.expected['scanned_dir'] as string,
    );
    expect(registry.list().length).toBe(0);
  });

  it('no_auto_scan_at_init', async () => {
    // §5.12.6 clause 3. The configured directory exists and holds a well-formed
    // binding file that would load cleanly if anything scanned. Asserting only
    // that construction succeeded would pass trivially, so the assertion is
    // that the module ID is ABSENT from the registry afterwards.
    const testCase = caseFor('no_auto_scan_at_init');
    writeLayout(testCase);
    applyEnv(testCase);
    process.chdir(tmpDir);
    const config = loadConfig(testCase);

    const client = new APCore({ config });

    // `includeHidden`: a startup scan that registered the module as hidden
    // would still be a startup scan, and the default visibility filter would
    // hide it from this assertion.
    const registered = client.registry.list({ includeHidden: true });
    expect(registered).not.toContain('greet');
    expect(client.registry.has('greet')).toBe(false);
    expect({
      scanned: false,
      registered_module_ids: registered.filter((id) => id === 'greet'),
    }).toEqual(testCase.expected);

    // The file really would have loaded: proving the negative needs the
    // positive next to it, or "absent" could just mean "unloadable".
    const modules = await loader.loadBindingDir(undefined, client.registry, undefined, config);
    expect(modules.map((m) => m.moduleId)).toEqual(['greet']);
  });

  it('every fixture case is driven', () => {
    const driven = new Set(fixture.test_cases.map((c) => c.id));
    const covered = new Set([
      'config_file_dir_is_scanned_with_env_unset',
      'default_dir_when_key_absent',
      'env_overrides_config_file_dir',
      'explicit_argument_wins_over_config',
      'config_file_pattern_is_honoured',
      'default_pattern_when_key_absent',
      'missing_configured_dir_is_not_an_error',
      'no_auto_scan_at_init',
    ]);
    expect(
      [...driven].filter((id) => !covered.has(id)),
      'bindings_dir_resolution.json gained cases this driver ignores',
    ).toEqual([]);
  });
});
