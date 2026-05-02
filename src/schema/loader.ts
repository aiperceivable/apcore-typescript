/**
 * SchemaLoader — primary entry point for the schema system.
 *
 * Uses TypeBox for schema representation. Since TypeBox schemas ARE JSON Schema,
 * the conversion layer is minimal.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import yaml from 'js-yaml';
import type { Config } from '../config.js';
import { SchemaNotFoundError, SchemaParseError } from '../errors.js';
import { RefResolver } from './ref-resolver.js';
import type { ResolvedSchema, SchemaDefinition } from './types.js';
import { SchemaStrategy } from './types.js';
import { ONEOF_MARKER } from './constants.js';

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
let _nodePath: typeof import('node:path') | null = null;
let _nodeCrypto: typeof import('node:crypto') | null = null;
try { _nodeFs = await import('node:fs'); } catch { /* browser environment */ }
try { _nodePath = await import('node:path'); } catch { /* browser environment */ }
try { _nodeCrypto = await import('node:crypto'); } catch { /* browser environment */ }


export class SchemaLoader {
  private _config: Config;
  private _schemasDir: string;
  private _resolver: RefResolver;
  private _schemaCache: Map<string, SchemaDefinition> = new Map();
  // Two-level content-addressable cache (Issue #44 §5)
  private _pathIndex: Map<string, string> = new Map();           // `${path}:${strategy}` → sha256hex
  private _contentCache: Map<string, [ResolvedSchema, ResolvedSchema]> = new Map(); // sha256hex → model

  constructor(config: Config, schemasDir?: string | null) {
    const { resolve } = _nodePath!;
    this._config = config;
    if (schemasDir != null) {
      this._schemasDir = resolve(schemasDir);
    } else {
      this._schemasDir = resolve(config.get('schema.root', './schemas') as string);
    }
    const maxDepth = (config.get('schema.max_ref_depth', 32) as number);
    this._resolver = new RefResolver(this._schemasDir, maxDepth);
  }

  load(moduleId: string): SchemaDefinition {
    const cached = this._schemaCache.get(moduleId);
    if (cached) return cached;

    const { existsSync, readFileSync } = _nodeFs!;
    const { join } = _nodePath!;
    const filePath = join(this._schemasDir, moduleId.replace(/\./g, '/') + '.schema.yaml');
    if (!existsSync(filePath)) {
      throw new SchemaNotFoundError(moduleId);
    }

    let data: unknown;
    try {
      data = yaml.load(readFileSync(filePath, 'utf-8'));
    } catch (e) {
      throw new SchemaParseError(`Invalid YAML in schema for '${moduleId}': ${e}`);
    }

    if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
      throw new SchemaParseError(`Schema file for '${moduleId}' is empty or not a mapping`);
    }

    const dataObj = data as Record<string, unknown>;
    for (const fieldName of ['input_schema', 'output_schema', 'description']) {
      if (!(fieldName in dataObj)) {
        throw new SchemaParseError(`Missing required field: ${fieldName} in schema for '${moduleId}'`);
      }
    }

    const definitions: Record<string, unknown> = {
      ...((dataObj['definitions'] as Record<string, unknown>) ?? {}),
      ...((dataObj['$defs'] as Record<string, unknown>) ?? {}),
    };

    const sd: SchemaDefinition = {
      moduleId: (dataObj['module_id'] as string) ?? moduleId,
      description: dataObj['description'] as string,
      inputSchema: dataObj['input_schema'] as Record<string, unknown>,
      outputSchema: dataObj['output_schema'] as Record<string, unknown>,
      errorSchema: (dataObj['error_schema'] as Record<string, unknown>) ?? null,
      definitions,
      version: (dataObj['version'] as string) ?? '1.0.0',
      documentation: (dataObj['documentation'] as string) ?? null,
      schemaUrl: (dataObj['$schema'] as string) ?? null,
    };

    this._schemaCache.set(moduleId, sd);
    return sd;
  }

  resolve(schemaDef: SchemaDefinition): [ResolvedSchema, ResolvedSchema] {
    const resolvedInput = this._resolver.resolve(schemaDef.inputSchema);
    const resolvedOutput = this._resolver.resolve(schemaDef.outputSchema);

    const inputSchema = jsonSchemaToTypeBox(resolvedInput);
    const outputSchema = jsonSchemaToTypeBox(resolvedOutput);

    const inputRs: ResolvedSchema = {
      jsonSchema: resolvedInput,
      schema: inputSchema,
      moduleId: schemaDef.moduleId,
      direction: 'input',
    };
    const outputRs: ResolvedSchema = {
      jsonSchema: resolvedOutput,
      schema: outputSchema,
      moduleId: schemaDef.moduleId,
      direction: 'output',
    };
    return [inputRs, outputRs];
  }

  getSchema(
    moduleId: string,
    nativeInputSchema?: TSchema | null,
    nativeOutputSchema?: TSchema | null,
  ): [ResolvedSchema, ResolvedSchema] {
    const rawStrategy = this._config.get('schema.strategy', 'yaml_first') as string;
    const strategyMap: Record<string, SchemaStrategy> = {
      yaml_first: SchemaStrategy.YAML_FIRST,
      native_first: SchemaStrategy.NATIVE_FIRST,
      yaml_only: SchemaStrategy.YAML_ONLY,
    };
    const strategy = strategyMap[rawStrategy] ?? SchemaStrategy.YAML_FIRST;

    // Check path index first
    const pathKey = `${moduleId}:${strategy}`;
    const cachedHash = this._pathIndex.get(pathKey);
    if (cachedHash) {
      return this._contentCache.get(cachedHash)!;
    }

    let result: [ResolvedSchema, ResolvedSchema] | null = null;

    if (strategy === SchemaStrategy.YAML_FIRST) {
      try {
        result = this._loadAndResolve(moduleId);
      } catch (e) {
        if (e instanceof SchemaNotFoundError && nativeInputSchema && nativeOutputSchema) {
          result = this._wrapNative(moduleId, nativeInputSchema, nativeOutputSchema);
        } else {
          throw e;
        }
      }
    } else if (strategy === SchemaStrategy.NATIVE_FIRST) {
      if (nativeInputSchema && nativeOutputSchema) {
        result = this._wrapNative(moduleId, nativeInputSchema, nativeOutputSchema);
      } else {
        result = this._loadAndResolve(moduleId);
      }
    } else if (strategy === SchemaStrategy.YAML_ONLY) {
      result = this._loadAndResolve(moduleId);
    }

    if (result === null) {
      throw new SchemaNotFoundError(moduleId);
    }

    // Store in two-level cache — hash BOTH schemas to avoid cross-module collision
    // when two distinct modules share an identical input schema but differ in output.
    const digest = contentHash({ input: result[0].jsonSchema, output: result[1].jsonSchema });
    if (!this._contentCache.has(digest)) {
      this._contentCache.set(digest, result);
    }
    this._pathIndex.set(pathKey, digest);

    return this._contentCache.get(digest)!;
  }

  private _loadAndResolve(moduleId: string): [ResolvedSchema, ResolvedSchema] {
    const sd = this.load(moduleId);
    return this.resolve(sd);
  }

  private _wrapNative(
    moduleId: string,
    inputSchema: TSchema,
    outputSchema: TSchema,
  ): [ResolvedSchema, ResolvedSchema] {
    const inputRs: ResolvedSchema = {
      jsonSchema: inputSchema as unknown as Record<string, unknown>,
      schema: inputSchema,
      moduleId,
      direction: 'input',
    };
    const outputRs: ResolvedSchema = {
      jsonSchema: outputSchema as unknown as Record<string, unknown>,
      schema: outputSchema,
      moduleId,
      direction: 'output',
    };
    return [inputRs, outputRs];
  }

  clearCache(): void {
    this._schemaCache.clear();
    this._pathIndex.clear();
    this._contentCache.clear();
    this._resolver.clearCache();
  }
}

// ---------------------------------------------------------------------------
// Content-addressable hashing (Issue #44 §5)
// ---------------------------------------------------------------------------

function sortedKeysStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(sortedKeysStringify).join(',')}]`;
  const sorted = Object.keys(obj as object).sort();
  const pairs = sorted.map(
    (k) => `${JSON.stringify(k)}:${sortedKeysStringify((obj as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(',')}}`;
}

/**
 * Compute the SHA-256 hex digest of the canonical JSON serialization of a schema.
 * Canonical form: sorted keys, no extra whitespace.
 *
 * Sync API — Node.js only. In environments without `node:crypto` (browsers,
 * some edge runtimes), this throws so callers cannot accidentally consume a
 * different hash than apcore-python / apcore-rust would produce. Spec
 * §schema-system §4.15.5 requires sha256 of canonical JSON; a non-sha256
 * fallback collides with cross-language cache keys (sync finding A-D-033).
 *
 * Use {@link contentHashAsync} in browsers — it uses WebCrypto SubtleCrypto
 * to compute the same SHA-256 digest asynchronously.
 */
export function contentHash(schema: unknown): string {
  const canonical = sortedKeysStringify(schema);
  if (_nodeCrypto) {
    return _nodeCrypto.createHash('sha256').update(canonical).digest('hex');
  }
  throw new Error(
    'contentHash() requires node:crypto for synchronous SHA-256. ' +
      'In browser/edge environments, call contentHashAsync() instead — ' +
      'it uses the WebCrypto SubtleCrypto API to produce the spec-compliant digest.',
  );
}

/**
 * Compute the SHA-256 hex digest of the canonical JSON serialization of a schema
 * — async, runtime-portable variant.
 *
 * Uses Node's `node:crypto` when available, otherwise falls back to the
 * WebCrypto `crypto.subtle.digest('SHA-256', ...)` API present in modern
 * browsers and edge runtimes. Output is identical across all paths and
 * matches the Python/Rust SDKs (sync finding A-D-033).
 */
export async function contentHashAsync(schema: unknown): Promise<string> {
  const canonical = sortedKeysStringify(schema);
  if (_nodeCrypto) {
    return _nodeCrypto.createHash('sha256').update(canonical).digest('hex');
  }
  // Browser / edge runtime — WebCrypto.subtle is the only spec-compliant path.
  // Typed structurally so this file compiles without browser DOM lib types.
  type WebCryptoSubtle = { digest(algo: string, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> };
  const subtle: WebCryptoSubtle | undefined =
    (typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: { subtle?: WebCryptoSubtle } }).crypto?.subtle
      : undefined);
  if (!subtle) {
    throw new Error(
      'contentHashAsync(): no SHA-256 implementation available — neither node:crypto nor WebCrypto SubtleCrypto is present in this runtime.',
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
  // Recursive schema: $id present → wrap in Type.Recursive to support self-references
  if ('$id' in schema && typeof schema['$id'] === 'string') {
    const $id = schema['$id'] as string;
    return Type.Recursive(
      (self) => _convert(schema, self, $id),
      { $id },
    );
  }
  return _convert(schema, undefined, undefined);
}

function _convert(
  schema: Record<string, unknown>,
  self: TSchema | undefined,
  selfId: string | undefined,
): TSchema {
  // Handle $ref — may be a self-reference in a recursive schema
  if ('$ref' in schema) {
    const ref = schema['$ref'] as string;
    if (self !== undefined && (ref === '#' || ref === selfId)) {
      return self;
    }
    // Unresolved external $ref (should have been inlined by RefResolver)
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

  // Preserve JSON Schema metadata
  if (typeof schema['description'] === 'string') (result as Record<string, unknown>)['description'] = schema['description'];
  if (typeof schema['title'] === 'string') (result as Record<string, unknown>)['title'] = schema['title'];

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
  return items
    ? Type.Array(_convert(items, self, selfId))
    : Type.Array(Type.Unknown());
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
    return Type.Union(values.map((v) =>
      v === null ? Type.Null() : Type.Literal(v as string | number | boolean),
    ));
  }
  if ('const' in schema) {
    const value = schema['const'];
    return value === null ? Type.Null() : Type.Literal(value as string | number | boolean);
  }
  if ('oneOf' in schema) {
    const branches = (schema['oneOf'] as Record<string, unknown>[]).map((s) => _convert(s, self, selfId));
    // Mark with ONEOF_MARKER so SchemaValidator can apply exhaustive oneOf semantics
    const result = Type.Union(branches) as Record<string, unknown>;
    result[ONEOF_MARKER] = 'oneOf';
    return result as TSchema;
  }
  if ('anyOf' in schema) {
    return Type.Union((schema['anyOf'] as Record<string, unknown>[]).map((s) => _convert(s, self, selfId)));
  }
  if ('allOf' in schema) {
    return Type.Intersect((schema['allOf'] as Record<string, unknown>[]).map((s) => _convert(s, self, selfId)));
  }
  if ('not' in schema) {
    const inner = _convert(schema['not'] as Record<string, unknown>, self, selfId);
    return Type.Not(inner);
  }
  return Type.Unknown();
}
