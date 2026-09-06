/**
 * Cross-language conformance driver for `config_project_root.json`
 * (PROTOCOL_SPEC §9.2.2, apcore#113).
 *
 * Fixture source: apcore/conformance/fixtures/config_project_root.json
 * (canonical, read in place — never vendored).
 *
 * §9.2.2 declares the project root: the configuration file's directory when
 * that file came from §9.14 discovery tiers 1-5, and the process CWD when it
 * came from the user-level tiers 6-7, when no file was found, or when the
 * `Config` has no backing file. v1.35.0 is the DEPRECATION phase — the accessor
 * is required now (requirement 1), the narrow warning is a SHOULD
 * (requirement 2), and NO resolution behaviour changes in the 1.x line
 * (requirement 3, pinned by `v1x_current_bases_unchanged`).
 *
 * WHAT THE `driver_contract` DEMANDS, AND WHERE EACH DEMAND LANDS
 * ---------------------------------------------------------------
 * - `accessor`: read through the public `Config.projectRoot` getter.
 * - `discovery_required`: every tier case reaches the SDK through
 *   `Config.discover()` — TypeScript's no-argument `Config.load()` — never by
 *   handing the loader an explicit path. The tier is the input under test.
 * - `cwd_must_differ`: the process CWD is `project/` throughout and
 *   `elsewhere/` always exists beside it, so tier 1 and the user-level tiers
 *   genuinely separate the two candidate rules.
 * - `home_isolation`: `HOME` is redirected at a fixture-owned temporary tree,
 *   so tiers 6-7 never read the real user's home.
 * - `env_isolation`: `APCORE_CONFIG_FILE` is DELETED for every case that does
 *   not list it. Deleted rather than blanked — an empty `APCORE_*` value is
 *   itself a §9.2 override (CHANGELOG.md:321) and would not merely fail to
 *   select tier 1, it would corrupt the merged document.
 * - `comparison`: absolute paths, symlink-normalised on both sides. The
 *   temporary root is `realpathSync`'d at creation, which is what makes macOS's
 *   `/var` -> `/private/var` symlink stop producing spurious inequality.
 * - `warning_observation`: observed on `console.warn`, this SDK's real warning
 *   channel, filtered to the notice's own `PROTOCOL_SPEC §9.2.2` marker.
 *   Presence only — the text is not normative.
 *
 * THE TIER 6 PATH IS PLATFORM-DEPENDENT
 * --------------------------------------
 * The fixture spells tier 6 `fakehome/.config/apcore/config.yaml`. §9.14 itself
 * says tier 6 is "XDG on Linux, ~/Library/Application Support on macOS", so on
 * darwin this SDK looks in `~/Library/Application Support/apcore/`. The layout
 * mapper below writes the file where the running platform's tier 6 actually is,
 * spelled out here rather than imported from `userLevelConfigPaths()` so the
 * assertion cannot agree with the code by construction. The load-bearing
 * assertions are relational — `project_root == CWD` while the config's source
 * directory is somewhere else — and hold on either platform.
 *
 * WARNING CADENCE
 * ---------------
 * This SDK emits the notice once per process, guarded by a module-level flag
 * with a documented test hook. The fixture states a CONDITION, not a cadence,
 * so the flag is reset before every case: each case is a fresh process as far
 * as requirement 2 is concerned. Two cases expect the warning and two expect
 * silence, and without the reset the second expecting case would observe the
 * first case's suppression rather than its own condition.
 *
 * KNOWN DIVERGENCE (case `no_warning_when_all_path_values_absolute`)
 * ------------------------------------------------------------------
 * The case's config makes `schema.root` and `acl.root` absolute and expects no
 * warning. It leaves `extensions.root` unstated — and §9.1.1 gives it the
 * RELATIVE default `./extensions`, which §9.2.2's target semantics clause 2
 * says re-roots exactly as a written value does. This SDK reads the MERGED
 * configuration, as requirement 2 words it ("at least one path-typed value in
 * the merged configuration is relative"), so it warns. The case is driven under
 * `it.fails` — visible, and red the moment the divergence closes — with the
 * case's actual INTENT (every path-typed value absolute => silence) driven
 * green beside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

import { ACL } from '../src/acl.js';
import { Config, _resetProjectRootDeprecationWarned, discoverConfigFile } from '../src/config.js';
import { SchemaLoader } from '../src/schema/loader.js';
import { findFixturesRoot } from './spec-repo.js';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface ProjectRootCase {
  readonly id: string;
  readonly comment?: string;
  readonly tier: number | null;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly fs?: Record<string, string>;
  readonly config_from_mapping?: Record<string, unknown>;
  readonly expected: Record<string, unknown>;
}

interface ProjectRootFixture {
  readonly description: string;
  readonly driver_contract: Record<string, string>;
  readonly layout: { readonly cwd: string; readonly dirs: readonly string[] };
  readonly test_cases: readonly ProjectRootCase[];
}

const fixture: ProjectRootFixture = JSON.parse(
  fs.readFileSync(path.join(findFixturesRoot(), 'config_project_root.json'), 'utf-8'),
);

function caseFor(id: string): ProjectRootCase {
  const found = fixture.test_cases.find((c) => c.id === id);
  if (!found) throw new Error(`Fixture case '${id}' not found in config_project_root.json`);
  return found;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

let root: string;
let originalCwd: string;

/** The fixture's `fakehome` prefix, redirected onto HOME. */
const FAKE_HOME = 'fakehome';

/** §9.14 tier 6, spelled out per platform rather than read from the SDK. */
function xdgConfigRelative(): string {
  return process.platform === 'darwin'
    ? `${FAKE_HOME}/Library/Application Support/apcore/config.yaml`
    : `${FAKE_HOME}/.config/apcore/config.yaml`;
}

/**
 * Map a fixture-relative layout path onto an absolute path in the temp tree.
 *
 * The one rewrite is tier 6: the fixture writes the POSIX XDG spelling and this
 * platform may use another (see the header). Everything else passes through.
 */
function layoutPath(relative: string): string {
  const rewritten =
    relative === `${FAKE_HOME}/.config/apcore/config.yaml` ||
    relative === `${FAKE_HOME}/.config/apcore`
      ? relative.endsWith('config.yaml')
        ? xdgConfigRelative()
        : dirname(xdgConfigRelative())
      : relative;
  return join(root, rewritten);
}

beforeEach(() => {
  // `comparison`: realpath at creation, so /var -> /private/var on macOS cannot
  // make an otherwise-correct project root compare unequal.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'apcore-project-root-conf-')));
  originalCwd = process.cwd();

  for (const dir of fixture.layout.dirs) {
    mkdirSync(layoutPath(dir), { recursive: true });
  }
  // Tier 6 lives elsewhere on darwin; create the platform location too.
  mkdirSync(dirname(layoutPath(xdgConfigRelative())), { recursive: true });

  // `env_isolation`: DELETED, never ''. An inherited value silently converts
  // every non-tier-1 case into tier 1.
  vi.stubEnv('APCORE_CONFIG_FILE', undefined);
  vi.stubEnv('APCORE_ACL_ROOT', undefined);
  vi.stubEnv('APCORE_SCHEMA_ROOT', undefined);
  vi.stubEnv('APCORE_EXTENSIONS_ROOT', undefined);
  // `home_isolation`.
  vi.stubEnv('HOME', join(root, FAKE_HOME));

  _resetProjectRootDeprecationWarned();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetProjectRootDeprecationWarned();
});

/** Materialise a case's `fs` block verbatim. */
function writeLayout(testCase: ProjectRootCase): void {
  for (const [relative, content] of Object.entries(testCase.fs ?? {})) {
    const target = layoutPath(relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
}

/**
 * Apply a case's `env` block.
 *
 * `APCORE_CONFIG_FILE` names a layout path and is made absolute — the fixture
 * writes it relative to the layout ROOT while the CWD is `project/`, and tier 1
 * is precisely the tier whose file sits outside the CWD. Every other variable
 * is a configuration VALUE and passes through untouched.
 */
function applyEnv(testCase: ProjectRootCase): void {
  for (const [name, value] of Object.entries(testCase.env ?? {})) {
    vi.stubEnv(name, name === 'APCORE_CONFIG_FILE' ? layoutPath(value) : value);
  }
}

/** Enter the case's CWD and confirm it is not the only candidate base. */
function enterCwd(testCase: ProjectRootCase): string {
  const cwd = layoutPath(testCase.cwd);
  process.chdir(cwd);
  // `cwd_must_differ`: the tree always offers a location that is not the CWD,
  // so the tier-1 and user-level cases can separate the two candidate rules.
  expect(layoutPath('elsewhere')).not.toBe(cwd);
  expect(fs.existsSync(layoutPath('elsewhere'))).toBe(true);
  return cwd;
}

/**
 * Drive one tier case through DISCOVERY and report the three fixture fields.
 *
 * `validate: false` keeps the fixture's file content verbatim: §9.1's two
 * required keys are not part of this contract, and synthesising them would put
 * bytes on disk the fixture never declared.
 */
function observe(testCase: ProjectRootCase): {
  config: Config;
  config_source_dir: string | null;
  project_root: string;
  project_root_equals_cwd: boolean;
} {
  writeLayout(testCase);
  applyEnv(testCase);
  const cwd = enterCwd(testCase);
  // The §13.2 notice legitimately fires for the tier-1 cases and is the subject
  // of the next describe block, not of these. Silenced so it does not print.
  spyOnWarn();

  const config = testCase.config_from_mapping
    ? new Config({ ...testCase.config_from_mapping })
    : Config.discover({ validate: false });

  const source = config.sourcePath;
  return {
    config,
    config_source_dir: source === null ? null : dirname(resolve(source)),
    project_root: config.projectRoot,
    project_root_equals_cwd: resolve(config.projectRoot) === resolve(cwd),
  };
}

/** The case's `expected` with its layout labels resolved to absolute paths. */
function expectedPaths(testCase: ProjectRootCase): {
  config_source_dir: string | null;
  project_root: string;
  project_root_equals_cwd: boolean;
} {
  const sourceDir = testCase.expected['config_source_dir'] as string | null;
  return {
    config_source_dir: sourceDir === null ? null : layoutPath(sourceDir),
    project_root: layoutPath(testCase.expected['project_root'] as string),
    project_root_equals_cwd: testCase.expected['project_root_equals_cwd'] as boolean,
  };
}

/** Assert one tier case. */
function assertTierCase(id: string): void {
  const testCase = caseFor(id);
  const observed = observe(testCase);
  const expected = expectedPaths(testCase);

  expect({
    config_source_dir: observed.config_source_dir,
    project_root: observed.project_root,
    project_root_equals_cwd: observed.project_root_equals_cwd,
  }).toEqual(expected);
  expect(isAbsolute(observed.project_root), 'projectRoot must be an absolute path').toBe(true);
}

// ---------------------------------------------------------------------------
// Warning observation
// ---------------------------------------------------------------------------

/** Only this notice's lines, ignoring every other console.warn. */
function noticesFrom(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('PROTOCOL_SPEC §9.2.2'));
}

function spyOnWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

// ---------------------------------------------------------------------------

describe('Conformance: the project root, one case per §9.14 discovery tier', () => {
  it('tier_1_explicit_env_config_file', () => {
    // The tier where the two candidate rules genuinely differ: the file sits
    // outside the CWD, and a path written next to a config the operator
    // explicitly pointed at means "next to that file".
    const testCase = caseFor('tier_1_explicit_env_config_file');
    writeLayout(testCase);
    applyEnv(testCase);
    enterCwd(testCase);

    expect(discoverConfigFile()).toBe(layoutPath('elsewhere/apcore.yaml'));
    assertTierCase('tier_1_explicit_env_config_file');
  });

  it('tier_2_project_yaml', () => assertTierCase('tier_2_project_yaml'));
  it('tier_3_project_yml', () => assertTierCase('tier_3_project_yml'));
  it('tier_4_apcore_yaml', () => assertTierCase('tier_4_apcore_yaml'));
  it('tier_5_apcore_yml', () => assertTierCase('tier_5_apcore_yml'));

  it('tier_6_user_level_xdg', () => {
    // The case that makes the tier split necessary, and the live defect in
    // apcore#113: `extensions.root: ./extensions` in a config shared by every
    // project the user runs cannot mean `~/.config/apcore/extensions`.
    const testCase = caseFor('tier_6_user_level_xdg');
    const observed = observe(testCase);

    // BOTH halves, per the case's own comment: asserting only the source
    // directory passes an implementation that never applies the tier split.
    expect(observed.config_source_dir).toBe(dirname(layoutPath(xdgConfigRelative())));
    expect(observed.project_root).toBe(layoutPath('project'));
    expect(observed.project_root_equals_cwd).toBe(true);
    expect(observed.project_root).not.toBe(observed.config_source_dir);
  });

  it('tier_7_legacy_user_level', () => {
    const testCase = caseFor('tier_7_legacy_user_level');
    const observed = observe(testCase);

    expect(observed.config_source_dir).toBe(layoutPath('fakehome/.apcore'));
    expect(observed.project_root).toBe(layoutPath('project'));
    expect(observed.project_root_equals_cwd).toBe(true);
    expect(observed.project_root).not.toBe(observed.config_source_dir);
  });

  it('no_config_file_found', () => {
    const testCase = caseFor('no_config_file_found');
    writeLayout(testCase);
    enterCwd(testCase);
    expect(discoverConfigFile(), 'the layout must leave discovery nothing to find').toBeNull();

    assertTierCase('no_config_file_found');
    expect(Config.fromDefaults().projectRoot).toBe(layoutPath('project'));
  });

  it('config_without_backing_file', () => {
    // No discovery ran and there is no source path, so the base is the CWD.
    assertTierCase('config_without_backing_file');
  });
});

describe('Conformance: the §9.2.2 deprecation warning condition (requirement 2)', () => {
  it('deprecation_warning_fires_when_root_differs_and_value_is_relative', () => {
    // The positive half: project root != CWD AND a relative path-typed value.
    // This is the population whose resolution changes at v2.0.
    const testCase = caseFor('deprecation_warning_fires_when_root_differs_and_value_is_relative');
    writeLayout(testCase);
    applyEnv(testCase);
    enterCwd(testCase);
    const warn = spyOnWarn();

    const config = Config.discover({ validate: false });

    expect(config.projectRoot).toBe(layoutPath('elsewhere'));
    expect(resolve(config.projectRoot) === resolve(process.cwd())).toBe(false);
    expect(config.get('schema.root')).toBe('./schemas');
    expect({
      project_root_equals_cwd: false,
      relative_path_typed_values_present: true,
      deprecation_warning: noticesFrom(warn).length > 0,
    }).toEqual({
      project_root_equals_cwd: testCase.expected['project_root_equals_cwd'],
      relative_path_typed_values_present: testCase.expected['relative_path_typed_values_present'],
      deprecation_warning: testCase.expected['deprecation_warning'],
    });
  });

  it('no_warning_when_root_equals_cwd', () => {
    // First negative half. A blanket warning would fire for nearly every apcore
    // project, which §9.2.2 explicitly rejects.
    const testCase = caseFor('no_warning_when_root_equals_cwd');
    writeLayout(testCase);
    applyEnv(testCase);
    enterCwd(testCase);
    const warn = spyOnWarn();

    const config = Config.discover({ validate: false });

    expect(config.projectRoot).toBe(layoutPath('project'));
    expect(config.get('schema.root'), 'the relative value must really be present').toBe(
      './schemas',
    );
    expect({
      project_root_equals_cwd: true,
      relative_path_typed_values_present: true,
      deprecation_warning: noticesFrom(warn).length > 0,
    }).toEqual({
      project_root_equals_cwd: testCase.expected['project_root_equals_cwd'],
      relative_path_typed_values_present: testCase.expected['relative_path_typed_values_present'],
      deprecation_warning: testCase.expected['deprecation_warning'],
    });
  });

  it.fails(
    'no_warning_when_all_path_values_absolute — KNOWN DIVERGENCE, see the header',
    () => {
      // The fixture leaves `extensions.root` unstated, and §9.1.1's default for
      // it is the RELATIVE `./extensions`. Requirement 2 asks about the MERGED
      // configuration, so this SDK counts that default and warns.
      const testCase = caseFor('no_warning_when_all_path_values_absolute');
      writeLayout(testCase);
      applyEnv(testCase);
      enterCwd(testCase);
      const warn = spyOnWarn();

      const config = Config.discover({ validate: false });

      expect(config.projectRoot).toBe(layoutPath('elsewhere'));
      expect(noticesFrom(warn).length > 0).toBe(testCase.expected['deprecation_warning']);
    },
  );

  it('the intent of no_warning_when_all_path_values_absolute: no relative value, no notice', () => {
    // The substantive half of requirement 2's second negative, driven green.
    // BOTH conditions are required: a driver that asserts only the
    // root-equals-CWD negative passes an implementation that warns on the
    // project-root difference alone.
    const testCase = caseFor('no_warning_when_all_path_values_absolute');
    applyEnv(testCase);
    // Every §9.2.1 key absolute, including the three §9.1.1 relative defaults.
    writeFileSync(
      layoutPath('elsewhere/apcore.yaml'),
      [
        'project: {name: fixture}',
        `schema: {root: ${join(root, 'abs-schemas')}}`,
        `acl: {root: ${join(root, 'abs-acl')}}`,
        `extensions: {root: ${join(root, 'abs-extensions')}}`,
        `bindings: {dir: ${join(root, 'abs-bindings')}}`,
        '',
      ].join('\n'),
      'utf-8',
    );
    enterCwd(testCase);
    const warn = spyOnWarn();

    const config = Config.discover({ validate: false });

    expect(config.projectRoot).toBe(layoutPath('elsewhere'));
    expect(resolve(config.projectRoot) === resolve(process.cwd())).toBe(false);
    expect(noticesFrom(warn)).toEqual([]);
  });

  it('env_sourced_relative_value_counts_toward_the_warning', () => {
    // The condition asks whether a relative path-typed value is PRESENT in the
    // merged configuration, not which tier supplied it. `APCORE_ACL_ROOT=./x`
    // is exactly the population §9.2.2 changes.
    const testCase = caseFor('env_sourced_relative_value_counts_toward_the_warning');
    writeLayout(testCase);
    applyEnv(testCase);
    enterCwd(testCase);
    const warn = spyOnWarn();

    const config = Config.discover({ validate: false });

    // The env value really did reach the merged view, and the notice names it —
    // without this the case would pass on the §9.1.1 defaults alone.
    expect(config.get('acl.root')).toBe('./x');
    const notices = noticesFrom(warn);
    expect({
      project_root_equals_cwd: resolve(config.projectRoot) === resolve(process.cwd()),
      relative_path_typed_values_present: true,
      deprecation_warning: notices.length > 0,
    }).toEqual({
      project_root_equals_cwd: testCase.expected['project_root_equals_cwd'],
      relative_path_typed_values_present: testCase.expected['relative_path_typed_values_present'],
      deprecation_warning: testCase.expected['deprecation_warning'],
    });
    expect(notices[0]).toContain('acl.root');
  });
});

describe('Conformance: v1.x resolution bases are unchanged (requirement 3)', () => {
  it('v1x_current_bases_unchanged', () => {
    // The deprecation phase changes NO behaviour. Under a tier-1 config outside
    // the CWD, `acl.root` still resolves against the config file's directory
    // (D-64) and `schema.root` still resolves against the CWD. An SDK that
    // adopted the v2.0 rule early fails here.
    const testCase = caseFor('v1x_current_bases_unchanged');
    writeLayout(testCase);
    applyEnv(testCase);
    enterCwd(testCase);
    const warn = spyOnWarn();

    // The fixture writes BYTE-IDENTICAL `global_acl.yaml` files under both
    // candidate roots, and identical decoys cannot be told apart by any
    // observation. Each side keeps the fixture's `default_effect: deny` and
    // gains one marker rule naming itself, so the loaded policy identifies the
    // directory it came from.
    for (const side of ['elsewhere', 'project']) {
      writeFileSync(
        layoutPath(`${side}/acl/global_acl.yaml`),
        yaml.dump({
          default_effect: 'deny',
          rules: [
            {
              callers: ['@external'],
              targets: [`${side}_marker`],
              effect: 'allow',
              description: `Marks the ACL loaded from ${side}/acl.`,
            },
          ],
        }),
        'utf-8',
      );
      // Same trick for the schema root: the fixture's `.keep` entries only
      // assert the directories exist, so each gets a probe schema naming itself.
      writeFileSync(
        layoutPath(`${side}/schemas/probe.schema.yaml`),
        yaml.dump({
          description: `probe from ${side}/schemas`,
          input_schema: { type: 'object', properties: {} },
          output_schema: { type: 'object', properties: {} },
        }),
        'utf-8',
      );
    }

    const config = Config.discover({ validate: false });
    expect(config.projectRoot).toBe(layoutPath(testCase.expected['project_root'] as string));

    // acl.root -> the CONFIG FILE's directory (elsewhere/acl), via public API.
    const acl = ACL.discover(config);
    expect(acl, 'ACL.discover found no policy under either candidate root').not.toBeNull();
    const resolvedAclRoot = (acl as ACL).check('@external', 'elsewhere_marker')
      ? 'elsewhere/acl'
      : (acl as ACL).check('@external', 'project_marker')
        ? 'project/acl'
        : 'neither';

    // schema.root -> the process CWD (project/schemas), via public API.
    const resolvedSchemaRoot = new SchemaLoader(config).load('probe').description;

    expect({
      resolved_acl_root: resolvedAclRoot,
      resolved_schema_root: resolvedSchemaRoot.replace('probe from ', ''),
    }).toEqual({
      resolved_acl_root: testCase.expected['resolved_acl_root'],
      resolved_schema_root: testCase.expected['resolved_schema_root'],
    });

    // The notice fires here (root != CWD, relative values present) and is not
    // what this case is about; asserted so the spy is not silently unused.
    expect(noticesFrom(warn).length).toBeGreaterThan(0);
  });
});

describe('Conformance: fixture coverage', () => {
  it('every fixture case is driven', () => {
    const covered = new Set([
      'tier_1_explicit_env_config_file',
      'tier_2_project_yaml',
      'tier_3_project_yml',
      'tier_4_apcore_yaml',
      'tier_5_apcore_yml',
      'tier_6_user_level_xdg',
      'tier_7_legacy_user_level',
      'no_config_file_found',
      'config_without_backing_file',
      'deprecation_warning_fires_when_root_differs_and_value_is_relative',
      'no_warning_when_root_equals_cwd',
      'no_warning_when_all_path_values_absolute',
      'env_sourced_relative_value_counts_toward_the_warning',
      'v1x_current_bases_unchanged',
    ]);
    expect(
      fixture.test_cases.map((c) => c.id).filter((id) => !covered.has(id)),
      'config_project_root.json gained cases this driver ignores',
    ).toEqual([]);
  });
});
