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

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
let _nodePath: typeof import('node:path') | null = null;
try { _nodeFs = await import('node:fs'); } catch { /* browser environment */ }
try { _nodePath = await import('node:path'); } catch { /* browser environment */ }

export class SchemaLoader {
  private _config: Config;
  private _schemasDir: string;
  private _resolver: RefResolver;
  private _schemaCache: Map<string, SchemaDefinition> = new Map();
  private _modelCache: Map<string, [ResolvedSchema, ResolvedSchema]> = new Map();

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
    const cached = this._modelCache.get(moduleId);
    if (cached) return cached;

    const strategyMap: Record<string, SchemaStrategy> = {
      yaml_first: SchemaStrategy.YAML_FIRST,
      native_first: SchemaStrategy.NATIVE_FIRST,
      yaml_only: SchemaStrategy.YAML_ONLY,
    };
    const rawStrategy = this._config.get('schema.strategy', 'yaml_first') as string;
    const strategy = strategyMap[rawStrategy] ?? SchemaStrategy.YAML_FIRST;

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

    this._modelCache.set(moduleId, result);
    return result;
  }

  private _loadAndResolve(moduleId: string): [ResolvedSchema, ResolvedSchema] {
    const cached = this._modelCache.get(moduleId);
    if (cached) return cached;
    const sd = this.load(moduleId);
    const result = this.resolve(sd);
    this._modelCache.set(moduleId, result);
    return result;
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
    this._modelCache.clear();
    this._resolver.clearCache();
  }
}

/**
 * Convert a JSON Schema dict to a TypeBox TSchema.
 * Since TypeBox schemas ARE JSON Schema, this wraps the raw object
 * so it can be used with Value.Check/Value.Decode.
 */
export function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  const schemaType = schema['type'] as string | undefined;

  let result: TSchema;
  if (schemaType === 'object') result = convertObjectSchema(schema);
  else if (schemaType === 'array') result = convertArraySchema(schema);
  else if (schemaType === 'string') result = convertStringSchema(schema);
  else if (schemaType === 'integer') result = convertNumericSchema(schema, Type.Integer);
  else if (schemaType === 'number') result = convertNumericSchema(schema, Type.Number);
  else if (schemaType === 'boolean') result = Type.Boolean();
  else if (schemaType === 'null') result = Type.Null();
  else result = convertCombinatorSchema(schema);

  // Preserve JSON Schema metadata
  if (typeof schema['description'] === 'string') result['description'] = schema['description'];
  if (typeof schema['title'] === 'string') result['title'] = schema['title'];

  return result;
}

function convertObjectSchema(schema: Record<string, unknown>): TSchema {
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  const required = new Set((schema['required'] as string[]) ?? []);

  if (properties) {
    const typeboxProps: Record<string, TSchema> = {};
    for (const [name, propSchema] of Object.entries(properties)) {
      const propType = jsonSchemaToTypeBox(propSchema);
      typeboxProps[name] = required.has(name) ? propType : Type.Optional(propType);
    }
    return Type.Object(typeboxProps);
  }
  return Type.Record(Type.String(), Type.Unknown());
}

function convertArraySchema(schema: Record<string, unknown>): TSchema {
  const items = schema['items'] as Record<string, unknown> | undefined;
  return items ? Type.Array(jsonSchemaToTypeBox(items)) : Type.Array(Type.Unknown());
}

function convertStringSchema(schema: Record<string, unknown>): TSchema {
  const opts: Record<string, unknown> = {};
  for (const key of ['minLength', 'maxLength', 'pattern', 'format']) {
    if (key in schema) opts[key] = schema[key];
  }
  return Type.String(opts);
}

function convertNumericSchema(
  schema: Record<string, unknown>,
  factory: (opts?: Record<string, unknown>) => TSchema,
): TSchema {
  const opts: Record<string, unknown> = {};
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (key in schema) opts[key] = schema[key];
  }
  return factory(opts);
}

function convertCombinatorSchema(schema: Record<string, unknown>): TSchema {
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
    return Type.Union((schema['oneOf'] as Record<string, unknown>[]).map(jsonSchemaToTypeBox));
  }
  if ('anyOf' in schema) {
    return Type.Union((schema['anyOf'] as Record<string, unknown>[]).map(jsonSchemaToTypeBox));
  }
  if ('allOf' in schema) {
    return Type.Intersect((schema['allOf'] as Record<string, unknown>[]).map(jsonSchemaToTypeBox));
  }
  return Type.Unknown();
}
