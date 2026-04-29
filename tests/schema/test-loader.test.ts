import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Config } from '../../src/config.js';
import { SchemaNotFoundError, SchemaParseError } from '../../src/errors.js';
import { SchemaLoader, jsonSchemaToTypeBox, contentHash } from '../../src/schema/loader.js';

describe('SchemaLoader', () => {
  let tmpDir: string;
  let schemasDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `apcore-test-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSchema(relPath: string, content: string): void {
    const fullPath = join(schemasDir, relPath);
    const dir = fullPath.replace(/\/[^/]+$/, '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  function makeConfig(overrides?: Record<string, unknown>): Config {
    return new Config({
      schema: { root: schemasDir, strategy: 'yaml_first', ...overrides },
    });
  }

  describe('load', () => {
    it('loads a valid YAML schema file', () => {
      writeSchema('greeter.schema.yaml', `
description: A greeter module
input_schema:
  type: object
  properties:
    name:
      type: string
  required:
    - name
output_schema:
  type: object
  properties:
    message:
      type: string
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const sd = loader.load('greeter');

      expect(sd.moduleId).toBe('greeter');
      expect(sd.description).toBe('A greeter module');
      expect(sd.inputSchema).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      });
      expect(sd.version).toBe('1.0.0');
    });

    it('loads a schema with dot-separated module ID (nested path)', () => {
      writeSchema('math/add.schema.yaml', `
description: Add numbers
input_schema:
  type: object
  properties:
    a:
      type: number
output_schema:
  type: object
  properties:
    result:
      type: number
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const sd = loader.load('math.add');

      expect(sd.moduleId).toBe('math.add');
      expect(sd.description).toBe('Add numbers');
    });

    it('throws SchemaNotFoundError for non-existent schema', () => {
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      expect(() => loader.load('nonexistent')).toThrow(SchemaNotFoundError);
    });

    it('throws SchemaParseError for invalid YAML', () => {
      writeSchema('bad.schema.yaml', '{ invalid yaml:: [');
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      expect(() => loader.load('bad')).toThrow(SchemaParseError);
    });

    it('throws SchemaParseError for empty file', () => {
      writeSchema('empty.schema.yaml', '');
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      expect(() => loader.load('empty')).toThrow(SchemaParseError);
    });

    it('throws SchemaParseError for array YAML', () => {
      writeSchema('arr.schema.yaml', '- item1\n- item2\n');
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      expect(() => loader.load('arr')).toThrow(SchemaParseError);
    });

    it('throws SchemaParseError when required field is missing', () => {
      writeSchema('noinput.schema.yaml', `
description: Missing input_schema
output_schema:
  type: object
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      expect(() => loader.load('noinput')).toThrow(SchemaParseError);
      expect(() => loader.load('noinput')).toThrow(/Missing required field/);
    });

    it('merges definitions and $defs', () => {
      writeSchema('withdefs.schema.yaml', `
description: Has definitions
input_schema:
  type: object
output_schema:
  type: object
definitions:
  Foo:
    type: string
$defs:
  Bar:
    type: integer
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const sd = loader.load('withdefs');
      expect(sd.definitions).toEqual({ Foo: { type: 'string' }, Bar: { type: 'integer' } });
    });

    it('returns cached result on second call', () => {
      writeSchema('cached.schema.yaml', `
description: Cached
input_schema:
  type: object
output_schema:
  type: object
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const first = loader.load('cached');
      const second = loader.load('cached');
      expect(first).toBe(second);
    });

    it('preserves optional fields (version, documentation, errorSchema)', () => {
      writeSchema('full.schema.yaml', `
description: Full schema
version: "2.0.0"
documentation: "Some docs"
input_schema:
  type: object
output_schema:
  type: object
error_schema:
  type: object
  properties:
    code:
      type: string
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const sd = loader.load('full');
      expect(sd.version).toBe('2.0.0');
      expect(sd.documentation).toBe('Some docs');
      expect(sd.errorSchema).toEqual({ type: 'object', properties: { code: { type: 'string' } } });
    });
  });

  describe('resolve', () => {
    it('resolves a schema definition into TypeBox schemas', () => {
      writeSchema('resolvable.schema.yaml', `
description: Resolvable
input_schema:
  type: object
  properties:
    query:
      type: string
  required:
    - query
output_schema:
  type: object
  properties:
    result:
      type: string
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const sd = loader.load('resolvable');
      const [inputRs, outputRs] = loader.resolve(sd);

      expect(inputRs.moduleId).toBe('resolvable');
      expect(inputRs.direction).toBe('input');
      expect(Value.Check(inputRs.schema, { query: 'hello' })).toBe(true);
      expect(Value.Check(inputRs.schema, {})).toBe(false);

      expect(outputRs.moduleId).toBe('resolvable');
      expect(outputRs.direction).toBe('output');
      expect(Value.Check(outputRs.schema, { result: 'world' })).toBe(true);
    });
  });

  describe('getSchema', () => {
    const validYaml = `
description: Test module
input_schema:
  type: object
  properties:
    x:
      type: string
  required:
    - x
output_schema:
  type: object
  properties:
    y:
      type: string
`;

    it('uses yaml_first strategy and finds YAML', () => {
      writeSchema('mod.schema.yaml', validYaml);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const [inputRs, outputRs] = loader.getSchema('mod');

      expect(inputRs.direction).toBe('input');
      expect(outputRs.direction).toBe('output');
      expect(Value.Check(inputRs.schema, { x: 'hi' })).toBe(true);
    });

    it('uses yaml_first strategy and falls back to native when YAML not found', () => {
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const nativeInput = Type.Object({ a: Type.String() });
      const nativeOutput = Type.Object({ b: Type.Number() });

      const [inputRs, outputRs] = loader.getSchema('missing', nativeInput, nativeOutput);

      expect(inputRs.direction).toBe('input');
      expect(inputRs.moduleId).toBe('missing');
      expect(Value.Check(inputRs.schema, { a: 'test' })).toBe(true);
      expect(outputRs.direction).toBe('output');
      expect(Value.Check(outputRs.schema, { b: 42 })).toBe(true);
    });

    it('uses yaml_first strategy and throws when YAML not found and no native schemas', () => {
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      expect(() => loader.getSchema('missing')).toThrow(SchemaNotFoundError);
    });

    it('uses native_first strategy and prefers native when available', () => {
      writeSchema('native.schema.yaml', validYaml);
      const config = makeConfig({ strategy: 'native_first' });
      const loader = new SchemaLoader(config, schemasDir);

      const nativeInput = Type.Object({ custom: Type.Boolean() });
      const nativeOutput = Type.Object({ out: Type.Boolean() });

      const [inputRs] = loader.getSchema('native', nativeInput, nativeOutput);
      // Should use native, not YAML
      expect(Value.Check(inputRs.schema, { custom: true })).toBe(true);
      expect(Value.Check(inputRs.schema, { x: 'string' })).toBe(false);
    });

    it('uses native_first strategy and falls back to YAML when no native', () => {
      writeSchema('fallback.schema.yaml', validYaml);
      const config = makeConfig({ strategy: 'native_first' });
      const loader = new SchemaLoader(config, schemasDir);

      const [inputRs] = loader.getSchema('fallback');
      expect(Value.Check(inputRs.schema, { x: 'hi' })).toBe(true);
    });

    it('uses yaml_only strategy', () => {
      writeSchema('yamlonly.schema.yaml', validYaml);
      const config = makeConfig({ strategy: 'yaml_only' });
      const loader = new SchemaLoader(config, schemasDir);

      const [inputRs] = loader.getSchema('yamlonly');
      expect(Value.Check(inputRs.schema, { x: 'hi' })).toBe(true);
    });

    it('uses yaml_only strategy and throws when YAML not found', () => {
      const config = makeConfig({ strategy: 'yaml_only' });
      const loader = new SchemaLoader(config, schemasDir);

      const nativeInput = Type.Object({ a: Type.String() });
      const nativeOutput = Type.Object({ b: Type.Number() });
      // yaml_only ignores native schemas
      expect(() => loader.getSchema('nope', nativeInput, nativeOutput)).toThrow(SchemaNotFoundError);
    });

    it('caches getSchema results', () => {
      writeSchema('cacheme.schema.yaml', validYaml);
      const loader = new SchemaLoader(makeConfig(), schemasDir);

      const first = loader.getSchema('cacheme');
      const second = loader.getSchema('cacheme');
      expect(first).toBe(second);
    });

    it('returns distinct output schemas for modules with identical input but different output (regression: cache hash collision)', () => {
      // Two modules: same input schema, different output schemas.
      // Before the fix, both resolved to the first module's output schema.
      writeSchema('mod-a.schema.yaml', `
description: Module A
input_schema:
  type: object
  properties:
    name:
      type: string
  required: [name]
output_schema:
  type: object
  properties:
    result_a:
      type: string
  required: [result_a]
`);
      writeSchema('mod-b.schema.yaml', `
description: Module B
input_schema:
  type: object
  properties:
    name:
      type: string
  required: [name]
output_schema:
  type: object
  properties:
    result_b:
      type: integer
  required: [result_b]
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);
      const [, outputA] = loader.getSchema('mod-a');
      const [, outputB] = loader.getSchema('mod-b');

      expect(outputA.moduleId).toBe('mod-a');
      expect(outputB.moduleId).toBe('mod-b');

      // Module A's output accepts strings, not integers
      expect(Value.Check(outputA.schema, { result_a: 'hello' })).toBe(true);
      expect(Value.Check(outputA.schema, { result_b: 42 })).toBe(false);

      // Module B's output accepts integers, not strings
      expect(Value.Check(outputB.schema, { result_b: 42 })).toBe(true);
      expect(Value.Check(outputB.schema, { result_a: 'hello' })).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('clears all caches so next load/getSchema reloads from disk', () => {
      writeSchema('clearable.schema.yaml', `
description: Clearable
input_schema:
  type: object
  properties:
    v:
      type: string
output_schema:
  type: object
`);
      const loader = new SchemaLoader(makeConfig(), schemasDir);

      const sd1 = loader.load('clearable');
      expect(sd1.description).toBe('Clearable');

      // Overwrite file
      writeSchema('clearable.schema.yaml', `
description: Updated
input_schema:
  type: object
output_schema:
  type: object
`);

      // Without clear, returns cached
      const sd2 = loader.load('clearable');
      expect(sd2.description).toBe('Clearable');

      // After clear, reloads from disk
      loader.clearCache();
      const sd3 = loader.load('clearable');
      expect(sd3.description).toBe('Updated');
    });
  });

  describe('constructor', () => {
    it('uses config schema.root when schemasDir not provided', () => {
      writeSchema('fromconfig.schema.yaml', `
description: From config
input_schema:
  type: object
output_schema:
  type: object
`);
      const config = new Config({ schema: { root: schemasDir } });
      const loader = new SchemaLoader(config);
      const sd = loader.load('fromconfig');
      expect(sd.description).toBe('From config');
    });

    it('uses default ./schemas when config has no schema.root', () => {
      const config = new Config({});
      // This just constructs without error; actual path may not exist
      const loader = new SchemaLoader(config);
      expect(loader).toBeInstanceOf(SchemaLoader);
    });
  });
});

describe('jsonSchemaToTypeBox', () => {
  it('converts string type', () => {
    const schema = jsonSchemaToTypeBox({ type: 'string' });
    expect(Value.Check(schema, 'hello')).toBe(true);
    expect(Value.Check(schema, 123)).toBe(false);
  });

  it('converts integer type', () => {
    const schema = jsonSchemaToTypeBox({ type: 'integer' });
    expect(Value.Check(schema, 42)).toBe(true);
    expect(Value.Check(schema, 3.14)).toBe(false);
  });

  it('converts number type', () => {
    const schema = jsonSchemaToTypeBox({ type: 'number' });
    expect(Value.Check(schema, 3.14)).toBe(true);
    expect(Value.Check(schema, 'abc')).toBe(false);
  });

  it('converts boolean type', () => {
    const schema = jsonSchemaToTypeBox({ type: 'boolean' });
    expect(Value.Check(schema, true)).toBe(true);
    expect(Value.Check(schema, 'true')).toBe(false);
  });

  it('converts null type', () => {
    const schema = jsonSchemaToTypeBox({ type: 'null' });
    expect(Value.Check(schema, null)).toBe(true);
    expect(Value.Check(schema, undefined)).toBe(false);
  });

  it('converts object with properties', () => {
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    });
    expect(Value.Check(schema, { name: 'Alice', age: 30 })).toBe(true);
    expect(Value.Check(schema, { name: 'Alice' })).toBe(true);
    expect(Value.Check(schema, { age: 30 })).toBe(false);
  });

  it('converts array type', () => {
    const schema = jsonSchemaToTypeBox({
      type: 'array',
      items: { type: 'string' },
    });
    expect(Value.Check(schema, ['a', 'b'])).toBe(true);
    expect(Value.Check(schema, [1, 2])).toBe(false);
  });

  it('converts enum', () => {
    const schema = jsonSchemaToTypeBox({ enum: ['a', 'b', 'c'] });
    expect(Value.Check(schema, 'a')).toBe(true);
    expect(Value.Check(schema, 'd')).toBe(false);
  });

  it('converts anyOf', () => {
    const schema = jsonSchemaToTypeBox({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(Value.Check(schema, 'hello')).toBe(true);
    expect(Value.Check(schema, 42)).toBe(true);
    expect(Value.Check(schema, true)).toBe(false);
  });

  it('returns Unknown for unrecognized schema', () => {
    const schema = jsonSchemaToTypeBox({});
    expect(Value.Check(schema, 'anything')).toBe(true);
    expect(Value.Check(schema, 42)).toBe(true);
  });

  it('converts string with constraints', () => {
    const schema = jsonSchemaToTypeBox({ type: 'string', minLength: 2, maxLength: 5 });
    expect(Value.Check(schema, 'ab')).toBe(true);
    expect(Value.Check(schema, 'a')).toBe(false);
    expect(Value.Check(schema, 'abcdef')).toBe(false);
  });

  it('converts object without properties', () => {
    const schema = jsonSchemaToTypeBox({ type: 'object' });
    expect(Value.Check(schema, { any: 'value' })).toBe(true);
  });

  it('converts array without items', () => {
    const schema = jsonSchemaToTypeBox({ type: 'array' });
    expect(Value.Check(schema, [1, 'two', true])).toBe(true);
  });

  it('converts oneOf and tags schema with ONEOF_MARKER', () => {
    const schema = jsonSchemaToTypeBox({
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] },
      ],
    });
    // The marker is used by SchemaValidator to apply exhaustive oneOf semantics
    expect((schema as Record<string, unknown>)['x-apcore-keyword']).toBe('oneOf');
  });

  it('converts allOf and validates all branches are satisfied', () => {
    const schema = jsonSchemaToTypeBox({
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        { type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] },
      ],
    });
    expect(Value.Check(schema, { name: 'Alice', age: 30 })).toBe(true);
    expect(Value.Check(schema, { name: 'Bob' })).toBe(false);
  });

  it('converts not keyword', () => {
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { status: { not: { const: 'deleted' } } },
      required: ['status'],
    });
    expect(Value.Check(schema, { status: 'active' })).toBe(true);
    expect(Value.Check(schema, { status: 'deleted' })).toBe(false);
  });

  it('converts const keyword', () => {
    const schema = jsonSchemaToTypeBox({ const: 'fixed' });
    expect(Value.Check(schema, 'fixed')).toBe(true);
    expect(Value.Check(schema, 'other')).toBe(false);
  });

  it('converts recursive schema with $id and $ref: "#"', () => {
    const schema = jsonSchemaToTypeBox({
      $id: 'TreeNode',
      type: 'object',
      properties: {
        value: { type: 'string' },
        children: { type: 'array', items: { $ref: '#' } },
      },
      required: ['value'],
    });
    const root = { value: 'root', children: [{ value: 'child', children: [{ value: 'leaf' }] }] };
    expect(Value.Check(schema, root)).toBe(true);
    expect(Value.Check(schema, { value: 42 })).toBe(false);
  });

  it('converts numeric constraints (minimum, maximum, exclusiveMinimum)', () => {
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 1, maximum: 100 },
        positive: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['score', 'positive'],
    });
    expect(Value.Check(schema, { score: 50, positive: 0.1 })).toBe(true);
    expect(Value.Check(schema, { score: 0, positive: 0.1 })).toBe(false);
    expect(Value.Check(schema, { score: 50, positive: 0 })).toBe(false);
  });
});
