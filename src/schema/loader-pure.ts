/**
 * Browser-safe portion of the schema loader.
 *
 * Contains the runtime-neutral pieces — JSON-Schema-to-TypeBox conversion and
 * canonical-form async hashing — used by both the Node-side `SchemaLoader` and
 * the browser entry point.
 *
 * No `node:*` imports may be added here. The transitive import graph is
 * audited by `tests/browser-entry.test.ts`.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { ONEOF_MARKER } from './constants.js';

// ---------------------------------------------------------------------------
// Canonical-form serialization (used for content hashing)
// ---------------------------------------------------------------------------

export function sortedKeysStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(sortedKeysStringify).join(',')}]`;
  const sorted = Object.keys(obj as object).sort();
  const pairs = sorted.map(
    (k) => `${JSON.stringify(k)}:${sortedKeysStringify((obj as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(',')}}`;
}

/**
 * Compute the SHA-256 hex digest of the canonical JSON serialization of a
 * schema using the WebCrypto SubtleCrypto API. Output matches `contentHash`
 * (Node-only sync variant) and the Python/Rust SDKs (sync finding A-D-033).
 */
export async function contentHashAsync(schema: unknown): Promise<string> {
  const canonical = sortedKeysStringify(schema);
  type WebCryptoSubtle = {
    digest(algo: string, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
  };
  const subtle: WebCryptoSubtle | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: { subtle?: WebCryptoSubtle } }).crypto?.subtle
      : undefined;
  if (!subtle) {
    throw new Error(
      'contentHashAsync(): no WebCrypto SubtleCrypto available in this runtime.',
    );
  }
  const data = new TextEncoder().encode(canonical);
  const digest = await subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeBox conversion
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema dict to a TypeBox TSchema.
 * Supports recursive schemas via $id + $ref: "#", and oneOf/anyOf/allOf/not.
 */
export function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  if ('$id' in schema && typeof schema['$id'] === 'string') {
    const $id = schema['$id'] as string;
    return Type.Recursive((self) => _convert(schema, self, $id), { $id });
  }
  return _convert(schema, undefined, undefined);
}

function _convert(
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  if ('$ref' in schema) {
    const ref = schema['$ref'] as string;
    if (self !== undefined && (ref === '#' || ref === selfId)) {
      return self;
    }
    return Type.Unknown();
  }

  const schemaType = schema['type'] as string | undefined;

  let result: TSchema;
  if (schemaType === 'object') result = _convertObject(schema, self, selfId);
  else if (schemaType === 'array') result = _convertArray(schema, self, selfId);
  else if (schemaType === 'string') result = _convertString(schema);
  else if (schemaType === 'integer') result = _convertNumeric(schema, Type.Integer);
  else if (schemaType === 'number') result = _convertNumeric(schema, Type.Number);
  else if (schemaType === 'boolean') result = Type.Boolean();
  else if (schemaType === 'null') result = Type.Null();
  else result = _convertCombinator(schema, self, selfId);

  if (typeof schema['description'] === 'string')
    (result as Record<string, unknown>)['description'] = schema['description'];
  if (typeof schema['title'] === 'string')
    (result as Record<string, unknown>)['title'] = schema['title'];

  return result;
}

function _convertObject(
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  const required = new Set((schema['required'] as string[]) ?? []);

  if (properties) {
    const typeboxProps: Record<string, TSchema> = {};
    for (const [name, propSchema] of Object.entries(properties)) {
      const propType = _convert(propSchema, self, selfId);
      typeboxProps[name] = required.has(name) ? propType : Type.Optional(propType);
    }
    return Type.Object(typeboxProps);
  }
  return Type.Record(Type.String(), Type.Unknown());
}

function _convertArray(
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  const items = schema['items'] as Record<string, unknown> | undefined;
  return items ? Type.Array(_convert(items, self, selfId)) : Type.Array(Type.Unknown());
}

function _convertString(schema: Record<string, unknown>): TSchema {
  const opts: Record<string, unknown> = {};
  for (const key of ['minLength', 'maxLength', 'pattern', 'format']) {
    if (key in schema) opts[key] = schema[key];
  }
  return Type.String(opts);
}

function _convertNumeric(
  schema: Record<string, unknown>,
  factory: (opts?: Record<string, unknown>) => TSchema,
): TSchema {
  const opts: Record<string, unknown> = {};
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (key in schema) opts[key] = schema[key];
  }
  return factory(opts);
}

function _convertCombinator(
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  if ('enum' in schema) {
    const values = schema['enum'] as unknown[];
    return Type.Union(
      values.map((v) =>
        v === null ? Type.Null() : Type.Literal(v as string | number | boolean),
      ),
    );
  }
  if ('const' in schema) {
    const value = schema['const'];
    return value === null ? Type.Null() : Type.Literal(value as string | number | boolean);
  }
  if ('oneOf' in schema) {
    const branches = (schema['oneOf'] as Record<string, unknown>[]).map((s) =>
      _convert(s, self, selfId),
    );
    const result = Type.Union(branches) as Record<string, unknown>;
    result[ONEOF_MARKER] = 'oneOf';
    return result as TSchema;
  }
  if ('anyOf' in schema) {
    return Type.Union(
      (schema['anyOf'] as Record<string, unknown>[]).map((s) => _convert(s, self, selfId)),
    );
  }
  if ('allOf' in schema) {
    return Type.Intersect(
      (schema['allOf'] as Record<string, unknown>[]).map((s) => _convert(s, self, selfId)),
    );
  }
  if ('not' in schema) {
    const inner = _convert(schema['not'] as Record<string, unknown>, self, selfId);
    return Type.Not(inner);
  }
  return Type.Unknown();
}
