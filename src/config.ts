/**
 * Configuration loading, validation, and environment variable overrides (Algorithm A12).
 */

import yaml from 'js-yaml';
import { ConfigError, ConfigNotFoundError } from './errors.js';

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
try { _nodeFs = await import('node:fs'); } catch { /* browser environment */ }

let _nodeProcess: typeof import('node:process') | null = null;
try { _nodeProcess = await import('node:process'); } catch { /* browser environment */ }

/** Environment variable prefix for overrides. */
const ENV_PREFIX = 'APCORE_';

/** Required configuration fields (dot-paths). */
const REQUIRED_FIELDS = [
  'version',
  'extensions.root',
  'schema.root',
  'acl.root',
  'acl.default_effect',
  'project.name',
] as const;

/** Field constraints: field -> [validator, errorMessage]. */
const CONSTRAINTS: Record<string, [(v: unknown) => boolean, string]> = {
  'acl.default_effect': [
    (v) => v === 'allow' || v === 'deny',
    "must be 'allow' or 'deny'",
  ],
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

/** Default configuration values. */
const DEFAULTS: Record<string, unknown> = {
  version: '0.8.0',
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
};

function deepMergeDicts(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key]) &&
      typeof value === 'object' && value !== null && !Array.isArray(value)
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

function getNested(data: Record<string, unknown>, dotPath: string, defaultValue?: unknown): unknown {
  const parts = dotPath.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current !== null && typeof current === 'object' && part in (current as Record<string, unknown>)) {
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

function applyEnvOverrides(data: Record<string, unknown>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const env = _nodeProcess?.env ?? {};
  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey.startsWith(ENV_PREFIX) || envValue === undefined) continue;
    const suffix = envKey.slice(ENV_PREFIX.length);
    if (!suffix) continue;
    // Convert: single _ -> . (separator), double __ -> literal _
    const dotPath = suffix.toLowerCase().replace(/__/g, '\x00').replace(/_/g, '.').replace(/\x00/g, '_');
    setNested(result, dotPath, coerceEnvValue(envValue));
  }
  return result;
}

/**
 * Configuration system with YAML loading, env overrides, and validation.
 *
 * Merge priority (highest wins): environment variables > config file > defaults.
 *
 * Backward compatible: `new Config(data)` still works for in-memory configuration.
 */
export class Config {
  private _data: Record<string, unknown>;
  private _yamlPath: string | null = null;

  constructor(data?: Record<string, unknown>) {
    this._data = data ?? {};
  }

  /**
   * Load configuration from a YAML file with env overrides.
   */
  static load(yamlPath: string, options?: { validate?: boolean }): Config {
    const { existsSync, readFileSync } = _nodeFs!;
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

    // Merge: defaults < file < env
    let merged = deepMergeDicts(DEFAULTS, fileData as Record<string, unknown>);
    merged = applyEnvOverrides(merged);

    const config = new Config(merged);
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

  /** Get a configuration value by dot-path key. */
  get(key: string, defaultValue?: unknown): unknown {
    return getNested(this._data, key, defaultValue);
  }

  /** Set a configuration value by dot-path key. */
  set(key: string, value: unknown): void {
    setNested(this._data, key, value);
  }

  /** Return a deep copy of the raw config data. */
  get data(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this._data));
  }

  /**
   * Validate the configuration per Algorithm A12.
   *
   * Checks required fields, type constraints, and semantic rules.
   * Collects all errors before raising.
   */
  validate(): void {
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

  /**
   * Re-read configuration from the original YAML file.
   * Only works if the Config was created via Config.load().
   */
  reload(): void {
    if (this._yamlPath === null) {
      throw new ConfigError('Cannot reload: Config was not loaded from a YAML file');
    }
    const reloaded = Config.load(this._yamlPath);
    this._data = reloaded._data;
  }
}
