/**
 * Configuration loading, validation, and environment variable overrides (Algorithm A12).
 * Supports legacy mode (flat YAML) and namespace mode (apcore top-level key).
 */

import yaml from 'js-yaml';
import {
  ConfigBindError,
  ConfigEnvMapConflictError,
  ConfigEnvPrefixConflictError,
  ConfigError,
  ConfigMountError,
  ConfigNamespaceDuplicateError,
  ConfigNamespaceReservedError,
  ConfigNotFoundError,
} from './errors.js';
import { jsonSchemaToTypeBox } from './schema/loader.js';
import { SchemaValidator } from './schema/validator.js';

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
try {
  _nodeFs = await import('node:fs');
} catch {
  /* browser environment */
}

let _nodeProcess: typeof import('node:process') | null = null;
try {
  _nodeProcess = await import('node:process');
} catch {
  /* browser environment */
}

let _nodePath: typeof import('node:path') | null = null;
try {
  _nodePath = await import('node:path');
} catch {
  /* browser environment */
}

let _nodeOs: typeof import('node:os') | null = null;
try {
  _nodeOs = await import('node:os');
} catch {
  /* browser environment */
}

/** Environment variable prefix for legacy overrides. */
const ENV_PREFIX = 'APCORE_';

/** Required configuration fields in legacy mode (dot-paths). */
const REQUIRED_FIELDS = [
  'version',
  'extensions.root',
  'schema.root',
  'acl.root',
  'acl.default_effect',
  'project.name',
] as const;

/** Field constraints in legacy mode: field -> [validator, errorMessage]. */
const CONSTRAINTS: Record<string, [(v: unknown) => boolean, string]> = {
  'acl.default_effect': [(v) => v === 'allow' || v === 'deny', "must be 'allow' or 'deny'"],
  'observability.tracing.sampling_rate': [
    (v) => typeof v === 'number' && v >= 0.0 && v <= 1.0,
    'must be a number in [0.0, 1.0]',
  ],
  'extensions.max_depth': [
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 16,
    'must be an integer in [1, 16]',
  ],
  'executor.default_timeout': [
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
    'must be a non-negative integer (milliseconds)',
  ],
  'executor.global_timeout': [
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
    'must be a non-negative integer (milliseconds)',
  ],
  'executor.max_call_depth': [
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
    'must be a positive integer',
  ],
  'executor.max_module_repeat': [
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
    'must be a positive integer',
  ],
};

/**
 * Default configuration values for legacy mode.
 *
 * NOTE: `version` is the frozen baseline for legacy-mode configs (those that
 * omit an explicit `version` field). It identifies the spec version whose
 * semantics legacy mode parses against, NOT the current SDK version. Do not
 * bump this with each spec MINOR — only when legacy-mode parsing semantics
 * actually change.
 */
const DEFAULTS: Record<string, unknown> = {
  version: '0.16.0',
  extensions: {
    root: './extensions',
    auto_discover: true,
    max_depth: 8,
    follow_symlinks: false,
  },
  schema: {
    root: './schemas',
    strategy: 'yaml_first',
    max_ref_depth: 32,
  },
  acl: {
    root: './acl',
    default_effect: 'deny',
  },
  executor: {
    default_timeout: 30000,
    global_timeout: 60000,
    max_call_depth: 32,
    max_module_repeat: 3,
  },
  observability: {
    tracing: {
      enabled: false,
      sampling_rate: 1.0,
    },
    metrics: {
      enabled: false,
    },
  },
  project: {
    name: 'apcore',
  },
  sys_modules: {
    enabled: false,
  },
  stream: {
    max_merge_depth: 32,
  },
};

/**
 * Single source of truth for default values.
 * Components MUST use this instead of hardcoding defaults.
 */
export function getDefault(key: string, fallback?: unknown): unknown {
  const parts = key.split('.');
  let node: unknown = DEFAULTS;
  for (const part of parts) {
    if (node != null && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return fallback;
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Namespace registry (module-level singletons)
// ---------------------------------------------------------------------------

export type EnvStyle = 'nested' | 'flat' | 'auto';

const DEFAULT_MAX_DEPTH = 5;

interface NamespaceRegistration {
  name: string;
  schema: object | string | null;
  envPrefix: string; // auto-derived or explicit (never null after registration)
  defaults: Record<string, unknown> | null;
  envStyle: EnvStyle;
  maxDepth: number;
  envMap: Record<string, string> | null;
}

export const _globalNsRegistry = new Map<string, NamespaceRegistration>();
const _RESERVED_NAMESPACES = new Set(['apcore', '_config']);
export const _globalEnvMap = new Map<string, string>(); // bare env var → top-level key
export const _envMapClaimed = new Map<string, string>(); // env var → owner (conflict detection)
export const _envPrefixUsed = new Set<string>();

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function deepMergeDicts(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = deepMergeDicts(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getNested(
  data: Record<string, unknown>,
  dotPath: string,
  defaultValue?: unknown,
): unknown {
  const parts = dotPath.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (
      current !== null &&
      typeof current === 'object' &&
      part in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return defaultValue;
    }
  }
  return current;
}

function setNested(data: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current = data;
  for (const part of parts.slice(0, -1)) {
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function coerceEnvValue(value: string): unknown {
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  const asInt = parseInt(value, 10);
  if (!isNaN(asInt) && String(asInt) === value) return asInt;
  const asFloat = parseFloat(value);
  if (!isNaN(asFloat) && String(asFloat) === value) return asFloat;
  return value;
}

export function applyEnvOverrides(data: Record<string, unknown>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const env = _nodeProcess?.env ?? {};
  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey.startsWith(ENV_PREFIX) || envValue === undefined) continue;
    const suffix = envKey.slice(ENV_PREFIX.length);
    if (!suffix) continue;
    // Convert: single _ -> . (separator), double __ -> literal _
    const dotPath = suffix
      .toLowerCase()
      .replace(/__/g, '\x00')
      .replace(/_/g, '.')
      .replace(/\x00/g, '_');
    setNested(result, dotPath, coerceEnvValue(envValue));
  }
  return result;
}

/**
 * Apply per-namespace env overrides using longest-prefix-match dispatch.
 *
 * For each env var, finds the registered namespace whose envPrefix is the
 * longest matching prefix, strips it, converts separators, and writes to
 * that namespace's subtree in data.
 */
/**
 * Convert env var suffix to dot-path with a depth limit.
 * After max_depth segments, remaining _ are preserved as literal.
 * Double __ always becomes literal _.
 */
export function envSuffixToDotPathWithDepth(suffix: string, maxDepth: number): string {
  const lower = suffix.toLowerCase();
  const result: string[] = [];
  let dotCount = 0;
  let i = 0;
  while (i < lower.length) {
    if (lower[i] === '_') {
      if (i + 1 < lower.length && lower[i + 1] === '_') {
        result.push('_'); // double __ → literal _
        i += 2;
      } else if (dotCount < maxDepth - 1) {
        // Stop at maxDepth segments (maxDepth - 1 dots)
        result.push('.');
        dotCount++;
        i++;
      } else {
        result.push('_'); // depth limit reached
        i++;
      }
    } else {
      result.push(lower[i]);
      i++;
    }
  }
  return result.join('').replace(/^\.+|\.+$/g, '');
}

/**
 * Try to match suffix against keys in tree (recursive).
 * Returns resolved dot-path or null if no match.
 */
function matchSuffixToTree(
  suffix: string,
  tree: Record<string, unknown>,
  depth: number,
  maxDepth: number,
): string | null {
  // 1. Try full suffix as a flat key.
  if (suffix in tree) return suffix;

  // 2. Depth limit reached.
  if (depth >= maxDepth - 1) return null;

  // 3. Try splitting at each underscore position.
  for (let i = 1; i < suffix.length - 1; i++) {
    if (suffix[i] !== '_') continue;
    const prefix = suffix.slice(0, i);
    const remainder = suffix.slice(i + 1);
    const subtree = tree[prefix];
    if (subtree !== null && typeof subtree === 'object' && !Array.isArray(subtree)) {
      const sub = matchSuffixToTree(
        remainder,
        subtree as Record<string, unknown>,
        depth + 1,
        maxDepth,
      );
      if (sub !== null) return prefix + '.' + sub;
    }
  }
  return null;
}

/**
 * Resolve env var suffix to a config key using auto mode.
 * Matches against defaults tree, falls back to nested conversion.
 */
function autoResolveSuffix(
  suffix: string,
  defaults: Record<string, unknown> | null,
  maxDepth: number,
): string {
  const lower = suffix.toLowerCase();
  if (defaults === null) return envSuffixToDotPathWithDepth(lower, maxDepth);
  const result = matchSuffixToTree(lower, defaults, 0, maxDepth);
  if (result !== null) return result;
  return envSuffixToDotPathWithDepth(lower, maxDepth);
}

/**
 * Resolve env var suffix to { key, isNested } based on registration env_style.
 */
function resolveEnvSuffix(
  suffix: string,
  reg: NamespaceRegistration,
): { key: string; isNested: boolean } {
  if (reg.envStyle === 'flat') {
    const key = suffix.toLowerCase().replace(/__/g, '_').replace(/^_/, '');
    return { key, isNested: false };
  }
  if (reg.envStyle === 'auto') {
    const key = autoResolveSuffix(suffix, reg.defaults, reg.maxDepth);
    return { key, isNested: key.includes('.') };
  }
  // nested (default)
  const key = envSuffixToDotPathWithDepth(suffix, reg.maxDepth);
  return { key, isNested: true };
}

export function applyNamespaceEnvOverrides(data: Record<string, unknown>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const env = _nodeProcess?.env ?? {};

  // Sort registrations by envPrefix length descending (longest first)
  const registrations = Array.from(_globalNsRegistry.values())
    .filter((r) => r.envPrefix)
    .sort((a, b) => b.envPrefix.length - a.envPrefix.length);

  for (const [envKey, envValue] of Object.entries(env)) {
    if (envValue === undefined) continue;
    const coerced = coerceEnvValue(envValue);

    // 1. Global env_map (bare env var → top-level key).
    if (_globalEnvMap.has(envKey)) {
      const configKey = _globalEnvMap.get(envKey)!;
      setNested(result, configKey, coerced);
      continue;
    }

    // 2. Namespace env_map (bare env var → namespace key).
    // ... search in all registered namespaces ...
    let handledByNsMap = false;
    for (const reg of _globalNsRegistry.values()) {
      if (reg.envMap && envKey in reg.envMap) {
        const configKey = reg.envMap[envKey];
        if (typeof result[reg.name] !== 'object' || result[reg.name] === null) {
          result[reg.name] = {};
        }
        setNested(result[reg.name] as Record<string, unknown>, configKey, coerced);
        handledByNsMap = true;
        break;
      }
    }
    if (handledByNsMap) continue;

    // 3. Prefix-based dispatch.
    for (const reg of registrations) {
      if (envKey.startsWith(reg.envPrefix)) {
        let suffix = envKey.slice(reg.envPrefix.length);
        if (!suffix) continue;
        // Strip leading _ separator between prefix and suffix
        if (suffix.startsWith('_')) suffix = suffix.slice(1);
        if (!suffix) continue;

        const { key, isNested } = resolveEnvSuffix(suffix, reg);
        if (!key) continue;

        if (typeof result[reg.name] !== 'object' || result[reg.name] === null) {
          result[reg.name] = {};
        }

        if (isNested) {
          setNested(result[reg.name] as Record<string, unknown>, key, coerced);
        } else {
          (result[reg.name] as Record<string, unknown>)[key] = coerced;
        }
        break;
      }
    }
  }
  return result;
}

/**
 * Resolve the namespace from a dot-path like "apcore-mcp.transport".
 * The namespace portion may contain hyphens, so we cannot simply split on ".".
 * We match against known registered namespaces (longest match first).
 */
function resolveNamespacePath(key: string): { namespace: string; subPath: string } | null {
  // Sort known namespaces by length descending for longest-match
  const knownNamespaces = Array.from(_globalNsRegistry.keys())
    .concat(Array.from(_RESERVED_NAMESPACES))
    .sort((a, b) => b.length - a.length);

  for (const ns of knownNamespaces) {
    if (key === ns) {
      return { namespace: ns, subPath: '' };
    }
    if (key.startsWith(ns + '.')) {
      return { namespace: ns, subPath: key.slice(ns.length + 1) };
    }
  }

  // Fallback: use naive first-segment split
  const dotIndex = key.indexOf('.');
  if (dotIndex === -1) {
    return { namespace: key, subPath: '' };
  }
  return { namespace: key.slice(0, dotIndex), subPath: key.slice(dotIndex + 1) };
}

// ---------------------------------------------------------------------------
// Config discovery (§9.14)
// ---------------------------------------------------------------------------

/**
 * Search for a config file in the standard discovery order (§9.14).
 * Returns the path of the first found file, or null if none found.
 */
export function discoverConfigFile(): string | null {
  const env = _nodeProcess?.env ?? {};
  const existsSync = _nodeFs?.existsSync;
  const join = _nodePath?.join;
  const homedir = _nodeOs?.homedir;

  if (!existsSync || !join || !homedir) return null;

  const envPath = env['APCORE_CONFIG_FILE'];
  if (envPath) return envPath;

  const cwdCandidates = ['project.yaml', 'project.yml', 'apcore.yaml', 'apcore.yml'];
  for (const name of cwdCandidates) {
    if (existsSync(name)) return name;
  }

  const home = homedir();
  // W-10: Use lazy-loaded _nodeProcess so this works in non-Node environments.
  const xdgConfig =
    (_nodeProcess?.platform ?? 'linux') === 'darwin'
      ? join(home, 'Library', 'Application Support', 'apcore', 'config.yaml')
      : join(home, '.config', 'apcore', 'config.yaml');
  if (existsSync(xdgConfig)) return xdgConfig;

  const legacy = join(home, '.apcore', 'config.yaml');
  if (existsSync(legacy)) return legacy;

  return null;
}

// ---------------------------------------------------------------------------
// Config class
// ---------------------------------------------------------------------------

/**
 * Configuration system with YAML loading, env overrides, and validation.
 *
 * Merge priority (highest wins): environment variables > mount data > config file > namespace defaults > defaults.
 *
 * Two modes:
 * - Legacy mode: top-level YAML has no "apcore" key. Backward compatible.
 * - Namespace mode: top-level YAML has "apcore" key. Enables namespace features.
 *
 * Backward compatible: `new Config(data)` still works for in-memory configuration.
 */
export class Config {
  private _data: Record<string, unknown>;
  private _yamlPath: string | null = null;
  private _mode: 'legacy' | 'namespace' = 'legacy';
  private _mounts: Map<string, Record<string, unknown>> = new Map();

  constructor(data?: Record<string, unknown>, _envStyle: EnvStyle = 'auto') {
    this._data = data ?? {};
  }

  // -------------------------------------------------------------------------
  // Static namespace registry methods
  // -------------------------------------------------------------------------

  /** Returns true if the current environment is a browser (filesystem not available). */
  static isBrowser(): boolean {
    return _nodeFs === null;
  }

  /**
   * Register a namespace globally.
   *
   * Throws:
   * - ConfigNamespaceReservedError if name is in the reserved set.
   * - ConfigNamespaceDuplicateError if name is already registered.
   * - ConfigEnvPrefixConflictError if envPrefix is already used or matches the
   *   an already-registered prefix.
   */
  static registerNamespace(options: {
    name: string;
    schema?: object | string | null;
    envPrefix?: string | null;
    defaults?: Record<string, unknown> | null;
    envStyle?: EnvStyle | null;
    maxDepth?: number | null;
    envMap?: Record<string, string> | null;
  }): void {
    const {
      name,
      schema = null,
      envPrefix: rawEnvPrefix = null,
      defaults = null,
      envStyle: rawEnvStyle = null,
      maxDepth: rawMaxDepth = null,
      envMap = null,
    } = options;
    const envStyle: EnvStyle = rawEnvStyle ?? 'auto';
    if (envStyle !== 'nested' && envStyle !== 'flat' && envStyle !== 'auto') {
      throw new Error(`envStyle must be 'nested', 'flat', or 'auto', got '${envStyle as string}'`);
    }
    const maxDepth = rawMaxDepth ?? DEFAULT_MAX_DEPTH;
    const envPrefix = rawEnvPrefix ?? name.toUpperCase().replace(/-/g, '_');

    if (_RESERVED_NAMESPACES.has(name)) {
      throw new ConfigNamespaceReservedError(name);
    }
    if (_globalNsRegistry.has(name)) {
      throw new ConfigNamespaceDuplicateError(name);
    }
    if (_envPrefixUsed.has(envPrefix)) {
      throw new ConfigEnvPrefixConflictError(envPrefix);
    }

    // Validate env_map: no env var can be claimed twice.
    if (envMap !== null) {
      for (const envVar of Object.keys(envMap)) {
        if (_envMapClaimed.has(envVar)) {
          throw new ConfigEnvMapConflictError(envVar, _envMapClaimed.get(envVar)!);
        }
      }
      for (const envVar of Object.keys(envMap)) {
        _envMapClaimed.set(envVar, name);
      }
    }

    _globalNsRegistry.set(name, { name, schema, envPrefix, defaults, envStyle, maxDepth, envMap });
    _envPrefixUsed.add(envPrefix);
  }

  /**
   * Register global bare env var → top-level config key mappings.
   */
  static envMap(mapping: Record<string, string>): void {
    for (const envVar of Object.keys(mapping)) {
      if (_envMapClaimed.has(envVar)) {
        throw new ConfigEnvMapConflictError(envVar, _envMapClaimed.get(envVar)!);
      }
    }
    for (const [envVar, configKey] of Object.entries(mapping)) {
      _globalEnvMap.set(envVar, configKey);
      _envMapClaimed.set(envVar, '__global__');
    }
  }

  /**
   * Return a snapshot of all registered namespaces.
   */
  static registeredNamespaces(): Array<{
    name: string;
    envPrefix: string | null;
    hasSchema: boolean;
  }> {
    return Array.from(_globalNsRegistry.values()).map((r) => ({
      name: r.name,
      envPrefix: r.envPrefix,
      hasSchema: r.schema !== null,
    }));
  }

  // -------------------------------------------------------------------------
  // Static factory methods
  // -------------------------------------------------------------------------

  /**
   * Load configuration from a YAML file with env overrides.
   *
   * Auto-detects mode:
   * - Namespace mode: top-level "apcore" key present.
   * - Legacy mode: otherwise (backward compatible).
   */
  static load(yamlPath?: string, options?: { validate?: boolean }): Config {
    if (yamlPath === undefined || yamlPath === null) {
      const found = discoverConfigFile();
      if (found === null) return Config.fromDefaults();
      yamlPath = found;
    }

    // C-5: Guard against non-Node environments where fs may not be available.
    if (_nodeFs === null) {
      throw new ConfigError(`Cannot load config file '${yamlPath}': filesystem not available`);
    }
    const { existsSync, readFileSync } = _nodeFs;
    if (!existsSync(yamlPath)) {
      throw new ConfigNotFoundError(yamlPath);
    }

    let fileData: unknown;
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      fileData = yaml.load(content);
    } catch (e) {
      if (e instanceof ConfigNotFoundError) throw e;
      throw new ConfigError(`Invalid YAML in ${yamlPath}: ${e}`);
    }

    if (fileData === null || fileData === undefined) {
      fileData = {};
    }
    if (typeof fileData !== 'object' || Array.isArray(fileData)) {
      throw new ConfigError(`Config file must be a mapping, got ${typeof fileData}`);
    }

    const rawData = fileData as Record<string, unknown>;
    // Namespace mode requires "apcore" key to be an object/mapping — not null, scalar, or array.
    const apcoreValue = rawData['apcore'];
    const isNamespaceMode =
      apcoreValue !== null &&
      apcoreValue !== undefined &&
      typeof apcoreValue === 'object' &&
      !Array.isArray(apcoreValue);

    let config: Config;

    if (isNamespaceMode) {
      // Namespace mode: apply namespace defaults, file data, then env overrides
      let merged: Record<string, unknown> = {};

      // Apply namespace defaults first
      for (const reg of _globalNsRegistry.values()) {
        if (reg.defaults !== null) {
          merged[reg.name] = JSON.parse(JSON.stringify(reg.defaults));
        }
      }

      // Merge file data over defaults
      merged = deepMergeDicts(merged, rawData);

      // Apply namespace-aware env overrides
      merged = applyNamespaceEnvOverrides(merged);

      config = new Config(merged);
      config._mode = 'namespace';
    } else {
      // Legacy mode: merge defaults < file < env
      let merged = deepMergeDicts(DEFAULTS, rawData);
      merged = applyEnvOverrides(merged);
      config = new Config(merged);
      config._mode = 'legacy';
    }

    config._yamlPath = yamlPath;

    if (options?.validate !== false) {
      config.validate();
    }

    return config;
  }

  /** Create a Config from default values with env overrides applied. */
  static fromDefaults(): Config {
    const data = applyEnvOverrides({ ...DEFAULTS });
    return new Config(data);
  }

  /**
   * Discover and load the project's config file using the canonical search
   * order, falling back to defaults when no file is found.
   *
   * Search order matches `discoverConfigFile()` and apcore-python /
   * apcore-rust:
   *   1. `$APCORE_CONFIG_FILE`
   *   2. `./project.yaml`, `./project.yml`, `./apcore.yaml`, `./apcore.yml`
   *   3. XDG config dir (`~/Library/Application Support/apcore/config.yaml`
   *      on macOS, `~/.config/apcore/config.yaml` elsewhere)
   *   4. Legacy `~/.apcore/config.yaml`
   *   5. `Config.fromDefaults()` if no file found
   *
   * Equivalent to apcore-rust's `Config::discover()` and to apcore-python's
   * `Config.load(path=None)` no-arg form (sync finding A-004).
   */
  static discover(options?: { validate?: boolean }): Config {
    const path = discoverConfigFile();
    if (path === null) return Config.fromDefaults();
    return Config.load(path, options);
  }

  // -------------------------------------------------------------------------
  // Instance methods
  // -------------------------------------------------------------------------

  /** Get a configuration value by dot-path key. */
  get(key: string, defaultValue?: unknown): unknown {
    if (this._mode === 'namespace') {
      const resolved = resolveNamespacePath(key);
      if (resolved === null) return defaultValue;
      const nsData = this._data[resolved.namespace];
      if (nsData === undefined || nsData === null) {
        // §9.9.1: Fallback to implicit "apcore" namespace if no registered namespace matches.
        if (resolved.namespace !== 'apcore') {
          return this.get(`apcore.${key}`, defaultValue);
        }
        return defaultValue;
      }
      if (!resolved.subPath) return nsData;
      return getNested(nsData as Record<string, unknown>, resolved.subPath, defaultValue);
    }
    return getNested(this._data, key, defaultValue);
  }

  /** Set a configuration value by dot-path key. */
  set(key: string, value: unknown): void {
    if (this._mode === 'namespace') {
      const resolved = resolveNamespacePath(key);
      if (resolved === null) {
        setNested(this._data, key, value);
        return;
      }
      if (!resolved.subPath) {
        this._data[resolved.namespace] = value;
        return;
      }
      if (
        typeof this._data[resolved.namespace] !== 'object' ||
        this._data[resolved.namespace] === null
      ) {
        this._data[resolved.namespace] = {};
      }
      setNested(this._data[resolved.namespace] as Record<string, unknown>, resolved.subPath, value);
      return;
    }
    setNested(this._data, key, value);
  }

  /** Return a deep copy of the raw config data. */
  get data(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this._data));
  }

  /** Return the detected mode: 'legacy' or 'namespace'. */
  get mode(): 'legacy' | 'namespace' {
    return this._mode;
  }

  /**
   * Attach external config data to a namespace.
   *
   * Exactly one of fromFile or fromDict must be provided.
   * Throws ConfigMountError if namespace is "_config" or file not found.
   */
  mount(
    namespace: string,
    options: { fromFile?: string; fromDict?: Record<string, unknown> },
  ): void {
    if (namespace === '_config') {
      throw new ConfigMountError("Cannot mount to reserved namespace '_config'");
    }

    const { fromFile, fromDict } = options;
    const hasFile = fromFile !== undefined;
    const hasDict = fromDict !== undefined;

    if (hasFile && hasDict) {
      throw new ConfigMountError("Specify exactly one of 'fromFile' or 'fromDict', not both");
    }
    if (!hasFile && !hasDict) {
      throw new ConfigMountError("One of 'fromFile' or 'fromDict' is required");
    }

    let mountData: Record<string, unknown>;

    if (hasFile) {
      if (_nodeFs === null) {
        throw new ConfigMountError('Cannot mount from file: filesystem not available');
      }
      const { existsSync, readFileSync } = _nodeFs;
      if (!existsSync(fromFile!)) {
        throw new ConfigMountError(`Mount file not found: ${fromFile}`);
      }
      let parsed: unknown;
      try {
        const content = readFileSync(fromFile!, 'utf-8');
        parsed = yaml.load(content);
      } catch (e) {
        throw new ConfigMountError(`Failed to parse mount file '${fromFile}': ${e}`);
      }
      if (parsed === null || parsed === undefined) {
        parsed = {};
      }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigMountError(`Mount file must be a YAML mapping: ${fromFile}`);
      }
      mountData = parsed as Record<string, unknown>;
    } else {
      mountData = fromDict!;
    }

    this._mounts.set(namespace, mountData);

    // Merge mount data into namespace subtree
    const existing = (this._data[namespace] ?? {}) as Record<string, unknown>;
    this._data[namespace] = deepMergeDicts(existing, mountData);
  }

  /**
   * Return a deep copy of a namespace subtree.
   */
  namespace(name: string): Record<string, unknown> {
    const subtree = this._data[name];
    if (subtree === undefined || subtree === null) {
      return {};
    }
    return JSON.parse(JSON.stringify(subtree)) as Record<string, unknown>;
  }

  /**
   * Typed get with coercion and validation.
   * Applies the coerce function to the raw value and returns the result.
   * Throws ConfigError if the raw value is undefined.
   */
  getTyped<T>(path: string, coerce: (v: unknown) => T): T {
    const value = this.get(path);
    if (value === undefined) {
      throw new ConfigError(`Missing required config path: '${path}'`);
    }
    return coerce(value);
  }

  /**
   * Deserialize a namespace subtree into a class instance.
   * The schema constructor receives the namespace data as a plain object.
   * Throws ConfigBindError if instantiation fails.
   */
  bind<T>(namespace: string, schema: new (data: Record<string, unknown>) => T): T {
    const data = this.namespace(namespace);
    try {
      return new schema(data);
    } catch (e) {
      throw new ConfigBindError(`Failed to bind namespace '${namespace}': ${e}`);
    }
  }

  /**
   * Validate the configuration per Algorithm A12.
   *
   * In legacy mode: checks required fields, type constraints, and semantic rules.
   * In namespace mode (A12-NS): validates data.apcore; throws on unknown namespaces
   * if strict mode is enabled via data._config.strict.
   * Collects all errors before raising.
   */
  validate(): void {
    if (this._mode === 'namespace') {
      this._validateNamespaceMode();
      return;
    }

    const errors: string[] = [];

    // 1. Required field check
    for (const field of REQUIRED_FIELDS) {
      const value = getNested(this._data, field);
      if (value === undefined || value === null) {
        errors.push(`Missing required field: '${field}'`);
      }
    }

    // 2. Constraint validation
    for (const [field, [checkFn, errMsg]] of Object.entries(CONSTRAINTS)) {
      const value = getNested(this._data, field);
      if (value !== undefined && value !== null && !checkFn(value)) {
        errors.push(`Invalid value for '${field}': ${errMsg} (got ${JSON.stringify(value)})`);
      }
    }

    if (errors.length > 0) {
      throw new ConfigError(
        `Configuration validation failed (${errors.length} error(s)):\n` +
          errors.map((e) => `  - ${e}`).join('\n'),
      );
    }
  }

  private _validateNamespaceMode(): void {
    const errors: string[] = [];

    const apcore = this._data['apcore'];
    if (apcore !== undefined && apcore !== null) {
      // Run A12 checks on data.apcore subtree
      const apcoreData = apcore as Record<string, unknown>;
      for (const [field, [checkFn, errMsg]] of Object.entries(CONSTRAINTS)) {
        const value = getNested(apcoreData, field);
        if (value !== undefined && value !== null && !checkFn(value)) {
          errors.push(
            `Invalid value for 'apcore.${field}': ${errMsg} (got ${JSON.stringify(value)})`,
          );
        }
      }
    }

    // Per-namespace schema validation (sync finding A-D-021).
    // Each registered namespace with a non-null schema validates its data subtree
    // against that schema. Mirrors apcore-python's _validate_namespace_schema.
    // Errors accumulate before raising so all problems surface in one ConfigError.
    for (const reg of _globalNsRegistry.values()) {
      if (reg.schema === null) continue;
      const nsData = this._data[reg.name];
      if (nsData === undefined || nsData === null) continue;

      const loadedSchema = this._loadNamespaceSchema(reg.name, reg.schema);
      if (loadedSchema === null) continue; // unresolved file path → warn-and-skip

      const issues = this._validateAgainstJsonSchema(reg.name, nsData, loadedSchema);
      errors.push(...issues);
    }

    if (errors.length > 0) {
      throw new ConfigError(
        `Configuration validation failed (${errors.length} error(s)):\n` +
          errors.map((e) => `  - ${e}`).join('\n'),
      );
    }

    // Strict mode: reject unknown namespaces
    const configMeta = this._data['_config'];
    const isStrict =
      configMeta !== null &&
      typeof configMeta === 'object' &&
      (configMeta as Record<string, unknown>)['strict'] === true;

    if (isStrict) {
      const knownKeys = new Set([...Array.from(_globalNsRegistry.keys()), 'apcore', '_config']);
      for (const key of Object.keys(this._data)) {
        if (!knownKeys.has(key)) {
          throw new ConfigError(`Unknown namespace '${key}' in strict mode`);
        }
      }
    }
  }

  /**
   * Resolve a namespace's `schema` registration into a JSON-schema dict.
   *
   * Accepts either an inline object or a filesystem path to a JSON file.
   * Path resolution failures emit a warning and return null (no validation
   * is performed for that namespace), mirroring apcore-python's
   * `_validate_namespace_schema` warn-and-skip behavior on missing files.
   */
  private _loadNamespaceSchema(
    namespace: string,
    schema: object | string,
  ): Record<string, unknown> | null {
    if (typeof schema === 'object' && schema !== null) {
      return schema as Record<string, unknown>;
    }
    if (typeof schema === 'string') {
      try {
        // Avoid eager top-level `node:fs` import — file-mode schemas are uncommon
        // and the dynamic require keeps the browser bundle clean.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        if (!fs.existsSync(schema)) {
          console.warn(
            `[apcore:config] Schema file for namespace '${namespace}' not found: ${schema}`,
          );
          return null;
        }
        const raw = fs.readFileSync(schema, 'utf-8');
        return JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        console.warn(
          `[apcore:config] Failed to load schema file for namespace '${namespace}': ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }
    }
    return null;
  }

  /**
   * Validate `data` against a JSON-schema dict. Returns a list of human-readable
   * error messages prefixed with the namespace name; empty array on success.
   *
   * Uses the existing `SchemaValidator` (TypeBox-backed) by converting the JSON
   * schema via `jsonSchemaToTypeBox`. Any conversion failure is treated as an
   * accept-all (with a warning) so an unsupported schema feature does not block
   * `validate()`.
   */
  private _validateAgainstJsonSchema(
    namespace: string,
    data: unknown,
    schema: Record<string, unknown>,
  ): string[] {
    let typeBoxSchema;
    try {
      typeBoxSchema = jsonSchemaToTypeBox(schema);
    } catch (e) {
      console.warn(
        `[apcore:config] Could not convert schema for namespace '${namespace}' to TypeBox; skipping validation: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }

    const validator = new SchemaValidator(/* coerceTypes */ false);
    const result = validator.validate(data as Record<string, unknown>, typeBoxSchema);
    if (result.valid) return [];
    return result.errors.map(
      (err) =>
        `Namespace '${namespace}' failed schema validation at '${err.path || '/'}': ${err.message}`,
    );
  }

  /**
   * Re-read configuration from the original YAML file.
   * Only works if the Config was created via Config.load().
   * In namespace mode, re-applies namespace defaults, env overrides, and mount data.
   */
  reload(): void {
    if (this._yamlPath === null) {
      throw new ConfigError('Cannot reload: Config was not loaded from a YAML file');
    }
    const previousMounts = new Map(this._mounts);
    const reloaded = Config.load(this._yamlPath, { validate: false });
    this._data = reloaded._data;
    this._mode = reloaded._mode;
    this._mounts = new Map();

    // Re-apply mounts
    for (const [namespace, mountData] of previousMounts) {
      this.mount(namespace, { fromDict: mountData });
    }

    // Re-apply namespace env overrides in namespace mode
    if (this._mode === 'namespace') {
      this._data = applyNamespaceEnvOverrides(this._data);
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: register apcore built-in namespaces (§9.15)
// ---------------------------------------------------------------------------

// W-13: Use snake_case keys to match Python defaults and YAML config conventions.
// camelCase keys would silently diverge from cross-language YAML configs.
Config.registerNamespace({
  name: 'observability',
  envPrefix: 'APCORE_OBSERVABILITY',
  defaults: {
    tracing: {
      enabled: false,
      strategy: 'full',
      sampling_rate: 1.0,
      exporter: 'stdout',
      otlp_endpoint: null,
    },
    metrics: { enabled: false, exporter: 'stdout' },
    logging: { enabled: true, level: 'info', format: 'json', redact_sensitive: true },
    redaction: {
      // Issue #43 §5 — runtime-configurable redaction.
      // Empty arrays here mean "use library defaults" (see
      // DEFAULT_REDACTION_FIELD_PATTERNS in observability/context-logger.ts).
      field_patterns: [] as string[],
      value_patterns: [] as string[],
      replacement: '***REDACTED***',
    },
    error_history: { max_entries_per_module: 50, max_total_entries: 1000 },
    platform_notify: {
      enabled: false,
      error_rate_threshold: 0.1,
      latency_p99_threshold_ms: 5000.0,
    },
  },
});

Config.registerNamespace({
  name: 'sys_modules',
  envPrefix: 'APCORE_SYS',
  defaults: {
    enabled: true,
    health: { enabled: true },
    manifest: { enabled: true },
    usage: { enabled: true, retention_hours: 168, bucketing_strategy: 'hourly' },
    control: { enabled: true },
    events: { enabled: false, thresholds: { error_rate: 0.1, latency_p99_ms: 5000.0 } },
  },
});
