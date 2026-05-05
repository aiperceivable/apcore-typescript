/**
 * Central module registry for discovering, registering, and querying modules.
 */

import type { Config } from '../config.js';
import { getDefault } from '../config.js';
import { InvalidInputError, ModuleNotFoundError } from '../errors.js';
import type { ModuleAnnotations, ModuleExample } from '../module.js';
import { detectIdConflicts } from './conflicts.js';
import { resolveDependencies } from './dependencies.js';
import { resolveEntryPoint } from './entry-point.js';
import { mergeModuleMetadata, parseDependencies } from './metadata.js';
import { _discoverMultiClass } from './multi-class.js';
import { getSchema, exportSchema as exportSchemaFn } from './schema-export.js';
import { toStrictSchema } from '../schema/strict.js';
import { deepCopy } from '../utils/index.js';
import type { DependencyInfo, ModuleDescriptor } from './types.js';
import { validateModule } from './validation.js';

// ── Lazy-loaded Node.js modules ────────────────────────────────────
// These are loaded on first use so that importing Registry in a browser
// bundler does not fail at parse time. Only the filesystem-dependent
// methods (discover, watch, constructor with idMapPath) trigger the load.
// We use dynamic import() to avoid any top-level reference to node: modules.

let _nodeFs: typeof import('node:fs') | null = null;
let _nodePath: typeof import('node:path') | null = null;

async function ensureNodeModules(): Promise<{
  fs: typeof import('node:fs');
  path: typeof import('node:path');
}> {
  if (_nodeFs === null) {
    _nodeFs = await import('node:fs');
  }
  if (_nodePath === null) {
    _nodePath = await import('node:path');
  }
  return { fs: _nodeFs, path: _nodePath };
}

async function lazyLoadIdMap(idMapPath: string): Promise<Record<string, Record<string, unknown>>> {
  const { loadIdMap } = await import('./metadata.js');
  return loadIdMap(idMapPath);
}

async function lazyLoadMetadata(metaPath: string): Promise<Record<string, unknown>> {
  const { loadMetadata } = await import('./metadata.js');
  return loadMetadata(metaPath);
}

async function lazyScanExtensions(
  root: string, maxDepth: number, followSymlinks: boolean,
): Promise<import('./types.js').DiscoveredModule[]> {
  const { scanExtensions } = await import('./scanner.js');
  return scanExtensions(root, maxDepth, followSymlinks);
}

async function lazyScanMultiRoot(
  roots: Array<Record<string, unknown>>, maxDepth: number, followSymlinks: boolean,
): Promise<import('./types.js').DiscoveredModule[]> {
  const { scanMultiRoot } = await import('./scanner.js');
  return scanMultiRoot(roots, maxDepth, followSymlinks);
}

/**
 * One-shot deprecation flag for the legacy 4-arg
 * `Registry.discoverMultiClass(filePath, classes, extensionsRoot, multiClassEnabled)`
 * call shape. Cleared per process so the warning fires at most once even
 * across many invocations from the same caller. See apcore decision-log
 * D-06 (apcore commit 973410b).
 *
 * @internal exported for tests so they can reset between cases.
 */
let _multiClassEnabledDeprecationWarned = false;

/**
 * Reset the one-shot deprecation flag for the legacy 4-arg
 * `Registry.discoverMultiClass` overload. Test-only — production callers
 * never need this.
 *
 * @internal
 */
export function _resetMultiClassEnabledDeprecationWarned(): void {
  _multiClassEnabledDeprecationWarned = false;
}

function warnMultiClassEnabledDeprecated(): void {
  if (_multiClassEnabledDeprecationWarned) return;
  _multiClassEnabledDeprecationWarned = true;
  console.warn(
    '[apcore:registry] DEPRECATION: the `multiClassEnabled` argument to ' +
    '`Registry.discoverMultiClass()` is deprecated and ignored under apcore ' +
    'decision-log D-06. Mark each `ClassDescriptor` with `multiClass: true` ' +
    'instead. The 4-arg overload will be removed in v0.22.0.',
  );
}

/**
 * Standard registry event names.
 */
export const REGISTRY_EVENTS = Object.freeze({
  REGISTER: "register",
  UNREGISTER: "unregister",
} as const);

/**
 * Valid module ID pattern. Only lowercase letters, digits, underscores, and dots.
 * Hyphens are prohibited to ensure bijective MCP/OpenAI tool name normalization.
 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Maximum allowed length for a module ID.
 *
 * Per PROTOCOL_SPEC §2.7 EBNF constraint #1. 192 is filesystem-safe
 * (192 + ".binding.yaml".length = 205 < 255-byte filename limit on
 * ext4/xfs/NTFS/APFS/btrfs) and accommodates Java/.NET deep-namespace
 * FQN-derived IDs. Bumped from 128 in spec 1.6.0-draft (2026-04-08).
 */
export const MAX_MODULE_ID_LENGTH = 192;

/**
 * Reserved words that cannot appear as the first segment of a module ID.
 */
export const RESERVED_WORDS = new Set(['system', 'internal', 'core', 'apcore', 'plugin', 'schema', 'acl']);

/**
 * Validate a module ID against PROTOCOL_SPEC §2.7 in canonical order.
 *
 * Order: empty → pattern → length → reserved (first-segment).
 * Duplicate detection is the caller's responsibility (it requires registry
 * state).
 *
 * When `allowReserved` is true the first-segment reserved word check is
 * skipped — used by `Registry.registerInternal` so sys modules can use the
 * `system.*` prefix. All other validations (empty, pattern, length) still
 * apply.
 *
 * Aligned with `apcore-python._validate_module_id` and
 * `apcore::registry::registry::validate_module_id`.
 *
 * @internal
 */
function validateModuleId(moduleId: string, allowReserved: boolean): void {
  // 1. empty check (message byte-aligned with apcore-python and apcore-rust)
  if (!moduleId || typeof moduleId !== 'string') {
    throw new InvalidInputError('module_id must be a non-empty string');
  }

  // 2. EBNF pattern check (message byte-aligned with apcore-python and apcore-rust:
  // single quotes around the offending ID; bare regex source without /…/ delimiters)
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    throw new InvalidInputError(
      `Invalid module ID: '${moduleId}'. Must match pattern: ${MODULE_ID_PATTERN.source} (lowercase, digits, underscores, dots only; no hyphens)`,
    );
  }

  // 3. length check
  if (moduleId.length > MAX_MODULE_ID_LENGTH) {
    throw new InvalidInputError(
      `Module ID exceeds maximum length of ${MAX_MODULE_ID_LENGTH}: ${moduleId.length}`,
    );
  }

  // 4. reserved word first-segment check (skipped for registerInternal)
  if (!allowReserved) {
    const firstSegment = moduleId.split('.')[0];
    if (RESERVED_WORDS.has(firstSegment)) {
      throw new InvalidInputError(`Module ID contains reserved word: '${firstSegment}'`);
    }
  }
}

/**
 * Interface for custom module discovery.
 */
export interface Discoverer {
  discover(roots: string[]): Array<{ moduleId: string; module: unknown }> | Promise<Array<{ moduleId: string; module: unknown }>>;
}

/**
 * Interface for custom module validation.
 */
export interface ModuleValidator {
  validate(module: unknown): string[] | Promise<string[]>;
}

type EventCallback = (moduleId: string, module: unknown) => void;

export class Registry {
  private _extensionRoots: Array<Record<string, unknown>>;
  private _modules: Map<string, unknown> = new Map();
  private _moduleMeta: Map<string, Record<string, unknown>> = new Map();
  private _callbacks: Map<string, EventCallback[]> = new Map([
    [REGISTRY_EVENTS.REGISTER, []],
    [REGISTRY_EVENTS.UNREGISTER, []],
  ]);
  private _idMap: Record<string, Record<string, unknown>> = {};
  private _lowercaseMap: Map<string, string> = new Map();
  private _schemaCache: Map<string, Record<string, unknown>> = new Map();
  private _config: Config | null;
  private _watchers?: Array<{ close(): void }>;
  private _debounceTimers?: Map<string, number>;
  private _customDiscoverer: Discoverer | null = null;
  private _customValidator: ModuleValidator | null = null;
  private _idMapPath: string | null = null;
  private _idMapLoaded = false;

  // Safe hot-reload state (F09 / Algorithm A21)
  private _refCounts: Map<string, number> = new Map();
  private _draining: Set<string> = new Set();
  private _drainResolvers: Map<string, Array<() => void>> = new Map();

  constructor(options?: {
    config?: Config | null;
    extensionsDir?: string | null;
    extensionsDirs?: Array<string | Record<string, unknown>> | null;
    idMapPath?: string | null;
  }) {
    const config = options?.config ?? null;
    const extensionsDir = options?.extensionsDir ?? null;
    const extensionsDirs = options?.extensionsDirs ?? null;

    if (extensionsDir !== null && extensionsDirs !== null) {
      throw new InvalidInputError('Cannot specify both extensionsDir and extensionsDirs');
    }

    if (extensionsDir !== null) {
      this._extensionRoots = [{ root: extensionsDir }];
    } else if (extensionsDirs !== null) {
      this._extensionRoots = extensionsDirs.map((item) =>
        typeof item === 'string' ? { root: item } : item,
      );
    } else if (config !== null) {
      const extRoot = config.get('extensions.root') as string | undefined;
      this._extensionRoots = [{ root: extRoot ?? getDefault('extensions.root') as string }];
    } else {
      this._extensionRoots = [{ root: getDefault('extensions.root') as string }];
    }

    this._config = config;
    this._idMapPath = options?.idMapPath ?? null;
  }

  /** Lazily load the ID map from disk on first discover(). */
  private async _ensureIdMap(): Promise<void> {
    if (this._idMapLoaded || this._idMapPath === null) return;
    this._idMap = await lazyLoadIdMap(this._idMapPath);
    this._idMapLoaded = true;
  }

  setDiscoverer(discoverer: Discoverer): void {
    this._customDiscoverer = discoverer;
  }

  setValidator(validator: ModuleValidator): void {
    this._customValidator = validator;
  }

  async discover(): Promise<number> {
    if (this._customDiscoverer !== null) {
      return this._discoverCustom();
    }
    return this._discoverDefault();
  }

  private async _discoverCustom(): Promise<number> {
    const rootPaths = this._extensionRoots.map((r) => r['root'] as string);
    const customModules = await this._customDiscoverer!.discover(rootPaths);

    if (!Array.isArray(customModules)) {
      console.warn(
        `[apcore:registry] Custom discoverer returned non-array (${typeof customModules}); expected Array<{moduleId, module}>. Ignoring.`,
      );
      return 0;
    }

    let count = 0;
    for (const entry of customModules) {
      if (entry === null || typeof entry !== 'object') {
        console.warn(
          `[apcore:registry] Malformed entry from custom discoverer (expected object, got ${entry === null ? 'null' : typeof entry}); skipping.`,
        );
        continue;
      }

      const { moduleId, module: mod } = entry as { moduleId?: unknown; module?: unknown };
      if (typeof moduleId !== 'string' || mod === undefined) {
        console.warn(
          `[apcore:registry] Malformed entry from custom discoverer (missing 'moduleId' string or 'module'); skipping.`,
        );
        continue;
      }

      // Apply custom validator if set
      if (this._customValidator !== null) {
        const errors = await this._customValidator.validate(mod);
        if (errors.length > 0) {
          console.warn(
            `[apcore:registry] Custom validator rejected module '${moduleId}': ${errors.join('; ')}`,
          );
          continue;
        }
      }

      // PROTOCOL_SPEC §2.7 ID validation — sync finding A-D-102.
      // Mirrors apcore-python `Registry._discover_custom` which calls
      // `_validate_module_id` before registration. Invalid IDs are skipped
      // with a warning rather than aborting the whole discover run.
      try {
        validateModuleId(moduleId, false);
      } catch (e) {
        console.warn(
          `[apcore:registry] Skipping custom-discovered module with invalid ID '${moduleId}': ${(e as Error).message}`,
        );
        continue;
      }

      try {
        this._registerImpl(moduleId, mod);
        count++;
      } catch (e) {
        console.warn(`[apcore:registry] Failed to register custom-discovered module '${moduleId}':`, e);
      }
    }

    return count;
  }

  /**
   * Default discovery pipeline (D-32 — 8 canonical stages, mirroring
   * apcore-rust `default_discoverer.rs`):
   *
   *   1. _ensureIdMap            — lazy-load the optional id_map.json
   *   2. _scanRoots              — walk extension roots
   *   3. _applyIdMapOverrides    — rewrite canonical IDs from the map
   *   4. _loadAllMetadata        — load each module's `module.yaml`
   *   5. _resolveAllEntryPoints  — import the JS/TS entry point
   *   6. _validateAll            — run module/custom validators
   *   7. _filterIdConflicts      — batch-drop conflicting / invalid IDs
   *   8. _resolveLoadOrder + _registerInOrder
   *                              — topological sort then register.
   */
  private async _discoverDefault(): Promise<number> {
    await this._ensureIdMap();
    const discovered = await this._scanRoots();
    await this._applyIdMapOverrides(discovered);

    const rawMetadata = await this._loadAllMetadata(discovered);
    const resolvedModules = await this._resolveAllEntryPoints(discovered, rawMetadata);
    const validModules = await this._validateAll(resolvedModules);
    const filteredModules = this._filterIdConflicts(validModules, rawMetadata);
    const loadOrder = this._resolveLoadOrder(filteredModules, rawMetadata);

    return this._registerInOrder(loadOrder, filteredModules, rawMetadata);
  }

  private async _scanRoots(): Promise<import('./types.js').DiscoveredModule[]> {
    let maxDepth = 8;
    let followSymlinks = false;
    if (this._config !== null) {
      maxDepth = (this._config.get('extensions.max_depth', 8) as number);
      followSymlinks = (this._config.get('extensions.follow_symlinks', false) as boolean);
    }

    const hasNamespace = this._extensionRoots.some((r) => 'namespace' in r);
    if (this._extensionRoots.length > 1 || hasNamespace) {
      return lazyScanMultiRoot(this._extensionRoots, maxDepth, followSymlinks);
    }
    return lazyScanExtensions(this._extensionRoots[0]['root'] as string, maxDepth, followSymlinks);
  }

  private async _applyIdMapOverrides(discovered: import('./types.js').DiscoveredModule[]): Promise<void> {
    if (Object.keys(this._idMap).length === 0) return;

    const { path: nodePath } = await ensureNodeModules();
    const resolvedRoots = this._extensionRoots.map((r) => nodePath.resolve(r['root'] as string));
    for (const dm of discovered) {
      for (const root of resolvedRoots) {
        try {
          const relPath = dm.filePath.startsWith(root)
            ? dm.filePath.slice(root.length + 1)
            : null;
          if (relPath && relPath in this._idMap) {
            const rawId = this._idMap[relPath]['id'];
            if (typeof rawId === 'string' && rawId.length > 0) {
              dm.canonicalId = rawId;
            } else {
              console.warn(`[apcore:registry] ID map entry for '${relPath}' has invalid 'id' field (got ${typeof rawId}), skipping override`);
            }
            break;
          }
        } catch (e) {
          console.warn(`[apcore:registry] Failed to apply ID map for ${dm.canonicalId}:`, e);
          continue;
        }
      }
    }
  }

  private async _loadAllMetadata(
    discovered: import('./types.js').DiscoveredModule[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const rawMetadata = new Map<string, Record<string, unknown>>();
    for (const dm of discovered) {
      rawMetadata.set(dm.canonicalId, dm.metaPath ? await lazyLoadMetadata(dm.metaPath) : {});
    }
    return rawMetadata;
  }

  private async _resolveAllEntryPoints(
    discovered: import('./types.js').DiscoveredModule[],
    rawMetadata: Map<string, Record<string, unknown>>,
  ): Promise<Map<string, unknown>> {
    const resolvedModules = new Map<string, unknown>();
    for (const dm of discovered) {
      const meta = rawMetadata.get(dm.canonicalId) ?? {};
      try {
        const mod = await resolveEntryPoint(dm.filePath, meta);
        resolvedModules.set(dm.canonicalId, mod);
      } catch (e) {
        console.warn(`[apcore:registry] Failed to resolve entry point for ${dm.canonicalId}:`, e);
      }
    }
    return resolvedModules;
  }

  private async _validateAll(resolvedModules: Map<string, unknown>): Promise<Map<string, unknown>> {
    const validModules = new Map<string, unknown>();
    for (const [modId, mod] of resolvedModules) {
      if (this._customValidator !== null) {
        const errors = await this._customValidator.validate(mod);
        if (errors.length === 0) {
          validModules.set(modId, mod);
        }
      } else if (validateModule(mod).length === 0) {
        validModules.set(modId, mod);
      }
    }
    return validModules;
  }

  /**
   * Stage 7 (D-32) — batch-drop modules with invalid or conflicting IDs.
   *
   * Mirrors apcore-python `_filter_id_conflicts` and apcore-rust
   * `default_discoverer::filter_id_conflicts`. Two failure modes drop a
   * module here (warn + skip) rather than aborting the whole batch:
   *   - PROTOCOL_SPEC §2.7 ID validation (empty / pattern / length /
   *     reserved-word first segment), and
   *   - Algorithm A03 conflict detection (duplicate against an existing
   *     registration, lowercase collision, reserved-word collision).
   *
   * Soft-severity conflicts (e.g. case-insensitive match against an
   * already-registered ID at `warn` level) are NOT dropped here — the
   * warning is logged and the module flows through to registration so
   * existing behaviour is preserved. Only `error`-severity conflicts and
   * invalid IDs are filtered out.
   *
   * `rawMetadata` is accepted for cross-language signature parity with
   * the Rust/Python helpers (which may inspect metadata for additional
   * checks); the TS implementation reads only the module ID.
   */
  private _filterIdConflicts(
    validModules: Map<string, unknown>,
    _rawMetadata: Map<string, Record<string, unknown>>,
  ): Map<string, unknown> {
    const filtered = new Map<string, unknown>();
    // Track within-batch IDs (case-insensitive) so two newly-discovered
    // modules whose IDs collide on lowercase don't both slip through.
    const batchLowercase = new Map<string, string>(this._lowercaseMap);
    const batchIds = new Set<string>(this._modules.keys());

    for (const [modId, mod] of validModules.entries()) {
      try {
        validateModuleId(modId, false);
      } catch (e) {
        console.warn(
          `[apcore:registry] Skipping discovered module with invalid ID '${modId}': ${(e as Error).message}`,
        );
        continue;
      }

      const conflict = detectIdConflicts(
        modId,
        batchIds,
        RESERVED_WORDS,
        batchLowercase,
      );
      if (conflict !== null) {
        if (conflict.severity === 'error') {
          console.warn(
            `[apcore:registry] Skipping discovered module '${modId}' due to ID conflict: ${conflict.message}`,
          );
          continue;
        }
        // Soft severity — log but keep the module.
        console.warn(`[apcore:registry] ID conflict: ${conflict.message}`);
      }

      filtered.set(modId, mod);
      batchIds.add(modId);
      batchLowercase.set(modId.toLowerCase(), modId);
    }

    return filtered;
  }

  private _resolveLoadOrder(
    validModules: Map<string, unknown>,
    rawMetadata: Map<string, Record<string, unknown>>,
  ): string[] {
    const modulesWithDeps: Array<[string, DependencyInfo[]]> = [];
    const moduleVersions = new Map<string, string>();
    for (const [modId, cls] of validModules.entries()) {
      const meta = rawMetadata.get(modId) ?? {};
      const depsRaw = (meta['dependencies'] as Array<Record<string, unknown>>) ?? [];
      modulesWithDeps.push([modId, depsRaw.length > 0 ? parseDependencies(depsRaw) : []]);
      const yamlVersion = meta['version'];
      const codeVersion = (cls as { version?: unknown })?.version;
      const resolvedVersion =
        (typeof yamlVersion === 'string' && yamlVersion) ||
        (typeof codeVersion === 'string' && codeVersion) ||
        '1.0.0';
      moduleVersions.set(modId, resolvedVersion);
    }
    // Include already-registered modules so inter-batch version constraints
    // resolve against the live registry too.
    for (const [existingId, existingMod] of this._modules.entries()) {
      if (!moduleVersions.has(existingId)) {
        const existingVersion = (existingMod as { version?: unknown })?.version;
        if (typeof existingVersion === 'string') {
          moduleVersions.set(existingId, existingVersion);
        }
      }
    }
    const knownIds = new Set([
      ...modulesWithDeps.map(([id]) => id),
      ...this._modules.keys(),
    ]);
    return resolveDependencies(modulesWithDeps, knownIds, moduleVersions);
  }

  private _registerInOrder(
    loadOrder: string[],
    validModules: Map<string, unknown>,
    rawMetadata: Map<string, Record<string, unknown>>,
  ): number {
    // Stage 8 (D-32). Conflict detection / ID validation already happened in
    // `_filterIdConflicts` (stage 7), so this loop is purely a register pass.
    let count = 0;
    for (const modId of loadOrder) {
      const mod = validModules.get(modId);
      if (mod === undefined) continue;
      const modObj = mod as Record<string, unknown>;
      const mergedMeta = mergeModuleMetadata(modObj, rawMetadata.get(modId) ?? {});

      this._modules.set(modId, mod);
      this._moduleMeta.set(modId, mergedMeta);
      this._lowercaseMap.set(modId.toLowerCase(), modId);

      if (typeof modObj['onLoad'] === 'function') {
        try {
          (modObj['onLoad'] as () => void)();
        } catch (e) {
          console.warn(`[apcore:registry] onLoad failed for ${modId}, skipping:`, e);
          this._modules.delete(modId);
          this._moduleMeta.delete(modId);
          this._lowercaseMap.delete(modId.toLowerCase());
          continue;
        }
      }

      this._triggerEvent(REGISTRY_EVENTS.REGISTER, modId, mod);
      count++;
    }
    return count;
  }

  /**
   * Register a module.
   *
   * Validation order (PROTOCOL_SPEC §2.7, aligned with apcore-python and
   * apcore-rust): empty → pattern → length → reserved (per-segment) →
   * duplicate.
   *
   * The optional `version` and `metadata` parameters mirror apcore-python's
   * `Registry.register(module_id, module, version=None, metadata=None)` for
   * cross-language signature parity (sync finding A-001). Multi-version
   * coexistence is not yet implemented in this SDK — when supplied, both
   * fields are merged into the module's metadata so callers can read them
   * back via `getDefinition()` and `list({tags})`. See PROTOCOL_SPEC §5.4.
   */
  register(
    moduleId: string,
    module: unknown,
    version?: string | null,
    metadata?: Record<string, unknown> | null,
  ): void {
    validateModuleId(moduleId, false);

    if (this._customValidator !== null) {
      const result = this._customValidator.validate(module);
      if (result instanceof Promise) {
        throw new InvalidInputError(
          `Custom validator for '${moduleId}' is async — use discover() which awaits the validator, or register after awaiting validation manually.`,
        );
      }
      if (result.length > 0) {
        throw new InvalidInputError(`Custom validator rejected module '${moduleId}': ${result.join('; ')}`);
      }
    }

    const overrides: Record<string, unknown> = { ...(metadata ?? {}) };
    if (version !== undefined && version !== null) {
      overrides['version'] = version;
    }
    this._registerImpl(moduleId, module, overrides);
  }

  /** Inner registration — no validator, no ID validation. Used by discover() paths that run their own checks. */
  private _registerImpl(
    moduleId: string,
    module: unknown,
    metadataOverrides: Record<string, unknown> = {},
  ): void {
    // Algorithm A03: detect ID conflicts (exact duplicate, reserved word, case collision)
    const conflict = detectIdConflicts(
      moduleId,
      new Set(this._modules.keys()),
      RESERVED_WORDS,
      this._lowercaseMap,
    );
    if (conflict !== null) {
      if (conflict.severity === 'error') {
        throw new InvalidInputError(conflict.message);
      } else {
        console.warn(`[apcore:registry] ID conflict: ${conflict.message}`);
      }
    }

    this._modules.set(moduleId, module);
    this._lowercaseMap.set(moduleId.toLowerCase(), moduleId);

    // Populate metadata from the module object, layering any explicit overrides
    // (e.g. the `version` / `metadata` args passed to `register()`) on top.
    const modObj = module as Record<string, unknown>;
    this._moduleMeta.set(moduleId, mergeModuleMetadata(modObj, metadataOverrides));

    // Call onLoad if available
    if (typeof modObj['onLoad'] === 'function') {
      try {
        (modObj['onLoad'] as () => void)();
      } catch (e) {
        this._modules.delete(moduleId);
        this._moduleMeta.delete(moduleId);
        this._lowercaseMap.delete(moduleId.toLowerCase());
        throw e;
      }
    }

    this._triggerEvent(REGISTRY_EVENTS.REGISTER, moduleId, module);
  }

  unregister(moduleId: string): boolean {
    if (!this._modules.has(moduleId)) return false;

    const module = this._modules.get(moduleId)!;
    this._modules.delete(moduleId);
    this._moduleMeta.delete(moduleId);
    this._schemaCache.delete(moduleId);
    this._lowercaseMap.delete(moduleId.toLowerCase());

    // Call onUnload if available
    const modObj = module as Record<string, unknown>;
    if (typeof modObj['onUnload'] === 'function') {
      try {
        (modObj['onUnload'] as () => void)();
      } catch (e) {
        console.warn(`[apcore:registry] onUnload failed for ${moduleId}:`, e);
      }
    }

    this._triggerEvent(REGISTRY_EVENTS.UNREGISTER, moduleId, module);
    return true;
  }

  /**
   * Look up a registered module by ID.
   *
   * @param moduleId - Module identifier (must be non-empty).
   * @param _versionHint - Optional semver range for multi-version coexistence
   *   (PROTOCOL_SPEC §5.4). This SDK currently exposes a single-version
   *   registry, so the hint is accepted for cross-language API parity with
   *   apcore-python (sync finding A-002) but does NOT participate in
   *   resolution: the latest registered module for `moduleId` is returned
   *   regardless of the hint. When multi-version registration lands, this
   *   parameter will gate semver-range matching.
   */
  get(moduleId: string, _versionHint?: string | null): unknown | null {
    if (moduleId === '') {
      throw new ModuleNotFoundError('');
    }
    return this._modules.get(moduleId) ?? null;
  }

  has(moduleId: string): boolean {
    return this._modules.has(moduleId);
  }

  list(options?: { tags?: string[]; prefix?: string }): string[] {
    let ids = [...this._modules.keys()];

    if (options?.prefix != null) {
      ids = ids.filter((id) => id.startsWith(options.prefix!));
    }

    if (options?.tags != null) {
      const tagSet = new Set(options.tags);
      ids = ids.filter((id) => {
        const mod = this._modules.get(id) as Record<string, unknown>;
        const modTags = new Set((mod['tags'] as string[]) ?? []);
        const metaTags = (this._moduleMeta.get(id) ?? {})['tags'];
        if (Array.isArray(metaTags)) {
          for (const t of metaTags) modTags.add(t as string);
        }
        for (const t of tagSet) {
          if (!modTags.has(t)) return false;
        }
        return true;
      });
    }

    return ids.sort();
  }

  iter(): IterableIterator<[string, unknown]> {
    return this._modules.entries();
  }

  get count(): number {
    return this._modules.size;
  }

  get moduleIds(): string[] {
    return [...this._modules.keys()].sort();
  }

  getDefinition(moduleId: string, _versionHint?: string | null): ModuleDescriptor | null {
    // `_versionHint` accepted for cross-language API parity with apcore-python
    // (sync finding A-002 / §5.4). Ignored under the single-version registry;
    // see `get()` for the rationale.
    //
    // D10-011: spec registry-system.md:382 says any error that `get(module_id)`
    // raises is propagated. The empty-string guard mirrors `get()` (line 669)
    // so callers using getDefinition see the same ModuleNotFoundError as
    // get(), matching apcore-python where getDefinition routes through get().
    if (moduleId === '') {
      throw new ModuleNotFoundError('');
    }
    const module = this._modules.get(moduleId);
    if (module == null) return null;
    // INVARIANT: every registration site (`register`, `registerInternal`,
    // `_discoverDefault`) populates `_moduleMeta` via `mergeModuleMetadata`,
    // so `meta` always contains the full set of canonical keys including
    // an `annotations` slot. Read fields directly from it. The schemas
    // come straight from the module instance because they are not part
    // of the merged metadata payload.
    const meta = this._moduleMeta.get(moduleId) ?? {};
    const mod = module as Record<string, unknown>;

    return {
      moduleId,
      name: (meta['name'] as string | null) ?? null,
      description: (meta['description'] as string) ?? '',
      documentation: (meta['documentation'] as string | null) ?? null,
      inputSchema: (mod['inputSchema'] as Record<string, unknown>) ?? {},
      outputSchema: (mod['outputSchema'] as Record<string, unknown>) ?? {},
      version: (meta['version'] as string) ?? '1.0.0',
      tags: (meta['tags'] as string[]) ?? [],
      annotations: (meta['annotations'] as ModuleAnnotations | null) ?? null,
      examples: (meta['examples'] as ModuleExample[]) ?? [],
      metadata: (meta['metadata'] as Record<string, unknown>) ?? {},
      sunsetDate: (meta['sunsetDate'] as string | null) ?? null,
    };
  }

  describe(moduleId: string): string {
    const module = this.get(moduleId);
    if (module === null) {
      throw new ModuleNotFoundError(moduleId);
    }

    // Check for custom describe method
    const modObj = module as Record<string, unknown>;
    if (typeof modObj['describe'] === 'function') {
      return (modObj['describe'] as () => string)();
    }

    // Auto-generate from descriptor
    const descriptor = this.getDefinition(moduleId);
    if (descriptor === null) {
      return `Module: ${moduleId}\n\nNo description available.`;
    }

    const lines: string[] = [`# ${descriptor.moduleId}`];
    if (descriptor.description) {
      lines.push(`\n${descriptor.description}`);
    }
    if (descriptor.tags.length > 0) {
      lines.push(`\n**Tags:** ${descriptor.tags.join(', ')}`);
    }
    const props = descriptor.inputSchema['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (props && Object.keys(props).length > 0) {
      lines.push('\n**Parameters:**');
      const requiredFields = (descriptor.inputSchema['required'] as string[]) ?? [];
      for (const [param, schema] of Object.entries(props)) {
        const paramType = (schema['type'] as string) ?? 'any';
        const paramDesc = (schema['description'] as string) ?? '';
        const isRequired = requiredFields.includes(param);
        const reqMarker = isRequired ? ' (required)' : '';
        lines.push(`- \`${param}\` (${paramType})${reqMarker}: ${paramDesc}`);
      }
    }
    if (descriptor.documentation) {
      lines.push(`\n**Documentation:**\n${descriptor.documentation}`);
    }
    return lines.join('\n');
  }

  on(event: string, callback: EventCallback): void {
    const validEvents = Object.values(REGISTRY_EVENTS) as string[];
    if (!validEvents.includes(event)) {
      throw new InvalidInputError(
        `Invalid event: ${event}. Must be one of: ${validEvents.map((e) => `'${e}'`).join(', ')}`,
      );
    }
    this._callbacks.get(event)!.push(callback);
  }

  off(event: string, callback: EventCallback): boolean {
    const validEvents = Object.values(REGISTRY_EVENTS) as string[];
    if (!validEvents.includes(event)) {
      throw new InvalidInputError(
        `Invalid event: ${event}. Must be one of: ${validEvents.map((e) => `'${e}'`).join(', ')}`,
      );
    }
    const callbacks = this._callbacks.get(event)!;
    const idx = callbacks.indexOf(callback);
    if (idx === -1) return false;
    callbacks.splice(idx, 1);
    return true;
  }

  async reload(): Promise<number> {
    return this.discover();
  }

  private _triggerEvent(event: string, moduleId: string, module: unknown): void {
    const callbacks = this._callbacks.get(event) ?? [];
    for (const cb of callbacks) {
      try {
        cb(moduleId, module);
      } catch (e) {
        console.warn(`[apcore:registry] Event callback error for '${event}' on ${moduleId}:`, e);
      }
    }
  }

  /**
   * Watch the configured extension roots for filesystem changes and
   * unregister any module whose source file is modified or deleted.
   *
   * **Cross-language divergence (sync finding A-D-104):** unlike apcore-python
   * (which re-imports the file via `importlib.reload`) and apcore-rust (which
   * triggers full rediscovery), the TypeScript SDK is **event-only**. On a
   * file change the registry:
   *   1. unregisters the previously-loaded module (calling its `onUnload`),
   *   2. emits a `'file_changed'` event with `{ filePath }` payload.
   *
   * Consumers are expected to subscribe and re-register the module
   * themselves (e.g. by calling `registry.discover()` or registering a fresh
   * import). ES module specifiers are immutable in Node — there is no
   * portable "reload from disk" primitive — so a transparent dynamic
   * `import()` would silently return the cached old module on every
   * invocation. A workaround using a cache-busting query (`?v=Date.now()`)
   * leaks the old module each reload and breaks browser bundlers, so it is
   * intentionally **not** offered here.
   *
   * If your application needs Python-style hot-reload semantics, listen for
   * `'file_changed'` and re-discover or re-import explicitly.
   */
  async watch(): Promise<void> {
    if (this._watchers && this._watchers.length > 0) {
      return; // Already watching
    }

    const { fs, path: nodePath } = await ensureNodeModules();
    const { join } = nodePath;

    this._watchers = [];
    this._debounceTimers = new Map<string, number>();

    for (const root of this._extensionRoots) {
      const rootPath = typeof root === "string" ? root : (root as Record<string, unknown>).root as string;
      if (!rootPath) continue;

      try {
        const watcher = fs.watch(rootPath, { recursive: true }, (eventType: string, filename: string | null) => {
          if (!filename) return;
          if (!filename.endsWith(".ts") && !filename.endsWith(".js")) return;

          const fullPath = join(rootPath, filename);
          const now = Date.now();
          const last = this._debounceTimers?.get(fullPath) ?? 0;
          if (now - last < 300) return;
          this._debounceTimers?.set(fullPath, now);

          const handle = (p: Promise<void>): void => {
            p.catch((e: unknown) => {
              console.warn(`[apcore:registry] Watch handler failed for ${fullPath}:`, e);
            });
          };

          if (eventType === "rename") {
            // Could be create or delete
            try {
              fs.accessSync(fullPath);
              handle(this._handleFileChange(fullPath));
            } catch {
              handle(this._handleFileDeletion(fullPath));
            }
          } else {
            handle(this._handleFileChange(fullPath));
          }
        });
        this._watchers.push(watcher);
      } catch (e) {
        // Surface real failures (EMFILE, EACCES, Linux kernels < 4.7 without
        // recursive support, etc.). A silently non-functional watch misleads
        // users who expect hot-reload to be active.
        console.warn(
          `[apcore:registry] fs.watch failed for '${rootPath}' — hot-reload disabled for this root:`,
          e,
        );
      }
    }
  }

  unwatch(): void {
    if (this._watchers) {
      for (const watcher of this._watchers) {
        watcher.close();
      }
      this._watchers = [];
    }
    this._debounceTimers = undefined;
  }

  private async _handleFileChange(filePath: string): Promise<void> {
    const { path: nodePath } = await ensureNodeModules();
    const { basename, extname } = nodePath;
    const moduleId = this._pathToModuleId(filePath);

    if (moduleId && this.has(moduleId)) {
      const oldModule = this.get(moduleId) as Record<string, unknown> | null;
      if (oldModule && typeof oldModule.onUnload === "function") {
        try {
          oldModule.onUnload();
        } catch (e) {
          console.warn(`[apcore:registry] onUnload failed for '${moduleId}':`, e);
        }
      }
      this.unregister(moduleId);
    }

    // Re-import is complex in ES modules — tell consumers that a watched file
    // changed so they can re-import and re-register. The earlier design
    // emitted a 'register' event with a null module, which crashed any
    // consumer that accessed fields on the module argument.
    this._triggerEvent(
      "file_changed",
      moduleId ?? basename(filePath, extname(filePath)),
      { filePath },
    );
  }

  private async _handleFileDeletion(path: string): Promise<void> {
    const moduleId = this._pathToModuleId(path);
    if (moduleId && this.has(moduleId)) {
      const module = this.get(moduleId) as Record<string, unknown> | null;
      if (module && typeof module.onUnload === "function") {
        try {
          module.onUnload();
        } catch (e) {
          console.warn(`[apcore:registry] onUnload failed for '${moduleId}':`, e);
        }
      }
      this.unregister(moduleId);
    }
  }

  private _pathToModuleId(filePath: string): string | null {
    // _nodePath is guaranteed loaded when this is called from watch/handleFile*
    const { basename, extname } = _nodePath!;
    const base = basename(filePath, extname(filePath));
    for (const mid of this.moduleIds) {
      if (mid.endsWith(base) || mid === base) {
        return mid;
      }
    }
    return null;
  }

  /**
   * Register a sys/internal module that bypasses **only** the reserved word
   * check. All other PROTOCOL_SPEC §2.7 validations (empty, EBNF pattern,
   * length, duplicate) still apply.
   *
   * Used exclusively by the sys-modules subsystem for `system.*` IDs.
   * Aligned with apcore-python `Registry.register_internal` and apcore-rust
   * `Registry::register_internal`.
   */
  registerInternal(moduleId: string, module: unknown): void {
    validateModuleId(moduleId, true);

    // D11-007: route duplicate detection through detectIdConflicts (with an
    // empty reserved-words set so the bypass for system.* prefixes is
    // preserved). This restores the case-collision branch present in
    // apcore-python (registry.py:1674) and apcore-rust (registry.rs:727).
    // The lowercase-only EBNF in validateModuleId makes case collisions
    // unreachable today, but the contract surface stays aligned across SDKs.
    const conflict = detectIdConflicts(
      moduleId,
      new Set(this._modules.keys()),
      new Set<string>(),
      this._lowercaseMap,
    );
    if (conflict !== null) {
      if (conflict.severity === 'error') {
        throw new InvalidInputError(conflict.message);
      } else {
        console.warn(`[apcore:registry] ID conflict: ${conflict.message}`);
      }
    }

    this._modules.set(moduleId, module);
    const modObj = module as Record<string, unknown>;
    this._moduleMeta.set(moduleId, mergeModuleMetadata(modObj, {}));
    // Mirror apcore-python register_internal and apcore-rust register_core:
    // every registration site (including sys/internal) populates the lowercase
    // index. The lowercase-only EBNF pattern enforced by validateModuleId makes
    // case collisions unreachable today, but keeping _lowercaseMap consistent
    // with _modules preserves the invariant for downstream conflict detection.
    this._lowercaseMap.set(moduleId.toLowerCase(), moduleId);

    if (typeof modObj['onLoad'] === 'function') {
      try {
        (modObj['onLoad'] as () => void)();
      } catch (e) {
        this._modules.delete(moduleId);
        this._moduleMeta.delete(moduleId);
        this._lowercaseMap.delete(moduleId.toLowerCase());
        throw e;
      }
    }

    this._triggerEvent(REGISTRY_EVENTS.REGISTER, moduleId, module);
  }

  /**
   * Export the JSON Schema for a registered module.
   *
   * Returns the schema as a plain object (`Record<string, unknown> | null`),
   * matching Python's `dict | None` and Rust's `Option<Value>` return types.
   * Returns `null` if the module is not registered.
   * Use the standalone `exportSchema` function from `schema-export.ts` for
   * serialized (JSON/YAML) output.
   */
  exportSchema(
    moduleId: string,
    strict: boolean = false,
  ): Record<string, unknown> | null {
    const schema = getSchema(this, moduleId);
    if (schema === null) return null;
    if (strict) {
      const result = deepCopy(schema) as Record<string, unknown>;
      result['input_schema'] = toStrictSchema(result['input_schema'] as Record<string, unknown>);
      result['output_schema'] = toStrictSchema(result['output_schema'] as Record<string, unknown>);
      return result;
    }
    return schema;
  }

  clearCache(): void {
    this._schemaCache.clear();
  }

  // ── Safe Hot-Reload (F09 / Algorithm A21) ───────────────────────

  /**
   * Discover module IDs for the classes in a single file under multi-class
   * mode (PROTOCOL_SPEC §2.1.1).
   *
   * D-15: cross-language alignment with Python `Registry.discover_multi_class`
   * and the Rust trait method. Internally delegates to the free function
   * {@link discoverMultiClass} (re-exported as `_discoverMultiClass` for
   * scanner internals), so behaviour is identical.
   *
   * **apcore decision-log D-06**: the per-class `ClassDescriptor.multiClass`
   * flag is the sole opt-in mechanism for multi-class discovery. When any
   * qualifying class sets `multiClass: true`, the discovery routine derives
   * a distinct module ID per class; otherwise whole-file mode is used.
   *
   * @param filePath - Source file path (relative to project root).
   * @param classes - Class descriptors; each may carry `multiClass: true`
   *   to opt into per-class module ID derivation.
   * @param extensionsRoot - Extensions root directory (defaults to
   *   `'extensions'`).
   *
   * **Deprecated 4-arg overload**: passing a `multiClassEnabled` boolean as
   * the fourth argument is retained for backward compatibility through one
   * minor release and will be removed in v0.22.0. The argument is now
   * functionally inert — the per-class `multiClass` field is the source of
   * truth. A one-shot deprecation notice is emitted on first use.
   */
  discoverMultiClass(
    filePath: string,
    classes: readonly import('./multi-class.js').ClassDescriptor[],
    extensionsRoot?: string,
  ): import('./multi-class.js').MultiClassEntry[];
  /** @deprecated Pass `multiClass: true` on each `ClassDescriptor` instead. The `multiClassEnabled` argument will be removed in v0.22.0. */
  discoverMultiClass(
    filePath: string,
    classes: readonly import('./multi-class.js').ClassDescriptor[],
    extensionsRoot: string,
    multiClassEnabled: boolean,
  ): import('./multi-class.js').MultiClassEntry[];
  discoverMultiClass(
    filePath: string,
    classes: readonly import('./multi-class.js').ClassDescriptor[],
    extensionsRoot: string = 'extensions',
    multiClassEnabled?: boolean,
  ): import('./multi-class.js').MultiClassEntry[] {
    if (multiClassEnabled !== undefined) {
      warnMultiClassEnabledDeprecated();
      // The argument is functionally inert under D-06: the per-class
      // `multiClass` field is the source of truth. We intentionally ignore
      // `multiClassEnabled` and recompute from the descriptors below.
    }
    const enabled = classes.some((c) => c.implementsModule && c.multiClass === true);
    return _discoverMultiClass(filePath, classes, extensionsRoot, enabled);
  }

  /**
   * Number of in-flight executions per module.
   */
  get refCount(): ReadonlyMap<string, number> {
    return new Map(this._refCounts);
  }

  /**
   * Acquire a reference to a module for execution.
   *
   * Increments the reference count. Throws ModuleNotFoundError if the
   * module is draining or not registered. Call {@link release} when done.
   */
  acquire(moduleId: string): unknown {
    if (this._draining.has(moduleId)) {
      throw new ModuleNotFoundError(moduleId);
    }
    const mod = this._modules.get(moduleId);
    if (mod == null) {
      throw new ModuleNotFoundError(moduleId);
    }
    this._refCounts.set(moduleId, (this._refCounts.get(moduleId) ?? 0) + 1);
    return mod;
  }

  /**
   * Release a previously acquired module reference.
   *
   * Decrements the reference count and notifies drain waiters when it
   * reaches zero.
   */
  release(moduleId: string): void {
    const current = this._refCounts.get(moduleId);
    if (current === undefined || current <= 0) return;
    const count = current - 1;
    if (count <= 0) {
      this._refCounts.delete(moduleId);
      const resolvers = this._drainResolvers.get(moduleId);
      if (resolvers) {
        for (const resolve of resolvers) resolve();
        this._drainResolvers.delete(moduleId);
      }
    } else {
      this._refCounts.set(moduleId, count);
    }
  }

  /**
   * Check whether a module is marked for unload (draining).
   */
  isDraining(moduleId: string): boolean {
    return this._draining.has(moduleId);
  }

  /**
   * Mark a module as draining so no new acquire() calls are accepted.
   */
  beginDrain(moduleId: string): void {
    this._draining.add(moduleId);
  }

  /**
   * Remove the draining mark and clean up drain state.
   *
   * If any waitDrained waiters are still pending (e.g., refCount briefly
   * hit zero and then a new acquire bumped it back up), resolve them first
   * so they do not wait for their individual timeouts before returning.
   */
  endDrain(moduleId: string): void {
    this._draining.delete(moduleId);
    const resolvers = this._drainResolvers.get(moduleId);
    if (resolvers) {
      for (const resolve of resolvers) resolve();
    }
    this._drainResolvers.delete(moduleId);
    this._refCounts.delete(moduleId);
  }

  /**
   * Wait until all in-flight executions of a module have completed.
   *
   * Returns a promise that resolves to `true` if the module drained
   * cleanly, or `false` if the timeout was reached.
   */
  waitDrained(moduleId: string, timeoutMs: number = 5000): Promise<boolean> {
    const current = this._refCounts.get(moduleId) ?? 0;
    if (current <= 0) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);

      const resolvers = this._drainResolvers.get(moduleId) ?? [];
      resolvers.push(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
      this._drainResolvers.set(moduleId, resolvers);
    });
  }

  /**
   * Safely unregister a module with cooperative drain.
   *
   * Marks the module as draining, waits for in-flight executions to
   * complete (up to timeoutMs), then unregisters the module.
   *
   * Returns true if drained cleanly, false if force-unloaded after timeout.
   */
  async safeUnregister(moduleId: string, timeoutMs: number = 5000): Promise<boolean> {
    if (!this._modules.has(moduleId)) return false;

    this.beginDrain(moduleId);
    const clean = await this.waitDrained(moduleId, timeoutMs);

    if (!clean) {
      console.warn(
        `[apcore:registry] Force-unloading module ${moduleId} after ${timeoutMs}ms timeout ` +
        `(${this._refCounts.get(moduleId) ?? 0} in-flight executions)`,
      );
    }

    this.endDrain(moduleId);
    this.unregister(moduleId);
    return clean;
  }
}
