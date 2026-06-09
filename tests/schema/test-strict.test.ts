import { describe, it, expect } from 'vitest';
import { toStrictSchema, applyLlmDescriptions, stripExtensions } from '../../src/schema/strict.js';

describe('toStrictSchema', () => {
  it('adds additionalProperties: false', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    };
    const strict = toStrictSchema(schema);
    expect(strict['additionalProperties']).toBe(false);
  });

  it('makes all properties required', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    };
    const strict = toStrictSchema(schema);
    expect(strict['required']).toEqual(['age', 'name']);
  });

  it('makes optional properties nullable', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    };
    const strict = toStrictSchema(schema);
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    expect(props['age']['type']).toEqual(['integer', 'null']);
    expect(props['name']['type']).toBe('string');
  });

  it('does not modify original schema', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    toStrictSchema(schema);
    expect(schema['additionalProperties']).toBeUndefined();
  });

  it('strips x- extensions', () => {
    const schema = {
      type: 'object',
      'x-sensitive': true,
      properties: {
        name: { type: 'string', 'x-llm-description': 'Name field' },
      },
    };
    const strict = toStrictSchema(schema);
    expect(strict['x-sensitive']).toBeUndefined();
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    expect(props['name']['x-llm-description']).toBeUndefined();
  });

  it('strips default values', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', default: 'world' },
      },
    };
    const strict = toStrictSchema(schema);
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    expect(props['name']['default']).toBeUndefined();
  });
});

describe('applyLlmDescriptions', () => {
  it('replaces description with x-llm-description', () => {
    const schema = {
      description: 'Original',
      'x-llm-description': 'LLM version',
      properties: {
        name: {
          type: 'string',
          description: 'Name',
          'x-llm-description': 'User name for LLM',
        },
      },
    };
    applyLlmDescriptions(schema);
    expect(schema['description']).toBe('LLM version');
    expect((schema['properties'] as Record<string, Record<string, unknown>>)['name']['description']).toBe('User name for LLM');
  });

  it('does not modify without x-llm-description', () => {
    const schema = { description: 'Original' };
    applyLlmDescriptions(schema);
    expect(schema['description']).toBe('Original');
  });

  it('does not inject a description when only x-llm-description is present', () => {
    const schema: Record<string, unknown> = {
      type: 'string',
      'x-llm-description': 'LLM only',
    };
    applyLlmDescriptions(schema);
    expect('description' in schema).toBe(false);
  });

  it('does not gain a description after strict export when only x-llm-description present', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', 'x-llm-description': 'Name for LLM' },
      },
      required: ['name'],
    };
    applyLlmDescriptions(schema);
    const result = toStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect('description' in props['name']).toBe(false);
  });
});

describe('toStrictSchema - definitions and combinators', () => {
  it('recurses into definitions block', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      definitions: {
        Address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
          required: ['city'],
        },
      },
    };
    const strict = toStrictSchema(schema);
    const defs = strict['definitions'] as Record<string, Record<string, unknown>>;
    expect(defs['Address']['additionalProperties']).toBe(false);
    const addrProps = defs['Address']['properties'] as Record<string, Record<string, unknown>>;
    expect(addrProps['zip']['type']).toEqual(['string', 'null']);
  });

  it('recurses into $defs block', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string' } },
      $defs: {
        Inner: {
          type: 'object',
          properties: {
            a: { type: 'integer' },
            b: { type: 'string' },
          },
          required: ['a'],
        },
      },
    };
    const strict = toStrictSchema(schema);
    const defs = strict['$defs'] as Record<string, Record<string, unknown>>;
    expect(defs['Inner']['additionalProperties']).toBe(false);
    const innerProps = defs['Inner']['properties'] as Record<string, Record<string, unknown>>;
    expect(innerProps['b']['type']).toEqual(['string', 'null']);
  });

  it('recurses into oneOf/anyOf/allOf variants', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
            },
          ],
        },
      },
    };
    const strict = toStrictSchema(schema);
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    const oneOf = props['value']['oneOf'] as Record<string, unknown>[];
    expect(oneOf[0]['additionalProperties']).toBe(false);
  });

  it('appends null to existing oneOf for optional property', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'number' },
          ],
        },
      },
      required: [],
    };
    const strict = toStrictSchema(schema);
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    const oneOf = props['value']['oneOf'] as Record<string, unknown>[];
    expect(oneOf).toHaveLength(3);
    expect(oneOf[2]).toEqual({ type: 'null' });
  });

  it('appends null to existing anyOf for optional property', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { type: 'string' },
            { type: 'integer' },
          ],
        },
      },
      required: [],
    };
    const strict = toStrictSchema(schema);
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    const anyOf = props['value']['anyOf'] as Record<string, unknown>[];
    expect(anyOf).toHaveLength(3);
    expect(anyOf[2]).toEqual({ type: 'null' });
  });

  it('does not double-add null to oneOf that already has null', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'null' },
          ],
        },
      },
      required: [],
    };
    const strict = toStrictSchema(schema);
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    const oneOf = props['value']['oneOf'] as Record<string, unknown>[];
    expect(oneOf).toHaveLength(2);
  });

  it('does not add null to already-nullable type array', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { type: ['string', 'null'] },
      },
      required: [],
    };
    const strict = toStrictSchema(schema);
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    expect(props['value']['type']).toEqual(['string', 'null']);
  });
});

describe('applyLlmDescriptions - definitions and combinators', () => {
  it('recurses into definitions block', () => {
    const schema: Record<string, unknown> = {
      definitions: {
        Foo: { description: 'old', 'x-llm-description': 'new' },
      },
    };
    applyLlmDescriptions(schema);
    const defs = schema['definitions'] as Record<string, Record<string, unknown>>;
    expect(defs['Foo']['description']).toBe('new');
  });

  it('recurses into $defs block', () => {
    const schema: Record<string, unknown> = {
      $defs: {
        Bar: { description: 'old', 'x-llm-description': 'updated' },
      },
    };
    applyLlmDescriptions(schema);
    const defs = schema['$defs'] as Record<string, Record<string, unknown>>;
    expect(defs['Bar']['description']).toBe('updated');
  });

  it('recurses into items', () => {
    const schema: Record<string, unknown> = {
      type: 'array',
      items: { description: 'orig', 'x-llm-description': 'item desc' },
    };
    applyLlmDescriptions(schema);
    const items = schema['items'] as Record<string, unknown>;
    expect(items['description']).toBe('item desc');
  });

  it('recurses into oneOf/anyOf/allOf', () => {
    const schema: Record<string, unknown> = {
      oneOf: [
        { description: 'a', 'x-llm-description': 'variant A' },
        { description: 'b', 'x-llm-description': 'variant B' },
      ],
    };
    applyLlmDescriptions(schema);
    const oneOf = schema['oneOf'] as Record<string, unknown>[];
    expect(oneOf[0]['description']).toBe('variant A');
    expect(oneOf[1]['description']).toBe('variant B');
  });

  it('does not set a description when no prior description exists', () => {
    const schema: Record<string, unknown> = {
      'x-llm-description': 'brand new',
    };
    applyLlmDescriptions(schema);
    expect('description' in schema).toBe(false);
  });
});

describe('stripExtensions', () => {
  it('removes x- prefixed keys', () => {
    const schema: Record<string, unknown> = {
      type: 'string',
      'x-custom': 'value',
      'x-another': 123,
    };
    stripExtensions(schema);
    expect(schema['x-custom']).toBeUndefined();
    expect(schema['x-another']).toBeUndefined();
    expect(schema['type']).toBe('string');
  });

  it('removes default key', () => {
    const schema: Record<string, unknown> = {
      type: 'string',
      default: 'hello',
    };
    stripExtensions(schema);
    expect(schema['default']).toBeUndefined();
  });

  it('handles nested structures', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        name: { type: 'string', 'x-sensitive': true },
      },
    };
    stripExtensions(schema);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['name']['x-sensitive']).toBeUndefined();
  });

  it('recurses into arrays', () => {
    const schema: Record<string, unknown> = {
      oneOf: [
        { type: 'string', 'x-remove': true },
        { type: 'number', default: 0 },
      ],
    };
    stripExtensions(schema);
    const oneOf = schema['oneOf'] as Record<string, unknown>[];
    expect(oneOf[0]['x-remove']).toBeUndefined();
    expect(oneOf[1]['default']).toBeUndefined();
  });
});
