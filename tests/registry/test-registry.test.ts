import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from '@sinclair/typebox';
import { Registry, MAX_MODULE_ID_LENGTH } from '../../src/registry/registry.js';
import { FunctionModule } from '../../src/decorator.js';
import { InvalidInputError, ModuleNotFoundError } from '../../src/errors.js';
import { Config } from '../../src/config.js';
import { createAnnotations } from '../../src/module.js';

function createMod(id: string): FunctionModule {
  return new FunctionModule({
    execute: () => ({ ok: true }),
    moduleId: id,
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({ ok: Type.Boolean() }),
    description: `Module ${id}`,
  });
}

describe('Registry', () => {
  it('creates empty registry', () => {
    const registry = new Registry();
    expect(registry.count).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('register and get module', () => {
    const registry = new Registry();
    const mod = createMod('test.a');
    registry.register('test.a', mod);
    expect(registry.get('test.a')).toBe(mod);
    expect(registry.has('test.a')).toBe(true);
    expect(registry.count).toBe(1);
  });

  it('get returns null for unknown module', () => {
    const registry = new Registry();
    expect(registry.get('unknown')).toBeNull();
  });

  it('get throws for empty string', () => {
    const registry = new Registry();
    expect(() => registry.get('')).toThrow(ModuleNotFoundError);
  });

  it('register throws for empty moduleId', () => {
    const registry = new Registry();
    expect(() => registry.register('', createMod('x'))).toThrow(InvalidInputError);
  });

  it('register throws for duplicate moduleId', () => {
    const registry = new Registry();
    registry.register('test.a', createMod('test.a'));
    expect(() => registry.register('test.a', createMod('test.a'))).toThrow(InvalidInputError);
  });

  it('MAX_MODULE_ID_LENGTH matches PROTOCOL_SPEC §2.7 (192)', () => {
    // Bumped from 128 in spec 1.6.0-draft (2026-04-08) to accommodate
    // Java/.NET deep-namespace FQN-derived IDs. Filesystem-safe:
    // 192 + ".binding.yaml".length = 205 < 255-byte filename limit.
    expect(MAX_MODULE_ID_LENGTH).toBe(192);
  });

  it('register accepts module ID at exactly MAX_MODULE_ID_LENGTH', () => {
    const registry = new Registry();
    // Pattern requires [a-z][a-z0-9_]* — pure 'a' run is valid.
    const exactId = 'a'.repeat(MAX_MODULE_ID_LENGTH);
    registry.register(exactId, createMod(exactId));
    expect(registry.has(exactId)).toBe(true);
  });

  it('register rejects module ID exceeding MAX_MODULE_ID_LENGTH', () => {
    const registry = new Registry();
    const overlongId = 'a'.repeat(MAX_MODULE_ID_LENGTH + 1);
    expect(() => registry.register(overlongId, createMod(overlongId))).toThrow(
      /maximum length/,
    );
  });

  // PROTOCOL_SPEC §2.7 EBNF compliance — parity with apcore-python and apcore-rust
  it('register rejects invalid pattern (uppercase, hyphens, leading digit, etc.)', () => {
    const registry = new Registry();
    for (const badId of [
      'INVALID-ID',
      '1abc',
      'Module',
      'a..b',
      '.leading',
      'trailing.',
      'has space',
      'has!bang',
    ]) {
      expect(
        () => registry.register(badId, createMod(badId)),
        `pattern-invalid '${badId}' must throw`,
      ).toThrow(/Invalid module ID|Must match pattern/);
    }
  });

  it('register rejects reserved word in any segment, not just first', () => {
    const registry = new Registry();
    expect(() => registry.register('email.system', createMod('email.system'))).toThrow(
      /reserved word/,
    );
    expect(() => registry.register('myapp.core.x', createMod('myapp.core.x'))).toThrow(
      /reserved word/,
    );
  });

  // registerInternal — bypasses ONLY reserved word check (parity with python/rust)
  it('registerInternal accepts reserved first segment', () => {
    const registry = new Registry();
    expect(() => registry.registerInternal('system.health', createMod('system.health'))).not.toThrow();
    expect(registry.has('system.health')).toBe(true);
  });

  it('registerInternal accepts reserved word in any segment', () => {
    const registry = new Registry();
    expect(() => registry.registerInternal('myapp.system.config', createMod('myapp.system.config'))).not.toThrow();
  });

  it('registerInternal still rejects empty ID', () => {
    const registry = new Registry();
    expect(() => registry.registerInternal('', createMod('x'))).toThrow(
      /non-empty/,
    );
  });

  it('registerInternal still rejects invalid pattern', () => {
    const registry = new Registry();
    expect(() => registry.registerInternal('INVALID-ID', createMod('INVALID-ID'))).toThrow(
      /Invalid module ID|Must match pattern/,
    );
  });

  it('registerInternal still rejects over-length ID', () => {
    const registry = new Registry();
    const overlongId = 'a'.repeat(MAX_MODULE_ID_LENGTH + 1);
    expect(() => registry.registerInternal(overlongId, createMod(overlongId))).toThrow(
      /maximum length/,
    );
  });

  it('registerInternal rejects duplicate', () => {
    const registry = new Registry();
    registry.registerInternal('system.dup', createMod('system.dup'));
    expect(() => registry.registerInternal('system.dup', createMod('system.dup'))).toThrow(
      /already registered/,
    );
  });

  it('unregister removes module', () => {
    const registry = new Registry();
    registry.register('test.a', createMod('test.a'));
    const removed = registry.unregister('test.a');
    expect(removed).toBe(true);
    expect(registry.has('test.a')).toBe(false);
    expect(registry.count).toBe(0);
  });

  it('unregister returns false for unknown module', () => {
    const registry = new Registry();
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('list returns sorted module IDs', () => {
    const registry = new Registry();
    registry.register('b.mod', createMod('b.mod'));
    registry.register('a.mod', createMod('a.mod'));
    registry.register('c.mod', createMod('c.mod'));
    expect(registry.list()).toEqual(['a.mod', 'b.mod', 'c.mod']);
  });

  it('list filters by prefix', () => {
    const registry = new Registry();
    registry.register('foo.a', createMod('foo.a'));
    registry.register('foo.b', createMod('foo.b'));
    registry.register('bar.a', createMod('bar.a'));
    expect(registry.list({ prefix: 'foo.' })).toEqual(['foo.a', 'foo.b']);
  });

  it('moduleIds returns sorted IDs', () => {
    const registry = new Registry();
    registry.register('z.mod', createMod('z.mod'));
    registry.register('a.mod', createMod('a.mod'));
    expect(registry.moduleIds).toEqual(['a.mod', 'z.mod']);
  });

  it('iter returns entries', () => {
    const registry = new Registry();
    registry.register('test.a', createMod('test.a'));
    const entries = [...registry.iter()];
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe('test.a');
  });

  it('on register event fires', () => {
    const registry = new Registry();
    const events: string[] = [];
    registry.on('register', (id) => events.push(id));
    registry.register('test.a', createMod('test.a'));
    expect(events).toEqual(['test.a']);
  });

  it('on unregister event fires', () => {
    const registry = new Registry();
    const events: string[] = [];
    registry.on('unregister', (id) => events.push(id));
    registry.register('test.a', createMod('test.a'));
    registry.unregister('test.a');
    expect(events).toEqual(['test.a']);
  });

  it('on throws for invalid event', () => {
    const registry = new Registry();
    expect(() => registry.on('invalid', () => {})).toThrow(InvalidInputError);
  });

  it('getDefinition returns descriptor', () => {
    const registry = new Registry();
    const mod = createMod('test.a');
    registry.register('test.a', mod);
    const def = registry.getDefinition('test.a');
    expect(def).not.toBeNull();
    expect(def!.moduleId).toBe('test.a');
    expect(def!.description).toBe('Module test.a');
  });

  it('getDefinition returns null for unknown module', () => {
    const registry = new Registry();
    expect(registry.getDefinition('nonexistent')).toBeNull();
  });

  it('getDefinition reads annotations from merged metadata for manually-registered modules', () => {
    // Pins the invariant that the manual register() path goes through
    // mergeModuleMetadata, so getDefinition's `meta`-side reads always
    // succeed. (Regression for code-forge:review warnings about a
    // dead `mod['annotations']` fallback in getDefinition that the
    // following cleanup commit removed.)
    const annotations = createAnnotations({ readonly: true, idempotent: true });
    const mod = new FunctionModule({
      execute: () => ({ ok: true }),
      moduleId: 'test.annotated',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      description: 'annotated module',
      annotations,
    });
    const registry = new Registry();
    registry.register('test.annotated', mod);

    const def = registry.getDefinition('test.annotated');
    expect(def).not.toBeNull();
    expect(def!.annotations).not.toBeNull();
    expect(def!.annotations!.readonly).toBe(true);
    expect(def!.annotations!.idempotent).toBe(true);
    // destructive defaults to false; verify the merged result carries
    // the full ModuleAnnotations shape, not a partial dict.
    expect(def!.annotations!.destructive).toBe(false);
  });

  it('clearCache does not throw', () => {
    const registry = new Registry();
    registry.clearCache();
  });
});

/* -----------------------------------------------------------
 * Integration tests for Registry.discover() and related APIs
 * --------------------------------------------------------- */

/**
 * Helper: write a valid ESM module file (.js) that the scanner and
 * entry-point resolver can dynamically import.
 */
function writeModuleFile(
  dir: string,
  filename: string,
  content: string,
): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('Registry.discover()', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers valid .js module files and registers them', async () => {
    writeModuleFile(
      tempDir,
      'greeter.js',
      `export default {
        execute: async (inputs) => ({ greeting: 'Hello ' + inputs.name }),
        description: 'A greeter module',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { greeting: { type: 'string' } } },
      };`,
    );

    const registry = new Registry({ extensionsDir: tempDir });
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('greeter')).toBe(true);
  });

  it('discovers multiple modules in nested directories', async () => {
    writeModuleFile(
      tempDir,
      'alpha.js',
      `export default {
        execute: async () => ({}),
        description: 'Alpha module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
    );

    const subDir = join(tempDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeModuleFile(
      subDir,
      'beta.js',
      `export default {
        execute: async () => ({}),
        description: 'Beta module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
    );

    const registry = new Registry({ extensionsDir: tempDir });
    const count = await registry.discover();

    expect(count).toBe(2);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('sub.beta')).toBe(true);
  });

  it('calls onLoad during discover when module exports onLoad', async () => {
    writeModuleFile(
      tempDir,
      'withload.js',
      `let loaded = false;
      export default {
        execute: async () => ({}),
        description: 'Module with onLoad',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        onLoad() { loaded = true; },
        isLoaded() { return loaded; },
      };`,
    );

    const registry = new Registry({ extensionsDir: tempDir });
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('withload')).toBe(true);

    const mod = registry.get('withload') as Record<string, unknown>;
    const isLoaded = (mod['isLoaded'] as () => boolean)();
    expect(isLoaded).toBe(true);
  });

  it('skips modules that fail validation (no execute method)', async () => {
    writeModuleFile(
      tempDir,
      'valid.js',
      `export default {
        execute: async () => ({}),
        description: 'Valid module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
    );

    // Invalid module: no default export that passes isModuleClass
    writeModuleFile(
      tempDir,
      'invalid.js',
      `export const someData = 42;
      export const description = 'Invalid module - no execute';`,
    );

    const registry = new Registry({ extensionsDir: tempDir });
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('valid')).toBe(true);
    expect(registry.has('invalid')).toBe(false);
  });

  it('merges companion _meta.yaml metadata into discovered module', async () => {
    writeModuleFile(
      tempDir,
      'tagged.js',
      `export default {
        execute: async () => ({}),
        description: 'Tagged module from code',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
    );

    writeFileSync(
      join(tempDir, 'tagged_meta.yaml'),
      [
        'description: "Overridden description from YAML"',
        'version: "2.0.0"',
        'tags:',
        '  - yaml_tag',
        '  - production',
      ].join('\n'),
      'utf-8',
    );

    const registry = new Registry({ extensionsDir: tempDir });
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('tagged')).toBe(true);

    const def = registry.getDefinition('tagged');
    expect(def).not.toBeNull();
    expect(def!.description).toBe('Overridden description from YAML');
    expect(def!.version).toBe('2.0.0');
    expect(def!.tags).toEqual(['yaml_tag', 'production']);
  });

  it('returns 0 when extensions directory contains no valid modules', async () => {
    // Write a file that is not a module (plain text)
    writeFileSync(join(tempDir, 'readme.txt'), 'Not a module', 'utf-8');

    const registry = new Registry({ extensionsDir: tempDir });
    const count = await registry.discover();

    expect(count).toBe(0);
    expect(registry.count).toBe(0);
  });
});

describe('Registry.getDefinition() with discover', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-def-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns full ModuleDescriptor for a discovered module', async () => {
    writeModuleFile(
      tempDir,
      'detailed.js',
      `export default {
        execute: async (inputs) => ({ result: inputs.x * 2 }),
        description: 'A detailed test module',
        version: '3.5.0',
        tags: ['math', 'utility'],
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
        outputSchema: { type: 'object', properties: { result: { type: 'number' } } },
      };`,
    );

    const registry = new Registry({ extensionsDir: tempDir });
    await registry.discover();

    const def = registry.getDefinition('detailed');
    expect(def).not.toBeNull();
    expect(def!.moduleId).toBe('detailed');
    expect(def!.description).toBe('A detailed test module');
    expect(def!.version).toBe('3.5.0');
    expect(def!.tags).toEqual(['math', 'utility']);
    expect(def!.inputSchema).toEqual({
      type: 'object',
      properties: { x: { type: 'number' } },
    });
    expect(def!.outputSchema).toEqual({
      type: 'object',
      properties: { result: { type: 'number' } },
    });
  });

  it('returns null for a module ID that was not discovered', async () => {
    const registry = new Registry({ extensionsDir: tempDir });
    await registry.discover();

    expect(registry.getDefinition('nonexistent')).toBeNull();
  });
});

describe('Registry.list() with tag filtering', () => {
  it('filters modules by tags on registered plain objects', () => {
    const registry = new Registry();

    const modA = {
      execute: async () => ({}),
      description: 'Module A',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['web', 'api'],
    };
    const modB = {
      execute: async () => ({}),
      description: 'Module B',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['cli', 'api'],
    };
    const modC = {
      execute: async () => ({}),
      description: 'Module C',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['web'],
    };

    registry.register('mod.a', modA);
    registry.register('mod.b', modB);
    registry.register('mod.c', modC);

    expect(registry.list({ tags: ['api'] })).toEqual(['mod.a', 'mod.b']);
    expect(registry.list({ tags: ['web'] })).toEqual(['mod.a', 'mod.c']);
    expect(registry.list({ tags: ['cli'] })).toEqual(['mod.b']);
    expect(registry.list({ tags: ['web', 'api'] })).toEqual(['mod.a']);
  });

  it('returns empty array when no modules match the tag', () => {
    const registry = new Registry();

    const modA = {
      execute: async () => ({}),
      description: 'Module A',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['web'],
    };
    registry.register('mod.a', modA);

    expect(registry.list({ tags: ['nonexistent'] })).toEqual([]);
  });

  it('combines tag and prefix filtering', () => {
    const registry = new Registry();

    const modA = {
      execute: async () => ({}),
      description: 'Module A',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['api'],
    };
    const modB = {
      execute: async () => ({}),
      description: 'Module B',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tags: ['api'],
    };

    registry.register('svc.alpha', modA);
    registry.register('lib.beta', modB);

    expect(registry.list({ prefix: 'svc.', tags: ['api'] })).toEqual(['svc.alpha']);
    expect(registry.list({ prefix: 'lib.', tags: ['api'] })).toEqual(['lib.beta']);
    expect(registry.list({ prefix: 'unknown.', tags: ['api'] })).toEqual([]);
  });

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-tags-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters discovered modules by tags from code exports', async () => {
    writeModuleFile(
      tempDir,
      'svcone.js',
      `export default {
        execute: async () => ({}),
        description: 'Service one',
        tags: ['backend', 'grpc'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
    );

    writeModuleFile(
      tempDir,
      'svctwo.js',
      `export default {
        execute: async () => ({}),
        description: 'Service two',
        tags: ['frontend', 'rest'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
    );

    const registry = new Registry({ extensionsDir: tempDir });
    await registry.discover();

    expect(registry.list({ tags: ['backend'] })).toEqual(['svcone']);
    expect(registry.list({ tags: ['frontend'] })).toEqual(['svctwo']);
    expect(registry.list({ tags: ['grpc'] })).toEqual(['svcone']);
    expect(registry.list({ tags: ['rest'] })).toEqual(['svctwo']);
  });

  it('filters discovered modules by tags from companion YAML metadata', async () => {
    writeModuleFile(
      tempDir,
      'yamlmod.js',
      `export default {
        execute: async () => ({}),
        description: 'YAML tagged module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
    );

    writeFileSync(
      join(tempDir, 'yamlmod_meta.yaml'),
      ['tags:', '  - infra', '  - deploy'].join('\n'),
      'utf-8',
    );

    const registry = new Registry({ extensionsDir: tempDir });
    await registry.discover();

    expect(registry.list({ tags: ['infra'] })).toEqual(['yamlmod']);
    expect(registry.list({ tags: ['deploy'] })).toEqual(['yamlmod']);
    expect(registry.list({ tags: ['web'] })).toEqual([]);
  });
});

/* -----------------------------------------------------------
 * Constructor branch coverage
 * --------------------------------------------------------- */

describe('Registry constructor branches', () => {
  it('accepts extensionsDirs with string entries', () => {
    const registry = new Registry({ extensionsDirs: ['/tmp/ext-a', '/tmp/ext-b'] });
    expect(registry.count).toBe(0);
  });

  it('accepts extensionsDirs with object entries', () => {
    const registry = new Registry({
      extensionsDirs: [{ root: '/tmp/ext-a', namespace: 'ns' }, '/tmp/ext-b'],
    });
    expect(registry.count).toBe(0);
  });

  it('throws when both extensionsDir and extensionsDirs are provided', () => {
    expect(
      () => new Registry({ extensionsDir: '/tmp/ext-a', extensionsDirs: ['/tmp/ext-b'] }),
    ).toThrow(InvalidInputError);
  });

  it('uses extensions.root from config when no extensionsDir is provided', () => {
    const config = new Config({ extensions: { root: '/tmp/from-config' } });
    const registry = new Registry({ config });
    expect(registry.count).toBe(0);
  });

  it('falls back to ./extensions when config has no extensions.root key', () => {
    const config = new Config({});
    const registry = new Registry({ config });
    expect(registry.count).toBe(0);
  });

  it('falls back to ./extensions when no options are provided', () => {
    const registry = new Registry();
    expect(registry.count).toBe(0);
  });
});

/* -----------------------------------------------------------
 * register() with onLoad callback
 * --------------------------------------------------------- */

describe('Registry register() onLoad callback', () => {
  it('calls onLoad when module has an onLoad function', () => {
    const registry = new Registry();
    let loaded = false;
    const mod = {
      execute: async () => ({}),
      description: 'Module with onLoad',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      onLoad() {
        loaded = true;
      },
    };
    registry.register('with.load', mod);
    expect(loaded).toBe(true);
    expect(registry.has('with.load')).toBe(true);
  });

  it('re-deletes module and re-throws when onLoad throws', () => {
    const registry = new Registry();
    const loadError = new Error('onLoad failed');
    const mod = {
      execute: async () => ({}),
      description: 'Failing onLoad module',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      onLoad() {
        throw loadError;
      },
    };
    expect(() => registry.register('bad.load', mod)).toThrow(loadError);
    expect(registry.has('bad.load')).toBe(false);
    expect(registry.count).toBe(0);
  });
});

/* -----------------------------------------------------------
 * unregister() with onUnload callback
 * --------------------------------------------------------- */

describe('Registry unregister() onUnload callback', () => {
  it('calls onUnload when module has an onUnload function', () => {
    const registry = new Registry();
    let unloaded = false;
    const mod = {
      execute: async () => ({}),
      description: 'Module with onUnload',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      onUnload() {
        unloaded = true;
      },
    };
    registry.register('with.unload', mod);
    const result = registry.unregister('with.unload');
    expect(result).toBe(true);
    expect(unloaded).toBe(true);
    expect(registry.has('with.unload')).toBe(false);
  });

  it('still unregisters and warns when onUnload throws', () => {
    const registry = new Registry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unloadError = new Error('onUnload failed');
    const mod = {
      execute: async () => ({}),
      description: 'Module with failing onUnload',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      onUnload() {
        throw unloadError;
      },
    };
    registry.register('bad.unload', mod);
    const result = registry.unregister('bad.unload');
    expect(result).toBe(true);
    expect(registry.has('bad.unload')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[apcore:registry]'),
      unloadError,
    );
    warnSpy.mockRestore();
  });
});

/* -----------------------------------------------------------
 * _triggerEvent error handling
 * --------------------------------------------------------- */

describe('Registry _triggerEvent error handling', () => {
  it('warns and continues when a registered event callback throws', () => {
    const registry = new Registry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callbackError = new Error('callback exploded');

    registry.on('register', () => {
      throw callbackError;
    });

    // register should complete normally despite the callback throwing
    expect(() => registry.register('trigger.test', createMod('trigger.test'))).not.toThrow();
    expect(registry.has('trigger.test')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[apcore:registry]'),
      callbackError,
    );
    warnSpy.mockRestore();
  });

  it('warns and continues for unregister event callbacks that throw', () => {
    const registry = new Registry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registry.register('trigger.unreg', createMod('trigger.unreg'));

    const callbackError = new Error('unregister callback exploded');
    registry.on('unregister', () => {
      throw callbackError;
    });

    const result = registry.unregister('trigger.unreg');
    expect(result).toBe(true);
    expect(registry.has('trigger.unreg')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[apcore:registry]'),
      callbackError,
    );
    warnSpy.mockRestore();
  });
});

/* -----------------------------------------------------------
 * list() with metaTags from _moduleMeta
 * --------------------------------------------------------- */

/* -----------------------------------------------------------
 * register() invalid pattern (MODULE_ID_PATTERN check)
 * --------------------------------------------------------- */

describe('Registry register() invalid module ID pattern', () => {
  it('throws InvalidInputError when moduleId contains a hyphen', () => {
    const registry = new Registry();
    expect(() => registry.register('bad-id', createMod('test.a'))).toThrow(InvalidInputError);
  });

  it('throws InvalidInputError when moduleId starts with a digit', () => {
    const registry = new Registry();
    expect(() => registry.register('1invalid', createMod('test.a'))).toThrow(InvalidInputError);
  });

  it('throws InvalidInputError when moduleId contains uppercase letters', () => {
    const registry = new Registry();
    expect(() => registry.register('Bad.Id', createMod('test.a'))).toThrow(InvalidInputError);
  });
});

/* -----------------------------------------------------------
 * discover() with config: _scanRoots uses config values
 * --------------------------------------------------------- */

describe('Registry discover() with Config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-config-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses extensions.root from config and reads max_depth and follow_symlinks during discover()', async () => {
    writeFileSync(
      join(tempDir, 'cfgmod.js'),
      `export default {
        execute: async () => ({}),
        description: 'Config-driven module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    const config = new Config({
      extensions: { root: tempDir, max_depth: 3, follow_symlinks: false },
    });
    const registry = new Registry({ config });
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('cfgmod')).toBe(true);
  });
});

/* -----------------------------------------------------------
 * discover() onLoad failure in _registerInOrder
 * --------------------------------------------------------- */

describe('Registry discover() onLoad failure during _registerInOrder', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-onloadfail-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips module and warns when onLoad throws during discover()', async () => {
    writeFileSync(
      join(tempDir, 'failload.js'),
      `export default {
        execute: async () => ({}),
        description: 'Module with failing onLoad',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        onLoad() { throw new Error('onLoad exploded'); },
      };`,
      'utf-8',
    );

    writeFileSync(
      join(tempDir, 'goodmod.js'),
      `export default {
        execute: async () => ({}),
        description: 'Good module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new Registry({ extensionsDir: tempDir });
    const count = await registry.discover();

    // Only the good module should be registered; failload is skipped
    expect(count).toBe(1);
    expect(registry.has('goodmod')).toBe(true);
    expect(registry.has('failload')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[apcore:registry]'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

/* -----------------------------------------------------------
 * discover() with extensionsDirs (multi-root / scanMultiRoot path)
 * --------------------------------------------------------- */

describe('Registry discover() with extensionsDirs (multi-root)', () => {
  let tempDirA: string;
  let tempDirB: string;

  beforeEach(() => {
    tempDirA = mkdtempSync(join(tmpdir(), 'apcore-registry-multiroot-a-'));
    tempDirB = mkdtempSync(join(tmpdir(), 'apcore-registry-multiroot-b-'));
  });

  afterEach(() => {
    rmSync(tempDirA, { recursive: true, force: true });
    rmSync(tempDirB, { recursive: true, force: true });
  });

  it('discovers modules across multiple extension directories', async () => {
    writeFileSync(
      join(tempDirA, 'alpha.js'),
      `export default {
        execute: async () => ({}),
        description: 'Alpha module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    writeFileSync(
      join(tempDirB, 'beta.js'),
      `export default {
        execute: async () => ({}),
        description: 'Beta module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    // When using extensionsDirs with multiple roots, scanMultiRoot prefixes
    // each module ID with the namespace (basename of the root dir by default).
    const registry = new Registry({ extensionsDirs: [tempDirA, tempDirB] });
    const count = await registry.discover();

    expect(count).toBe(2);
    expect(registry.count).toBe(2);
  });

  it('discovers modules from an extensionsDirs object entry with namespace', async () => {
    writeFileSync(
      join(tempDirA, 'nsmod.js'),
      `export default {
        execute: async () => ({}),
        description: 'Namespaced module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    const registry = new Registry({
      extensionsDirs: [{ root: tempDirA, namespace: 'myns' }],
    });
    const count = await registry.discover();

    expect(count).toBe(1);
  });
});

/* -----------------------------------------------------------
 * discover() with idMapPath (_applyIdMapOverrides path)
 * --------------------------------------------------------- */

describe('Registry discover() with idMapPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-idmap-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies ID map overrides to discovered modules', async () => {
    writeFileSync(
      join(tempDir, 'mymod.js'),
      `export default {
        execute: async () => ({}),
        description: 'ID map overridden module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    const idMapPath = join(tempDir, 'idmap.yaml');
    writeFileSync(
      idMapPath,
      [
        'mappings:',
        '  - file: mymod.js',
        '    id: custom.mapped.id',
      ].join('\n'),
      'utf-8',
    );

    const registry = new Registry({ extensionsDir: tempDir, idMapPath });
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('custom.mapped.id')).toBe(true);
    expect(registry.has('mymod')).toBe(false);
  });

  it('discovers normally when ID map has no matching entry for a file', async () => {
    writeFileSync(
      join(tempDir, 'unmapped.js'),
      `export default {
        execute: async () => ({}),
        description: 'Unmapped module',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    const idMapPath = join(tempDir, 'idmap.yaml');
    writeFileSync(
      idMapPath,
      ['mappings:', '  - file: other.js', '    id: other.id'].join('\n'),
      'utf-8',
    );

    const registry = new Registry({ extensionsDir: tempDir, idMapPath });
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('unmapped')).toBe(true);
  });
});

/* -----------------------------------------------------------
 * list() metaTags from companion metadata
 * --------------------------------------------------------- */

describe('Registry list() metaTags from companion metadata', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-metatags-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters using tags stored in _moduleMeta when module object has no tags', async () => {
    writeFileSync(
      join(tempDir, 'notagmod.js'),
      `export default {
        execute: async () => ({}),
        description: 'No tags on module object',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      };`,
      'utf-8',
    );

    writeFileSync(
      join(tempDir, 'notagmod_meta.yaml'),
      ['tags:', '  - alpha', '  - beta'].join('\n'),
      'utf-8',
    );

    const registry = new Registry({ extensionsDir: tempDir });
    await registry.discover();

    expect(registry.list({ tags: ['alpha'] })).toEqual(['notagmod']);
    expect(registry.list({ tags: ['beta'] })).toEqual(['notagmod']);
    expect(registry.list({ tags: ['gamma'] })).toEqual([]);
  });
});

/* -----------------------------------------------------------
 * describe() tests
 * --------------------------------------------------------- */

describe('Registry.describe()', () => {
  it('calls custom describe() method when module has one', () => {
    const registry = new Registry();
    const mod = {
      execute: async () => ({}),
      description: 'Module with custom describe',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      describe() {
        return 'Custom description from the module itself.';
      },
    };
    registry.register('test.custom', mod);
    expect(registry.describe('test.custom')).toBe('Custom description from the module itself.');
  });

  it('auto-generates markdown when no custom describe method', () => {
    const registry = new Registry();
    const mod = {
      execute: async () => ({}),
      description: 'A valid test module',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', description: 'Input value' } },
        required: ['value'],
      },
      outputSchema: { type: 'object' },
      tags: ['test', 'sample'],
    };
    registry.register('test.auto', mod);
    const result = registry.describe('test.auto');
    expect(result).toContain('# test.auto');
    expect(result).toContain('A valid test module');
    expect(result).toContain('**Tags:** test, sample');
    expect(result).toContain('**Parameters:**');
    expect(result).toContain('`value`');
    expect(result).toContain('(required)');
  });

  it('includes documentation section when available', () => {
    const registry = new Registry();
    const mod = {
      execute: async () => ({}),
      description: 'A documented module',
      documentation: 'This module does interesting things.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    registry.register('test.documented', mod);
    const result = registry.describe('test.documented');
    expect(result).toContain('**Documentation:**');
    expect(result).toContain('This module does interesting things.');
  });

  it('throws ModuleNotFoundError for unregistered module', () => {
    const registry = new Registry();
    expect(() => registry.describe('nonexistent.module')).toThrow(ModuleNotFoundError);
  });
});

/* -----------------------------------------------------------
 * Hot Reload (watch/unwatch)
 * --------------------------------------------------------- */

describe('Registry hot reload (watch/unwatch)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-hotreload-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('watch() does not throw when called with a valid directory', () => {
    const registry = new Registry({ extensionsDir: tempDir });
    expect(() => registry.watch()).not.toThrow();
    registry.unwatch();
  });

  it('unwatch() is safe to call when not watching', () => {
    const registry = new Registry();
    expect(() => registry.unwatch()).not.toThrow();
    // Call again to verify idempotent
    expect(() => registry.unwatch()).not.toThrow();
  });

  it('watch() is idempotent (calling twice does not throw)', () => {
    const registry = new Registry({ extensionsDir: tempDir });
    registry.watch();
    expect(() => registry.watch()).not.toThrow();
    registry.unwatch();
  });

  it('_pathToModuleId maps a file path to a module ID correctly', () => {
    const registry = new Registry();
    const mod = {
      execute: async () => ({}),
      description: 'Test module',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    registry.register('my_module', mod);
    const result = (registry as any)._pathToModuleId('/some/path/my_module.ts');
    expect(result).toBe('my_module');
  });

  it('_pathToModuleId maps a namespaced module correctly', () => {
    const registry = new Registry();
    const mod = {
      execute: async () => ({}),
      description: 'Namespaced module',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    registry.register('ns.my_module', mod);
    const result = (registry as any)._pathToModuleId('/some/path/my_module.js');
    expect(result).toBe('ns.my_module');
  });

  it('_pathToModuleId returns null for an unknown file', () => {
    const registry = new Registry();
    const mod = {
      execute: async () => ({}),
      description: 'Test module',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    registry.register('my_module', mod);
    const result = (registry as any)._pathToModuleId('/some/path/unknown_file.ts');
    expect(result).toBeNull();
  });

  it('_handleFileDeletion unregisters a known module', () => {
    const registry = new Registry();
    let unloaded = false;
    const mod = {
      execute: async () => ({}),
      description: 'Deletable module',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      onUnload() { unloaded = true; },
    };
    registry.register('deletable', mod);
    expect(registry.has('deletable')).toBe(true);

    (registry as any)._handleFileDeletion('/extensions/deletable.ts');

    expect(registry.has('deletable')).toBe(false);
    expect(unloaded).toBe(true);
  });

  it('_handleFileDeletion does nothing for an unknown file', () => {
    const registry = new Registry();
    const mod = {
      execute: async () => ({}),
      description: 'Existing module',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    registry.register('existing', mod);
    // Should not throw, should not affect existing modules
    (registry as any)._handleFileDeletion('/some/path/unknown.ts');
    expect(registry.has('existing')).toBe(true);
  });
});

/* -----------------------------------------------------------
 * Custom Discoverer
 * --------------------------------------------------------- */

describe('Registry custom discoverer', () => {
  it('uses custom discoverer when set', async () => {
    const modA = {
      execute: async () => ({}),
      description: 'Custom module A',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    const modB = {
      execute: async () => ({}),
      description: 'Custom module B',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };

    let calledWithRoots: string[] | null = null;
    const discoverer = {
      discover(roots: string[]) {
        calledWithRoots = roots;
        return [
          { moduleId: 'custom.a', module: modA },
          { moduleId: 'custom.b', module: modB },
        ];
      },
    };

    const registry = new Registry();
    registry.setDiscoverer(discoverer);
    const count = await registry.discover();

    expect(count).toBe(2);
    expect(registry.has('custom.a')).toBe(true);
    expect(registry.has('custom.b')).toBe(true);
    expect(registry.get('custom.a')).toBe(modA);
    expect(registry.get('custom.b')).toBe(modB);
    expect(calledWithRoots).toEqual(['./extensions']);
  });

  it('uses default discoverer when none set', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-defdisc-'));
    try {
      writeModuleFile(
        tempDir,
        'default_mod.js',
        `export default {
          execute: async () => ({}),
          description: 'Default module',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        };`,
      );

      const registry = new Registry({ extensionsDir: tempDir });
      const count = await registry.discover();

      expect(count).toBe(1);
      expect(registry.has('default_mod')).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports async discoverer', async () => {
    const mod = {
      execute: async () => ({}),
      description: 'Async discovered module',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };

    const discoverer = {
      async discover(_roots: string[]) {
        return [{ moduleId: 'async.mod', module: mod }];
      },
    };

    const registry = new Registry();
    registry.setDiscoverer(discoverer);
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('async.mod')).toBe(true);
  });
});

/* -----------------------------------------------------------
 * Custom Validator
 * --------------------------------------------------------- */

describe('Registry custom validator', () => {
  it('rejects modules when custom validator returns errors', async () => {
    const mod = {
      execute: async () => ({}),
      description: 'To be rejected',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };

    const discoverer = {
      discover(_roots: string[]) {
        return [{ moduleId: 'rejected.mod', module: mod }];
      },
    };

    const validator = {
      validate(_module: unknown) {
        return ['rejected by custom validator'];
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new Registry();
    registry.setDiscoverer(discoverer);
    registry.setValidator(validator);
    const count = await registry.discover();

    expect(count).toBe(0);
    expect(registry.has('rejected.mod')).toBe(false);
    warnSpy.mockRestore();
  });

  it('accepts modules when custom validator returns empty list', async () => {
    const mod = {
      execute: async () => ({}),
      description: 'To be accepted',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };

    const discoverer = {
      discover(_roots: string[]) {
        return [{ moduleId: 'accepted.mod', module: mod }];
      },
    };

    const validator = {
      validate(_module: unknown) {
        return [];
      },
    };

    const registry = new Registry();
    registry.setDiscoverer(discoverer);
    registry.setValidator(validator);
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('accepted.mod')).toBe(true);
    expect(registry.get('accepted.mod')).toBe(mod);
  });

  it('custom validator works with default file-system discovery', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'apcore-registry-customval-'));
    try {
      writeModuleFile(
        tempDir,
        'val_mod.js',
        `export default {
          execute: async () => ({}),
          description: 'Validated module',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        };`,
      );

      const validator = {
        validate(_module: unknown) {
          return ['rejected by custom validator'];
        },
      };

      const registry = new Registry({ extensionsDir: tempDir });
      registry.setValidator(validator);
      const count = await registry.discover();

      // Custom validator rejects all, so nothing should be registered
      expect(count).toBe(0);
      expect(registry.has('val_mod')).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports async validator', async () => {
    const mod = {
      execute: async () => ({}),
      description: 'Async validated module',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };

    const discoverer = {
      discover(_roots: string[]) {
        return [{ moduleId: 'async.validated', module: mod }];
      },
    };

    const validator = {
      async validate(_module: unknown) {
        return [];
      },
    };

    const registry = new Registry();
    registry.setDiscoverer(discoverer);
    registry.setValidator(validator);
    const count = await registry.discover();

    expect(count).toBe(1);
    expect(registry.has('async.validated')).toBe(true);
  });
});
