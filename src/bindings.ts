/**
 * YAML binding loader for zero-code-modification module integration.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import yaml from 'js-yaml';
import { FunctionModule } from './decorator.js';

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
let _nodePath: typeof import('node:path') | null = null;
try { _nodeFs = await import('node:fs'); } catch { /* browser environment */ }
try { _nodePath = await import('node:path'); } catch { /* browser environment */ }
import {
  BindingCallableNotFoundError,
  BindingFileInvalidError,
  BindingInvalidTargetError,
  BindingModuleNotFoundError,
  BindingNotCallableError,
} from './errors.js';
import type { Registry } from './registry/registry.js';
import { jsonSchemaToTypeBox } from './schema/loader.js';

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

      const fm = await this._createModuleFromBinding(entryObj, bindingFileDir);
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
      throw new BindingInvalidTargetError(
        `Module path '${modulePath}' must not use file: URLs`,
      );
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
  ): Promise<FunctionModule> {
    const { existsSync, readFileSync } = _nodeFs!;
    const { resolve } = _nodePath!;
    const func = await this.resolveTarget(binding['target'] as string);
    const moduleId = binding['module_id'] as string;

    let inputSchema: TSchema;
    let outputSchema: TSchema;

    if ('input_schema' in binding || 'output_schema' in binding) {
      const inputSchemaDict = (binding['input_schema'] as Record<string, unknown>) ?? {};
      const outputSchemaDict = (binding['output_schema'] as Record<string, unknown>) ?? {};
      inputSchema = jsonSchemaToTypeBox(inputSchemaDict);
      outputSchema = jsonSchemaToTypeBox(outputSchemaDict);
    } else if ('schema_ref' in binding) {
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
      inputSchema = jsonSchemaToTypeBox(
        (refData['input_schema'] as Record<string, unknown>) ?? {},
      );
      outputSchema = jsonSchemaToTypeBox(
        (refData['output_schema'] as Record<string, unknown>) ?? {},
      );
    } else {
      // No schema, use permissive
      inputSchema = Type.Record(Type.String(), Type.Unknown());
      outputSchema = Type.Record(Type.String(), Type.Unknown());
    }

    return new FunctionModule({
      execute: async (inputs, context) => {
        const result = await func(inputs, context);
        if (result === null || result === undefined) return {};
        if (typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
        return { result };
      },
      moduleId,
      inputSchema,
      outputSchema,
      description: (binding['description'] as string) ?? undefined,
      tags: (binding['tags'] as string[]) ?? null,
      version: (binding['version'] as string) ?? '1.0.0',
    });
  }
}
