import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Config } from '../src/config.js';
import { ConfigError, ConfigNotFoundError } from '../src/errors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Config', () => {
  it('creates with provided data', () => {
    const cfg = new Config({ name: 'test' });
    expect(cfg.get('name')).toBe('test');
  });

  it('creates with no arguments', () => {
    const cfg = new Config();
    expect(cfg.get('anything')).toBeUndefined();
  });

  it('returns various value types', () => {
    const cfg = new Config({
      str: 'hello',
      num: 42,
      bool: true,
      arr: [1, 2, 3],
      obj: { nested: true },
      nil: null,
    });
    expect(cfg.get('str')).toBe('hello');
    expect(cfg.get('num')).toBe(42);
    expect(cfg.get('bool')).toBe(true);
    expect(cfg.get('arr')).toEqual([1, 2, 3]);
    expect(cfg.get('obj')).toEqual({ nested: true });
    expect(cfg.get('nil')).toBeNull();
  });

  it('traverses nested objects with dot-path', () => {
    const cfg = new Config({
      database: {
        host: 'db.example.com',
        port: 5432,
        credentials: { user: 'admin', password: 'secret' },
      },
    });
    expect(cfg.get('database.host')).toBe('db.example.com');
    expect(cfg.get('database.port')).toBe(5432);
    expect(cfg.get('database.credentials.user')).toBe('admin');
  });

  it('returns nested object for partial path', () => {
    const cfg = new Config({ a: { b: { c: 'deep' } } });
    expect(cfg.get('a.b')).toEqual({ c: 'deep' });
  });

  it('returns undefined when key missing and no default', () => {
    const cfg = new Config({ x: 1 });
    expect(cfg.get('y')).toBeUndefined();
  });

  it('returns default value when key missing', () => {
    const cfg = new Config({ x: 1 });
    expect(cfg.get('y', 'fallback')).toBe('fallback');
    expect(cfg.get('y', 42)).toBe(42);
  });

  it('returns default when dot-path partially exists', () => {
    const cfg = new Config({ a: { b: 1 } });
    expect(cfg.get('a.c', 'default')).toBe('default');
    expect(cfg.get('a.b.c.d', 'deep-default')).toBe('deep-default');
  });

  it('returns default when traversal hits non-object', () => {
    const cfg = new Config({ a: 'string-value' });
    expect(cfg.get('a.b', 'default')).toBe('default');
  });

  it('returns default when traversal hits null', () => {
    const cfg = new Config({ a: null });
    expect(cfg.get('a.b', 'default')).toBe('default');
  });
});

describe('Config.set', () => {
  it('sets a top-level value', () => {
    const cfg = new Config({ x: 1 });
    cfg.set('y', 2);
    expect(cfg.get('y')).toBe(2);
  });

  it('sets a nested value via dot-path', () => {
    const cfg = new Config({});
    cfg.set('a.b.c', 'deep');
    expect(cfg.get('a.b.c')).toBe('deep');
  });

  it('overwrites existing value', () => {
    const cfg = new Config({ x: 1 });
    cfg.set('x', 99);
    expect(cfg.get('x')).toBe(99);
  });
});

describe('Config.data', () => {
  it('returns a deep copy', () => {
    const cfg = new Config({ a: { b: 1 } });
    const d = cfg.data;
    (d['a'] as Record<string, unknown>)['b'] = 999;
    expect(cfg.get('a.b')).toBe(1); // Original unchanged
  });
});

describe('Config.validate', () => {
  it('passes with all required fields present', () => {
    const cfg = Config.fromDefaults();
    expect(() => cfg.validate()).not.toThrow();
  });

  it('fails when required fields missing', () => {
    const cfg = new Config({});
    expect(() => cfg.validate()).toThrow(ConfigError);
    expect(() => cfg.validate()).toThrow('Missing required field');
  });

  it('collects multiple errors', () => {
    const cfg = new Config({});
    try {
      cfg.validate();
    } catch (e) {
      expect((e as ConfigError).message).toContain('version');
      expect((e as ConfigError).message).toContain('project.name');
    }
  });

  it('validates constraints', () => {
    const cfg = Config.fromDefaults();
    cfg.set('acl.default_effect', 'invalid');
    expect(() => cfg.validate()).toThrow("must be 'allow' or 'deny'");
  });

  it('validates sampling_rate range', () => {
    const cfg = Config.fromDefaults();
    cfg.set('observability.tracing.sampling_rate', 2.0);
    expect(() => cfg.validate()).toThrow('[0.0, 1.0]');
  });
});

describe('Config.fromDefaults', () => {
  it('creates config with default values', () => {
    const cfg = Config.fromDefaults();
    expect(cfg.get('version')).toBe('0.8.0');
    expect(cfg.get('executor.default_timeout')).toBe(30000);
    expect(cfg.get('acl.default_effect')).toBe('deny');
    expect(cfg.get('project.name')).toBe('apcore');
  });
});

describe('Config.load', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid YAML file', () => {
    const yamlContent = `
version: "1.0.0"
extensions:
  root: ./ext
schema:
  root: ./schemas
acl:
  root: ./acl
  default_effect: allow
project:
  name: test-project
`;
    const yamlPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(yamlPath, yamlContent);

    const cfg = Config.load(yamlPath);
    expect(cfg.get('version')).toBe('1.0.0');
    expect(cfg.get('project.name')).toBe('test-project');
    expect(cfg.get('acl.default_effect')).toBe('allow');
    // Defaults merged in
    expect(cfg.get('executor.default_timeout')).toBe(30000);
  });

  it('throws ConfigNotFoundError for missing file', () => {
    expect(() => Config.load('/nonexistent/config.yaml')).toThrow(ConfigNotFoundError);
  });

  it('throws ConfigError for invalid YAML', () => {
    const yamlPath = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(yamlPath, '{{{{invalid yaml');
    expect(() => Config.load(yamlPath)).toThrow(ConfigError);
  });

  it('throws ConfigError for non-mapping YAML', () => {
    const yamlPath = path.join(tmpDir, 'list.yaml');
    fs.writeFileSync(yamlPath, '- item1\n- item2\n');
    expect(() => Config.load(yamlPath)).toThrow('must be a mapping');
  });

  it('skips validation when validate=false', () => {
    const yamlPath = path.join(tmpDir, 'empty.yaml');
    fs.writeFileSync(yamlPath, '{}');
    // Would fail validation (missing required fields), but we skip it
    expect(() => Config.load(yamlPath, { validate: false })).not.toThrow();
  });

  it('supports reload', () => {
    const yamlPath = path.join(tmpDir, 'reload.yaml');
    const yaml1 = `
version: "1.0.0"
extensions: { root: ./ext }
schema: { root: ./schemas }
acl: { root: ./acl, default_effect: deny }
project: { name: v1 }
`;
    fs.writeFileSync(yamlPath, yaml1);
    const cfg = Config.load(yamlPath);
    expect(cfg.get('project.name')).toBe('v1');

    const yaml2 = yaml1.replace('name: v1', 'name: v2');
    fs.writeFileSync(yamlPath, yaml2);
    cfg.reload();
    expect(cfg.get('project.name')).toBe('v2');
  });

  it('throws on reload without yaml path', () => {
    const cfg = new Config({ version: '1.0.0' });
    expect(() => cfg.reload()).toThrow('not loaded from a YAML file');
  });
});

describe('Config env overrides', () => {
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

  it('applies APCORE_ env overrides', () => {
    setEnv('APCORE_PROJECT_NAME', 'env-project');
    const cfg = Config.fromDefaults();
    expect(cfg.get('project.name')).toBe('env-project');
  });

  it('handles double underscore as literal underscore', () => {
    setEnv('APCORE_ACL_DEFAULT__EFFECT', 'allow');
    const cfg = Config.fromDefaults();
    expect(cfg.get('acl.default_effect')).toBe('allow');
  });

  it('coerces numeric strings', () => {
    setEnv('APCORE_EXECUTOR_DEFAULT__TIMEOUT', '5000');
    const cfg = Config.fromDefaults();
    expect(cfg.get('executor.default_timeout')).toBe(5000);
  });

  it('coerces boolean strings', () => {
    setEnv('APCORE_EXTENSIONS_AUTO__DISCOVER', 'false');
    const cfg = Config.fromDefaults();
    expect(cfg.get('extensions.auto_discover')).toBe(false);
  });
});
