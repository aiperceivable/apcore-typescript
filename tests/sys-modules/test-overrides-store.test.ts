/**
 * OverridesStore — pluggable persistence for runtime config/toggle overrides.
 *
 * Mirrors the Python `_write_overrides`/`_load_overrides` and Rust
 * `load_overrides`/`write_override` flows, but exposed as a swappable
 * interface so tests and embeddings can inject in-memory storage.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileOverridesStore,
  InMemoryOverridesStore,
  type OverridesStore,
} from '../../src/sys-modules/overrides.js';
import { Config } from '../../src/config.js';
import { Registry } from '../../src/registry/registry.js';
import { Executor } from '../../src/executor.js';
import { EventEmitter } from '../../src/events/index.js';
import { UpdateConfigModule } from '../../src/sys-modules/control.js';
import { Context, createIdentity } from '../../src/context.js';
import { registerSysModules } from '../../src/sys-modules/registration.js';

describe('InMemoryOverridesStore', () => {
  it('round-trips load/save', async () => {
    const store: OverridesStore = new InMemoryOverridesStore();
    expect(await store.load()).toEqual({});
    await store.save({ 'app.foo': 1, 'app.bar': 'x' });
    expect(await store.load()).toEqual({ 'app.foo': 1, 'app.bar': 'x' });
  });

  it('save replaces previous content', async () => {
    const store = new InMemoryOverridesStore();
    await store.save({ a: 1 });
    await store.save({ b: 2 });
    expect(await store.load()).toEqual({ b: 2 });
  });
});

describe('FileOverridesStore', () => {
  let tmpDir: string;
  let tmpPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-overrides-'));
    tmpPath = path.join(tmpDir, 'overrides.yaml');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('persists across instances', async () => {
    const store1 = new FileOverridesStore(tmpPath);
    await store1.save({ 'app.timeout': 30, 'app.name': 'demo' });

    const store2 = new FileOverridesStore(tmpPath);
    const loaded = await store2.load();
    expect(loaded).toEqual({ 'app.timeout': 30, 'app.name': 'demo' });
  });

  it('returns empty object when file does not exist', async () => {
    const store = new FileOverridesStore(path.join(tmpDir, 'absent.yaml'));
    expect(await store.load()).toEqual({});
  });
});

describe('UpdateConfigModule writes to OverridesStore', () => {
  it('persists each successful update via the injected store', async () => {
    const store = new InMemoryOverridesStore();
    const config = new Config({});
    const emitter = new EventEmitter();
    const mod = new UpdateConfigModule(config, emitter, { overridesStore: store });

    const ctx = new Context('t', 'caller', [], null, createIdentity('user', 'user', []));
    mod.execute({ key: 'app.timeout', value: 60, reason: 'tune' }, ctx);
    mod.execute({ key: 'app.retries', value: 3, reason: 'tune' }, ctx);

    expect(await store.load()).toEqual({ 'app.timeout': 60, 'app.retries': 3 });
  });
});

describe('registerSysModules applies persisted overrides on startup', () => {
  it('loads from store and applies before registering modules', () => {
    const store = new InMemoryOverridesStore();
    // Pre-populate as if a previous run had written these.
    void store.save({ 'app.feature_x': true, 'app.threshold': 99 });

    const config = new Config({});
    config.set('sys_modules.enabled', true);
    const registry = new Registry();
    const executor = new Executor({ registry });

    registerSysModules(registry, executor, config, null, { overridesStore: store });

    expect(config.get('app.feature_x')).toBe(true);
    expect(config.get('app.threshold')).toBe(99);
  });
});
