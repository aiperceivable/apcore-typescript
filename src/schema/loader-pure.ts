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
import { registerFormatAsAnnotation } from './formats.js';

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

  const rawType = schema['type'];
  const schemaType = rawType as string | undefined;

  let result: TSchema;
  if (Array.isArray(rawType)) result = _convertTypeUnion(schema, rawType, self, selfId);
  else if (schemaType === 'object') result = _convertObject(schema, self, selfId);
  else if (schemaType === 'array') result = _convertArray(schema, self, selfId);
  else if (schemaType === 'string') result = _convertString(schema);
  else if (schemaType === 'integer') result = _convertNumeric(schema, Type.Integer);
  else if (schemaType === 'number') result = _convertNumeric(schema, Type.Number);
  else if (schemaType === 'boolean') result = Type.Boolean();
  else if (schemaType === 'null') result = Type.Null();
  else {
    // No `type` at all — the combinator keywords are the whole schema.
    return _annotate(_convertCombinator(schema, self, selfId), schema);
  }

  // `type` and a combinator keyword are independent assertions that must BOTH
  // hold (JSON Schema 2020-12 §10.2). Converting only the `type` half silently
  // dropped `enum` / `const` / `anyOf` / `allOf` / `not`, so
  // `{type: ["string","boolean"], enum: ["always","auto","never"]}` accepted any
  // string at all — apcore-rust and apcore-python both reject a non-member.
  result = _intersectWithCombinator(result, schema, self, selfId);

  return _annotate(result, schema);
}

/** Copy the annotation keywords onto the converted node. */
function _annotate(result: TSchema, schema: Record<string, unknown>): TSchema {
  if (typeof schema['description'] === 'string')
    (result as Record<string, unknown>)['description'] = schema['description'];
  if (typeof schema['title'] === 'string')
    (result as Record<string, unknown>)['title'] = schema['title'];
  return result;
}

/** Assertion keywords that constrain a value independently of its `type`. */
const COMBINATOR_KEYWORDS: readonly string[] = [
  'enum',
  'const',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
];

/**
 * Intersect a type-derived schema with the constraint its combinator siblings
 * express, so both halves are enforced. Returns `typed` unchanged when the
 * schema carries no combinator keyword.
 */
function _intersectWithCombinator(
  typed: TSchema,
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  if (!COMBINATOR_KEYWORDS.some((keyword) => keyword in schema)) return typed;
  return Type.Intersect([typed, _convertCombinator(schema, self, selfId)]);
}

/**
 * A `type` array (`["string", "boolean"]`, `["string", "null"]`) means "any one
 * of these types", so it converts to a union of the same schema narrowed to each
 * member. Converting it to `unknown` would accept values of every other type as
 * well — apcore-rust rejects them, and apexe emits `["string", "boolean"]` for
 * value-optional flags.
 *
 * The branches carry only the type-specific option keywords; `description` /
 * `title` belong on the union node and the combinator keywords are intersected
 * with the whole union by the caller, so both are stripped here.
 */
function _convertTypeUnion(
  schema: Record<string, unknown>,
  types: unknown[],
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  const branchSchema: Record<string, unknown> = { ...schema };
  for (const keyword of ['description', 'title', ...COMBINATOR_KEYWORDS]) {
    delete branchSchema[keyword];
  }
  const branches = types
    .filter((t): t is string => typeof t === 'string')
    .map((t) => _convert({ ...branchSchema, type: t }, self, selfId));
  return branches.length > 0 ? Type.Union(branches) : Type.Unknown();
}

function _convertObject(
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  const required = new Set((schema['required'] as string[]) ?? []);
  const opts = _additionalPropertiesOption(schema, self, selfId);

  if (properties) {
    const typeboxProps: Record<string, TSchema> = {};
    for (const [name, propSchema] of Object.entries(properties)) {
      const propType = _convert(propSchema, self, selfId);
      typeboxProps[name] = required.has(name) ? propType : Type.Optional(propType);
    }
    return Type.Object(typeboxProps, opts);
  }
  if (opts) return Type.Object({}, opts);
  return Type.Record(Type.String(), Type.Unknown());
}

/**
 * Translate `additionalProperties` into the TypeBox object option. Ignoring it
 * let unknown properties through, while apcore-python (`extra="forbid"`) and
 * apcore-rust both reject them. `true` (the default) needs no option.
 */
function _additionalPropertiesOption(
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): { additionalProperties: false | TSchema } | undefined {
  const additional = schema['additionalProperties'];
  if (additional === false) return { additionalProperties: false };
  if (additional !== null && typeof additional === 'object' && !Array.isArray(additional)) {
    return {
      additionalProperties: _convert(additional as Record<string, unknown>, self, selfId),
    };
  }
  return undefined;
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
  // The `format` value is carried through as an annotation. TypeBox rejects a
  // string whose format is not in its global registry, so register it as an
  // accept-everything checker — JSON Schema 2020-12 requires an unrecognised
  // format to be collected, not asserted (apexe#32).
  if (typeof opts['format'] === 'string') registerFormatAsAnnotation(opts['format']);
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
