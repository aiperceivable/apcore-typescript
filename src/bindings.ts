/**
 * YAML binding loader for zero-code-modification module integration.
 */

import { type TSchema, Type } from '@sinclair/typebox';
import yaml from 'js-yaml';
import { FunctionModule } from './decorator.js';

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
let _nodePath: typeof import('node:path') | null = null;
try {
  _nodeFs = await import('node:fs');
} catch {
  /* browser environment */
}
try {
  _nodePath = await import('node:path');
} catch {
  /* browser environment */
}
import {
  BindingCallableNotFoundError,
  BindingFileInvalidError,
  BindingInvalidTargetError,
  BindingModuleNotFoundError,
  BindingNotCallableError,
  BindingSchemaInferenceFailedError,
  BindingSchemaModeConflictError,
} from './errors.js';
import type { Registry } from './registry/registry.js';
import { inferSchemasFromModule } from './schema/extractor.js';
import { jsonSchemaToTypeBox } from './schema/loader.js';

import type { ModuleAnnotations } from './module.js';
import { DEFAULT_ANNOTATIONS } from './module.js';

const SUPPORTED_SPEC_VERSIONS = new Set(['1.0']);

/**
 * Convert a snake_case YAML annotations dict to a typed ModuleAnnotations.
 * Unknown keys go into `extra`.
 */
function parseAnnotations(raw: Record<string, unknown>): ModuleAnnotations {
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (
      ![
        'readonly',
        'destructive',
        'idempotent',
        'requires_approval',
        'open_world',
        'streaming',
        'cacheable',
        'cache_ttl',
        'cache_key_fields',
        'paginated',
        'pagination_style',
        'extra',
      ].includes(key)
    ) {
      extra[key] = raw[key];
    }
  }
  const rawExtra = (raw['extra'] as Record<string, unknown>) ?? {};
  return {
    readonly: (raw['readonly'] as boolean) ?? DEFAULT_ANNOTATIONS.readonly,
    destructive: (raw['destructive'] as boolean) ?? DEFAULT_ANNOTATIONS.destructive,
    idempotent: (raw['idempotent'] as boolean) ?? DEFAULT_ANNOTATIONS.idempotent,
    requiresApproval: (raw['requires_approval'] as boolean) ?? DEFAULT_ANNOTATIONS.requiresApproval,
    openWorld: (raw['open_world'] as boolean) ?? DEFAULT_ANNOTATIONS.openWorld,
    streaming: (raw['streaming'] as boolean) ?? DEFAULT_ANNOTATIONS.streaming,
    cacheable: (raw['cacheable'] as boolean) ?? DEFAULT_ANNOTATIONS.cacheable,
    cacheTtl: (raw['cache_ttl'] as number) ?? DEFAULT_ANNOTATIONS.cacheTtl,
    cacheKeyFields:
      (raw['cache_key_fields'] as string[] | null) ?? DEFAULT_ANNOTATIONS.cacheKeyFields,
    paginated: (raw['paginated'] as boolean) ?? DEFAULT_ANNOTATIONS.paginated,
    paginationStyle: (raw['pagination_style'] as string) ?? DEFAULT_ANNOTATIONS.paginationStyle,
    extra: { ...rawExtra, ...extra },
  };
}

export class BindingLoader {
  async loadBindings(filePath: string, registry: Registry): Promise<FunctionModule[]> {
    const { readFileSync } = _nodeFs!;
    const { dirname } = _nodePath!;
    const bindingFileDir = dirname(filePath);

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (e) {
      throw new BindingFileInvalidError(filePath, String(e));
    }

    let data: unknown;
    try {
      data = yaml.load(content);
    } catch (e) {
      throw new BindingFileInvalidError(filePath, `YAML parse error: ${e}`);
    }

    if (data === null || data === undefined) {
      throw new BindingFileInvalidError(filePath, 'File is empty');
    }

    const dataObj = data as Record<string, unknown>;

    const specVersion = dataObj['spec_version'] as string | undefined;
    if (specVersion == null) {
      console.warn(
        `[apcore:bindings] ${filePath}: spec_version missing; defaulting to '1.0'. ` +
          'spec_version will be mandatory in spec 1.1. See DECLARATIVE_CONFIG_SPEC.md §2.4',
      );
    } else if (!SUPPORTED_SPEC_VERSIONS.has(specVersion)) {
      console.warn(
        `[apcore:bindings] ${filePath}: spec_version '${specVersion}' is newer than supported; proceeding best-effort.`,
      );
    }

    if (!('bindings' in dataObj)) {
      throw new BindingFileInvalidError(filePath, "Missing 'bindings' key");
    }

    const bindings = dataObj['bindings'];
    if (!Array.isArray(bindings)) {
      throw new BindingFileInvalidError(filePath, "'bindings' must be a list");
    }

    const results: FunctionModule[] = [];
    for (const entry of bindings) {
      const entryObj = entry as Record<string, unknown>;
      if (!('module_id' in entryObj)) {
        throw new BindingFileInvalidError(filePath, "Binding entry missing 'module_id'");
      }
      if (!('target' in entryObj)) {
        throw new BindingFileInvalidError(filePath, "Binding entry missing 'target'");
      }

      const fm = await this._createModuleFromBinding(entryObj, bindingFileDir, filePath);
      registry.register(entryObj['module_id'] as string, fm);
      results.push(fm);
    }

    return results;
  }

  async loadBindingDir(
    dirPath: string,
    registry: Registry,
    pattern: string = '*.binding.yaml',
  ): Promise<FunctionModule[]> {
    const { existsSync, statSync, readdirSync } = _nodeFs!;
    const { join } = _nodePath!;
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      throw new BindingFileInvalidError(dirPath, 'Directory does not exist');
    }

    const files = readdirSync(dirPath)
      .filter((f) => {
        // Simple glob matching for *.binding.yaml
        const suffix = pattern.replace('*', '');
        return f.endsWith(suffix);
      })
      .sort();

    const results: FunctionModule[] = [];
    for (const f of files) {
      const fms = await this.loadBindings(join(dirPath, f), registry);
      results.push(...fms);
    }
    return results;
  }

  async resolveTarget(targetString: string): Promise<(...args: unknown[]) => unknown> {
    if (!targetString.includes(':')) {
      throw new BindingInvalidTargetError(targetString);
    }

    const [modulePath, callableName] = targetString.split(':', 2);

    if (modulePath.includes('..')) {
      throw new BindingInvalidTargetError(
        `Module path '${modulePath}' must not contain '..' segments`,
      );
    }

    if (modulePath.startsWith('file:')) {
      throw new BindingInvalidTargetError(`Module path '${modulePath}' must not use file: URLs`);
    }

    let mod: Record<string, unknown>;
    try {
      mod = await import(modulePath);
    } catch (e) {
      throw new BindingModuleNotFoundError(modulePath);
    }

    if (callableName.includes('.')) {
      const [className, methodName] = callableName.split('.', 2);
      const cls = mod[className];
      if (cls == null) {
        throw new BindingCallableNotFoundError(className, modulePath);
      }
      let instance: Record<string, unknown>;
      try {
        instance = new (cls as new () => Record<string, unknown>)();
      } catch {
        throw new BindingCallableNotFoundError(callableName, modulePath);
      }
      const method = instance[methodName];
      if (method == null) {
        throw new BindingCallableNotFoundError(callableName, modulePath);
      }
      if (typeof method !== 'function') {
        throw new BindingNotCallableError(targetString);
      }
      return method.bind(instance) as (...args: unknown[]) => unknown;
    }

    const result = mod[callableName];
    if (result == null) {
      throw new BindingCallableNotFoundError(callableName, modulePath);
    }
    if (typeof result !== 'function') {
      throw new BindingNotCallableError(targetString);
    }
    return result as (...args: unknown[]) => unknown;
  }

  private async _createModuleFromBinding(
    binding: Record<string, unknown>,
    bindingFileDir: string,
    filePath?: string,
  ): Promise<FunctionModule> {
    const { existsSync, readFileSync } = _nodeFs!;
    const { resolve } = _nodePath!;
    const targetString = binding['target'] as string;
    const func = await this.resolveTarget(targetString);
    const moduleId = binding['module_id'] as string;

    // Detect schema mode conflicts (DECLARATIVE_CONFIG_SPEC.md §3.4)
    const modes: string[] = [];
    if ('auto_schema' in binding) modes.push('auto_schema');
    if ('input_schema' in binding || 'output_schema' in binding)
      modes.push('input_schema/output_schema');
    if ('schema_ref' in binding) modes.push('schema_ref');
    if (modes.length > 1) {
      throw new BindingSchemaModeConflictError(moduleId, modes, filePath);
    }

    let inputSchema: TSchema;
    let outputSchema: TSchema;

    if ('input_schema' in binding || 'output_schema' in binding) {
      // Mode 1: explicit schemas
      const inputSchemaDict = (binding['input_schema'] as Record<string, unknown>) ?? {};
      const outputSchemaDict = (binding['output_schema'] as Record<string, unknown>) ?? {};
      inputSchema = jsonSchemaToTypeBox(inputSchemaDict);
      outputSchema = jsonSchemaToTypeBox(outputSchemaDict);
    } else if ('schema_ref' in binding) {
      // Mode 2: external reference
      const refPath = resolve(bindingFileDir, binding['schema_ref'] as string);
      if (!existsSync(refPath)) {
        throw new BindingFileInvalidError(refPath, 'Schema reference file not found');
      }
      let refData: Record<string, unknown>;
      try {
        refData = (yaml.load(readFileSync(refPath, 'utf-8')) as Record<string, unknown>) ?? {};
      } catch (e) {
        throw new BindingFileInvalidError(refPath, `YAML parse error: ${e}`);
      }
      inputSchema = jsonSchemaToTypeBox((refData['input_schema'] as Record<string, unknown>) ?? {});
      outputSchema = jsonSchemaToTypeBox(
        (refData['output_schema'] as Record<string, unknown>) ?? {},
      );
    } else {
      // Mode 3 (explicit auto_schema) or Mode 4 (implicit default = auto)
      // Try to infer schemas from the target module's exports.
      const [modulePath, symbolName] = targetString.split(':', 2);
      let inferred: { input: TSchema; output: TSchema } | null = null;
      try {
        const mod = (await import(modulePath)) as Record<string, unknown>;
        inferred = inferSchemasFromModule(mod, symbolName);
      } catch {
        // Module already resolved in resolveTarget; if re-import fails,
        // fall through to permissive/error below.
      }

      if (inferred) {
        inputSchema = inferred.input;
        outputSchema = inferred.output;
      } else if ('auto_schema' in binding && binding['auto_schema'] !== false) {
        // Explicit auto_schema but inference failed → error
        throw new BindingSchemaInferenceFailedError(targetString, moduleId, filePath);
      } else if ('auto_schema' in binding && binding['auto_schema'] === false) {
        // Explicit auto_schema: false → error (no mode left)
        throw new BindingSchemaInferenceFailedError(
          targetString,
          moduleId,
          filePath,
          'auto_schema is explicitly false; provide input_schema/output_schema or schema_ref instead.',
        );
      } else {
        // Implicit default: no mode specified, inference didn't find schemas.
        // Per spec §3.4, implicit auto is the default. If inference fails,
        // fall back to permissive schema (matches TypeScript pre-0.19.0 behavior).
        inputSchema = Type.Record(Type.String(), Type.Unknown());
        outputSchema = Type.Record(Type.String(), Type.Unknown());
      }
    }

    return new FunctionModule({
      execute: async (inputs, context) => {
        const result = await func(inputs, context);
        if (result === null || result === undefined) return {};
        if (typeof result === 'object' && !Array.isArray(result))
          return result as Record<string, unknown>;
        return { result };
      },
      moduleId,
      inputSchema,
      outputSchema,
      description: (binding['description'] as string) ?? undefined,
      documentation: (binding['documentation'] as string) ?? undefined,
      tags: (binding['tags'] as string[]) ?? null,
      version: (binding['version'] as string) ?? '1.0.0',
      annotations: binding['annotations']
        ? parseAnnotations(binding['annotations'] as Record<string, unknown>)
        : undefined,
      metadata: binding['metadata'] as Record<string, unknown> | undefined,
    });
  }
}
