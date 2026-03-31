/**
 * Tests for Config Bus features (§9.4–§9.15): namespace registration,
 * mode detection, mount, namespace(), bind(), getTyped(), env dispatch,
 * and A12-NS validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Config } from '../src/config.js';
import {
  ConfigNamespaceDuplicateError,
  ConfigNamespaceReservedError,
  ConfigEnvPrefixConflictError,
  ConfigMountError,
  ConfigBindError,
  ConfigError,
} from '../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers to reset namespace registry between tests.
// The registry is module-level and not exposed directly, so we use a
// test-only helper that re-registers known built-in names by catching
// duplicates and deleting them via a private backdoor. Since we cannot
// clear the global registry from outside the module, we instead just avoid
// re-registering built-ins and only clean up test-specific namespaces.
// ---------------------------------------------------------------------------

// Track namespaces registered during tests so we can verify errors without
// polluting the global state.
const TEST_NAMESPACES: string[] = [];

function tryRegisterTestNamespace(options: {
  name: string;
  schema?: object | string | null;
  envPrefix?: string | null;
  defaults?: Record<string, unknown> | null;
}): void {
  try {
    Config.registerNamespace(options);
    TEST_NAMESPACES.push(options.name);
  } catch {
    // Already registered from a previous test run — silently ignore for idempotent tests.
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Config.registerNamespace', () => {
  it('registers a new namespace successfully', () => {
    const name = 'test-ns-reg-' + Date.now();
    Config.registerNamespace({ name });
    const ns = Config.registeredNamespaces();
    expect(ns.some((n) => n.name === name)).toBe(true);
  });

  it('throws ConfigNamespaceReservedError for "apcore"', () => {
    expect(() => Config.registerNamespace({ name: 'apcore' }))
      .toThrow(ConfigNamespaceReservedError);
  });

  it('throws ConfigNamespaceReservedError for "_config"', () => {
    expect(() => Config.registerNamespace({ name: '_config' }))
      .toThrow(ConfigNamespaceReservedError);
  });

  it('throws ConfigNamespaceDuplicateError when registering same name twice', () => {
    const name = 'test-ns-dup-' + Date.now();
    Config.registerNamespace({ name });
    expect(() => Config.registerNamespace({ name }))
      .toThrow(ConfigNamespaceDuplicateError);
  });

  it('throws ConfigEnvPrefixConflictError when envPrefix matches APCORE_[A-Z0-9] pattern', () => {
    const name = 'test-ns-env-reserved-' + Date.now();
    expect(() => Config.registerNamespace({ name, envPrefix: 'APCORE_SOMETHING' }))
      .toThrow(ConfigEnvPrefixConflictError);
  });

  it('throws ConfigEnvPrefixConflictError when envPrefix already used', () => {
    const uniquePrefix = 'MYAPP__NS_' + Date.now();
    const name1 = 'test-ns-pfx1-' + Date.now();
    const name2 = 'test-ns-pfx2-' + Date.now();
    Config.registerNamespace({ name: name1, envPrefix: uniquePrefix });
    expect(() => Config.registerNamespace({ name: name2, envPrefix: uniquePrefix }))
      .toThrow(ConfigEnvPrefixConflictError);
  });

  it('allows envPrefix that does not match APCORE_[A-Z0-9]', () => {
    const name = 'test-ns-custom-env-' + Date.now();
    const prefix = 'CUSTOM__NS_' + Date.now();
    expect(() => Config.registerNamespace({ name, envPrefix: prefix })).not.toThrow();
  });
});

describe('Config.registeredNamespaces', () => {
  it('returns built-in namespaces', () => {
    const ns = Config.registeredNamespaces();
    const names = ns.map((n) => n.name);
    expect(names).toContain('observability');
    expect(names).toContain('sys_modules');
  });

  it('includes hasSchema flag', () => {
    const name = 'test-ns-schema-' + Date.now();
    Config.registerNamespace({ name, schema: { type: 'object' } });
    const ns = Config.registeredNamespaces();
    const entry = ns.find((n) => n.name === name);
    expect(entry).toBeDefined();
    expect(entry!.hasSchema).toBe(true);
  });

  it('hasSchema is false when no schema provided', () => {
    const name = 'test-ns-noschema-' + Date.now();
    Config.registerNamespace({ name });
    const ns = Config.registeredNamespaces();
    const entry = ns.find((n) => n.name === name);
    expect(entry!.hasSchema).toBe(false);
  });
});

describe('Config mode detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-config-bus-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects legacy mode when no "apcore" top-level key', () => {
    const yamlPath = path.join(tmpDir, 'legacy.yaml');
    fs.writeFileSync(yamlPath, `
version: "1.0.0"
extensions:
  root: ./ext
schema:
  root: ./schemas
acl:
  root: ./acl
  default_effect: deny
project:
  name: my-project
`);
    const cfg = Config.load(yamlPath);
    expect(cfg.mode).toBe('legacy');
  });

  it('detects namespace mode when "apcore" top-level key present', () => {
    const yamlPath = path.join(tmpDir, 'ns.yaml');
    fs.writeFileSync(yamlPath, `
apcore:
  version: "1.0.0"
`);
    const cfg = Config.load(yamlPath, { validate: false });
    expect(cfg.mode).toBe('namespace');
  });
});

describe('Config namespace mode get/set', () => {
  it('resolves dot-path with namespace prefix', () => {
    const name = 'test-ns-get-' + Date.now();
    tryRegisterTestNamespace({ name });
    const cfg = new Config({ [name]: { foo: { bar: 42 } } });
    // Inject namespace mode manually via a load
    (cfg as unknown as Record<string, unknown>)['_mode'] = 'namespace';
    expect(cfg.get(`${name}.foo.bar`)).toBe(42);
  });

  it('returns default when path not found in namespace mode', () => {
    const cfg = new Config({ 'observability': { tracing: { enabled: false } } });
    (cfg as unknown as Record<string, unknown>)['_mode'] = 'namespace';
    expect(cfg.get('observability.tracing.missing', 'default-val')).toBe('default-val');
  });
});

describe('Config.mount', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-mount-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mounts fromDict successfully', () => {
    const cfg = new Config({});
    cfg.mount('my-plugin', { fromDict: { host: 'localhost', port: 9200 } });
    expect(cfg.namespace('my-plugin')).toEqual({ host: 'localhost', port: 9200 });
  });

  it('mounts fromFile successfully', () => {
    const filePath = path.join(tmpDir, 'plugin.yaml');
    fs.writeFileSync(filePath, 'host: redis\nport: 6379\n');
    const cfg = new Config({});
    cfg.mount('redis-ns', { fromFile: filePath });
    expect(cfg.namespace('redis-ns')).toEqual({ host: 'redis', port: 6379 });
  });

  it('throws ConfigMountError when namespace is "_config"', () => {
    const cfg = new Config({});
    expect(() => cfg.mount('_config', { fromDict: {} }))
      .toThrow(ConfigMountError);
  });

  it('throws ConfigMountError when both fromFile and fromDict provided', () => {
    const filePath = path.join(tmpDir, 'f.yaml');
    fs.writeFileSync(filePath, '{}');
    const cfg = new Config({});
    expect(() => cfg.mount('ns', { fromFile: filePath, fromDict: {} }))
      .toThrow(ConfigMountError);
  });

  it('throws ConfigMountError when neither fromFile nor fromDict provided', () => {
    const cfg = new Config({});
    expect(() => cfg.mount('ns', {}))
      .toThrow(ConfigMountError);
  });

  it('throws ConfigMountError when fromFile does not exist', () => {
    const cfg = new Config({});
    expect(() => cfg.mount('ns', { fromFile: '/nonexistent/file.yaml' }))
      .toThrow(ConfigMountError);
  });

  it('merges mount data over existing namespace data', () => {
    const cfg = new Config({ 'ns': { a: 1, b: 2 } });
    cfg.mount('ns', { fromDict: { b: 99, c: 3 } });
    expect(cfg.namespace('ns')).toEqual({ a: 1, b: 99, c: 3 });
  });
});

describe('Config.namespace', () => {
  it('returns a deep copy of the namespace subtree', () => {
    const cfg = new Config({ 'myplugin': { host: 'localhost' } });
    const ns = cfg.namespace('myplugin');
    expect(ns).toEqual({ host: 'localhost' });
    ns['host'] = 'mutated';
    // Original should be unchanged
    expect(cfg.namespace('myplugin')).toEqual({ host: 'localhost' });
  });

  it('returns empty object for unknown namespace', () => {
    const cfg = new Config({});
    expect(cfg.namespace('nonexistent')).toEqual({});
  });
});

describe('Config.getTyped', () => {
  it('applies coerce function to the value', () => {
    const cfg = new Config({ timeout: '5000' });
    const result = cfg.getTyped('timeout', (v) => Number(v));
    expect(result).toBe(5000);
  });

  it('throws ConfigError when path is missing', () => {
    const cfg = new Config({});
    expect(() => cfg.getTyped('missing.path', (v) => v))
      .toThrow(ConfigError);
  });
});

describe('Config.bind', () => {
  it('deserializes namespace into a class instance', () => {
    class DbConfig {
      readonly host: string;
      readonly port: number;
      constructor(data: Record<string, unknown>) {
        this.host = data['host'] as string;
        this.port = data['port'] as number;
      }
    }

    const cfg = new Config({ database: { host: 'db.example.com', port: 5432 } });
    const bound = cfg.bind('database', DbConfig);
    expect(bound).toBeInstanceOf(DbConfig);
    expect(bound.host).toBe('db.example.com');
    expect(bound.port).toBe(5432);
  });

  it('throws ConfigBindError when constructor throws', () => {
    class BrokenConfig {
      constructor(_data: Record<string, unknown>) {
        throw new Error('constructor failed');
      }
    }

    const cfg = new Config({ broken: {} });
    expect(() => cfg.bind('broken', BrokenConfig))
      .toThrow(ConfigBindError);
  });
});

describe('Config namespace defaults', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-ns-defaults-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies built-in observability defaults in namespace mode', () => {
    const yamlPath = path.join(tmpDir, 'ns.yaml');
    fs.writeFileSync(yamlPath, 'apcore:\n  version: "1.0.0"\n');
    const cfg = Config.load(yamlPath, { validate: false });
    // Built-in default: observability.logging.enabled = true
    const obs = cfg.namespace('observability');
    expect((obs['logging'] as Record<string, unknown>)['enabled']).toBe(true);
  });

  it('applies built-in sys_modules defaults in namespace mode', () => {
    const yamlPath = path.join(tmpDir, 'ns2.yaml');
    fs.writeFileSync(yamlPath, 'apcore:\n  version: "1.0.0"\n');
    const cfg = Config.load(yamlPath, { validate: false });
    const sys = cfg.namespace('sys_modules');
    expect(sys['enabled']).toBe(true);
  });
});

describe('Config namespace env dispatch', () => {
  const envKeys: string[] = [];

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    envKeys.length = 0;
  });

  function setEnv(key: string, value: string): void {
    process.env[key] = value;
    envKeys.push(key);
  }

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-ns-env-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches env var to the matching namespace by prefix', () => {
    setEnv('APCORE__OBSERVABILITY_LOGGING_LEVEL', 'debug');
    const yamlPath = path.join(tmpDir, 'ns.yaml');
    fs.writeFileSync(yamlPath, 'apcore:\n  version: "1.0.0"\n');
    const cfg = Config.load(yamlPath, { validate: false });
    const obs = cfg.namespace('observability');
    const logging = obs['logging'] as Record<string, unknown> | undefined;
    expect(logging?.['level']).toBe('debug');
  });
});

describe('Config A12-NS validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-ns-validate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws ConfigError for unknown namespace in strict mode', () => {
    const yamlPath = path.join(tmpDir, 'strict.yaml');
    fs.writeFileSync(yamlPath, `
apcore:
  version: "1.0.0"
_config:
  strict: true
unknown_namespace:
  foo: bar
`);
    expect(() => Config.load(yamlPath, { validate: true }))
      .toThrow(ConfigError);
  });

  it('does not throw for known namespaces in strict mode', () => {
    const yamlPath = path.join(tmpDir, 'strict-ok.yaml');
    fs.writeFileSync(yamlPath, `
apcore:
  version: "1.0.0"
_config:
  strict: true
observability:
  logging:
    level: info
`);
    expect(() => Config.load(yamlPath, { validate: true })).not.toThrow();
  });

  it('does not throw for unknown namespaces when strict mode is off', () => {
    const yamlPath = path.join(tmpDir, 'permissive.yaml');
    fs.writeFileSync(yamlPath, `
apcore:
  version: "1.0.0"
unknown_ns:
  foo: bar
`);
    expect(() => Config.load(yamlPath, { validate: true })).not.toThrow();
  });
});

describe('Config.reload in namespace mode', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-reload-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-applies namespace defaults and mount data after reload', () => {
    const yamlPath = path.join(tmpDir, 'reload.yaml');
    fs.writeFileSync(yamlPath, 'apcore:\n  version: "1.0.0"\n');
    const cfg = Config.load(yamlPath, { validate: false });
    cfg.mount('extra-reload-ns', { fromDict: { x: 1 } });

    // Modify the YAML and reload
    fs.writeFileSync(yamlPath, 'apcore:\n  version: "2.0.0"\n');
    cfg.reload();

    // Mount should be re-applied
    expect(cfg.namespace('extra-reload-ns')).toEqual({ x: 1 });
    // Built-in defaults should still be present
    const obs = cfg.namespace('observability');
    expect(obs).toBeDefined();
  });
});
