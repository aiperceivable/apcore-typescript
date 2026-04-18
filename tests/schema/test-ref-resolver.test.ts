import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RefResolver } from '../../src/schema/ref-resolver.js';
import { SchemaCircularRefError, SchemaNotFoundError, SchemaParseError } from '../../src/errors.js';

describe('RefResolver', () => {
  it('resolves local $ref', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      type: 'object',
      properties: {
        name: { $ref: '#/definitions/NameType' },
      },
      definitions: {
        NameType: { type: 'string' },
      },
    };
    const resolved = resolver.resolve(schema);
    expect((resolved['properties'] as Record<string, unknown>)['name']).toEqual({ type: 'string' });
  });

  it('detects circular references', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      definitions: {
        A: { $ref: '#/definitions/B' },
        B: { $ref: '#/definitions/A' },
      },
      type: 'object',
      properties: {
        x: { $ref: '#/definitions/A' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaCircularRefError);
  });

  it('resolves nested $ref', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      type: 'object',
      properties: {
        user: { $ref: '#/definitions/User' },
      },
      definitions: {
        User: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    };
    const resolved = resolver.resolve(schema);
    const user = (resolved['properties'] as Record<string, unknown>)['user'] as Record<string, unknown>;
    expect(user['type']).toBe('object');
    expect(user['properties']).toBeDefined();
  });

  it('throws SchemaNotFoundError for missing pointer segment', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: '#/definitions/Missing' },
      },
      definitions: {},
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaNotFoundError);
  });

  it('clearCache works', () => {
    const resolver = new RefResolver('/tmp/schemas');
    resolver.clearCache();
    // Should not throw
  });

  it('respects max depth', () => {
    const resolver = new RefResolver('/tmp/schemas', 2);
    // Properties must come before definitions so the $ref chain isn't
    // collapsed by in-place resolution of definitions first.
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: '#/definitions/A' },
      },
      definitions: {
        A: { $ref: '#/definitions/B' },
        B: { $ref: '#/definitions/C' },
        C: { type: 'string' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaCircularRefError);
  });

  it('resolves schema without $ref unchanged', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    };
    const resolved = resolver.resolve(schema);
    expect(resolved).toEqual(schema);
  });
});

describe('RefResolver - apcore:// URI resolution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apcore-ref-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves apcore:// URI to schema file and JSON pointer', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'foo.schema.yaml'),
      'type: object\nproperties:\n  name:\n    type: string\n',
    );

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        field: { $ref: 'apcore://foo/properties/name' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, unknown>;
    expect(props['field']).toEqual({ type: 'string' });
  });

  it('resolves apcore:// URI without pointer to full document', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'bar.schema.yaml'),
      'type: string\ndescription: a bar\n',
    );

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'apcore://bar' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, unknown>;
    expect(props['x']).toEqual({ type: 'string', description: 'a bar' });
  });
});

describe('RefResolver - array element ref resolution', () => {
  it('resolves $ref inside array elements', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      definitions: {
        Tag: { type: 'string' },
      },
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: [
            { $ref: '#/definitions/Tag' },
            { $ref: '#/definitions/Tag' },
          ],
        },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, Record<string, unknown>>;
    const items = props['tags']['items'] as Record<string, unknown>[];
    expect(items[0]).toEqual({ type: 'string' });
    expect(items[1]).toEqual({ type: 'string' });
  });

  it('resolves $ref inside oneOf array', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      definitions: {
        Str: { type: 'string' },
        Num: { type: 'number' },
      },
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { $ref: '#/definitions/Str' },
            { $ref: '#/definitions/Num' },
          ],
        },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, Record<string, unknown>>;
    const oneOf = props['value']['oneOf'] as Record<string, unknown>[];
    expect(oneOf[0]).toEqual({ type: 'string' });
    expect(oneOf[1]).toEqual({ type: 'number' });
  });
});

describe('RefResolver - file loading edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apcore-ref-load-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles empty YAML files gracefully', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(join(schemasDir, 'empty.schema.yaml'), '');

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'empty.schema.yaml' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, unknown>;
    expect(props['x']).toEqual({});
  });

  it('handles YAML file with only whitespace', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(join(schemasDir, 'whitespace.schema.yaml'), '   \n  \n  ');

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'whitespace.schema.yaml' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, unknown>;
    expect(props['x']).toEqual({});
  });

  it('throws SchemaParseError for invalid YAML', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(join(schemasDir, 'bad.schema.yaml'), ':\n  - :\n    :\n  invalid: [}');

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'bad.schema.yaml' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaParseError);
  });

  it('throws SchemaParseError when YAML file is a scalar not a mapping', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(join(schemasDir, 'scalar.schema.yaml'), '"just a string"');

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'scalar.schema.yaml' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaParseError);
  });

  it('throws SchemaParseError when YAML file is a list not a mapping', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(join(schemasDir, 'list.schema.yaml'), '- one\n- two\n');

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'list.schema.yaml' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaParseError);
  });

  it('throws SchemaNotFoundError for missing file', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'nonexistent.yaml' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaNotFoundError);
  });
});

describe('RefResolver - path traversal guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apcore-ref-guard-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws SchemaNotFoundError when ref resolves outside schemas dir', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: '../../etc/passwd' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaNotFoundError);
    expect(() => resolver.resolve(schema)).toThrow(/resolves outside schemas directory/);
  });

  it('throws SchemaNotFoundError for file#pointer ref outside schemas dir', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: '../outside.yaml#/foo' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaNotFoundError);
    expect(() => resolver.resolve(schema)).toThrow(/resolves outside schemas directory/);
  });

  it('rejects refs into a sibling directory whose name shares a prefix with schemas dir', () => {
    // Regression: the earlier guard used `startsWith(schemasDir + '/')` which
    // is both path-separator dependent AND vulnerable to sibling directories
    // whose name happens to share a common prefix. The cross-platform
    // path.relative() based check rejects them consistently.
    const schemasDir = join(tmpDir, 'schemas');
    const siblingDir = join(tmpDir, 'schemas_evil');
    mkdirSync(schemasDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, 'sneaky.yaml'), 'type: string\n');

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: '../schemas_evil/sneaky.yaml' },
      },
    };
    expect(() => resolver.resolve(schema)).toThrow(SchemaNotFoundError);
    expect(() => resolver.resolve(schema)).toThrow(/resolves outside schemas directory/);
  });
});

describe('RefResolver - clearCache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apcore-ref-cache-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clears cached file content so subsequent resolve re-reads files', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(join(schemasDir, 'mutable.schema.yaml'), 'type: string\n');

    const resolver = new RefResolver(schemasDir);

    const schema1 = { type: 'object', properties: { x: { $ref: 'mutable.schema.yaml' } } };
    const resolved1 = resolver.resolve(schema1);
    const props1 = resolved1['properties'] as Record<string, Record<string, unknown>>;
    expect(props1['x']['type']).toBe('string');

    writeFileSync(join(schemasDir, 'mutable.schema.yaml'), 'type: integer\n');

    // Without clearing cache, old value is served
    const schema2 = { type: 'object', properties: { x: { $ref: 'mutable.schema.yaml' } } };
    const resolvedCached = resolver.resolve(schema2);
    const propsCached = resolvedCached['properties'] as Record<string, Record<string, unknown>>;
    expect(propsCached['x']['type']).toBe('string');

    // After clearing, new value is read
    resolver.clearCache();
    const schema3 = { type: 'object', properties: { x: { $ref: 'mutable.schema.yaml' } } };
    const resolvedFresh = resolver.resolve(schema3);
    const propsFresh = resolvedFresh['properties'] as Record<string, Record<string, unknown>>;
    expect(propsFresh['x']['type']).toBe('integer');
  });
});

describe('RefResolver - nested $ref resolution', () => {
  it('resolves a $ref that points to another $ref (chain)', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      definitions: {
        Alias: { $ref: '#/definitions/Actual' },
        Actual: { type: 'number' },
      },
      type: 'object',
      properties: {
        val: { $ref: '#/definitions/Alias' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, Record<string, unknown>>;
    expect(props['val']).toEqual({ type: 'number' });
  });

  it('resolves sibling keys alongside $ref', () => {
    const resolver = new RefResolver('/tmp/schemas');
    const schema = {
      definitions: {
        Base: { type: 'string' },
      },
      type: 'object',
      properties: {
        val: { $ref: '#/definitions/Base', description: 'overridden' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, Record<string, unknown>>;
    expect(props['val']['type']).toBe('string');
    expect(props['val']['description']).toBe('overridden');
  });
});

describe('RefResolver - cross-file $ref', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apcore-ref-cross-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves file.yaml#/pointer format', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'shared.yaml'),
      'definitions:\n  Email:\n    type: string\n    format: email\n',
    );

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        email: { $ref: 'shared.yaml#/definitions/Email' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, Record<string, unknown>>;
    expect(props['email']).toEqual({ type: 'string', format: 'email' });
  });

  it('resolves file.yaml without pointer to full document', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'simple.yaml'),
      'type: boolean\n',
    );

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        flag: { $ref: 'simple.yaml' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, Record<string, unknown>>;
    expect(props['flag']).toEqual({ type: 'boolean' });
  });

  it('resolves cross-file ref with currentFile context', () => {
    const schemasDir = join(tmpDir, 'schemas');
    const subDir = join(schemasDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(schemasDir, 'types.yaml'),
      'definitions:\n  Id:\n    type: integer\n',
    );
    writeFileSync(
      join(subDir, 'model.yaml'),
      'type: object\nproperties:\n  id:\n    $ref: "../types.yaml#/definitions/Id"\n',
    );

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        model: { $ref: 'sub/model.yaml' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, Record<string, unknown>>;
    const model = props['model'] as Record<string, unknown>;
    const modelProps = model['properties'] as Record<string, Record<string, unknown>>;
    expect(modelProps['id']).toEqual({ type: 'integer' });
  });

  it('resolves YAML with null-parsed content as empty object', () => {
    const schemasDir = join(tmpDir, 'schemas');
    mkdirSync(schemasDir, { recursive: true });
    // YAML "null" keyword parses to null
    writeFileSync(join(schemasDir, 'nulldoc.yaml'), 'null\n');

    const resolver = new RefResolver(schemasDir);
    const schema = {
      type: 'object',
      properties: {
        x: { $ref: 'nulldoc.yaml' },
      },
    };
    const resolved = resolver.resolve(schema);
    const props = resolved['properties'] as Record<string, unknown>;
    expect(props['x']).toEqual({});
  });
});
