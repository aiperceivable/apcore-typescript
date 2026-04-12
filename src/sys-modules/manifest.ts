/**
 * System manifest modules -- module metadata and full system manifest.
 */

import type { Registry } from '../registry/registry.js';
import type { Config } from '../config.js';
import { InvalidInputError, ModuleNotFoundError } from '../errors.js';

export class ManifestModuleModule {
  readonly description = 'Full manifest for a registered module including source path';
  readonly annotations = { readonly: true, destructive: false, idempotent: true, requiresApproval: false, openWorld: false, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const };
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      module_id: { type: 'string' as const, description: 'ID of the module to inspect' },
    },
    required: ['module_id'],
  };
  readonly outputSchema = {
    type: 'object' as const,
    properties: {
      module_id: { type: 'string' as const, description: 'Module identifier' },
      description: { type: 'string' as const, description: 'Module description' },
      documentation: { description: 'Module documentation (Markdown)' },
      source_path: { type: 'string' as const, description: 'Computed source file path' },
      input_schema: { type: 'object' as const, description: 'Module input JSON Schema' },
      output_schema: { type: 'object' as const, description: 'Module output JSON Schema' },
      annotations: { type: 'object' as const, description: 'Module annotations' },
      tags: { type: 'array' as const, description: 'Module tags' },
      metadata: { type: 'object' as const, description: 'Additional metadata' },
    },
    required: ['module_id', 'description'],
  };

  private readonly _registry: Registry;
  private readonly _config: Config | null;

  constructor(
    registry: Registry,
    config: Config | null = null,
  ) {
    this._registry = registry;
    this._config = config;
  }

  execute(inputs: Record<string, unknown>, _context: unknown): Record<string, unknown> {
    const moduleId = inputs['module_id'];
    if (typeof moduleId !== 'string' || !moduleId) {
      throw new InvalidInputError('module_id is required');
    }

    const descriptor = this._registry.getDefinition(moduleId);
    if (!descriptor) {
      throw new ModuleNotFoundError(moduleId);
    }

    const sourcePath = this._computeSourcePath(moduleId);
    return {
      module_id: descriptor.moduleId,
      description: descriptor.description,
      documentation: descriptor.documentation,
      source_path: sourcePath,
      input_schema: descriptor.inputSchema,
      output_schema: descriptor.outputSchema,
      annotations: descriptor.annotations,
      tags: descriptor.tags,
      metadata: descriptor.metadata ?? {},
    };
  }

  private _computeSourcePath(moduleId: string): string | null {
    if (!this._config) return null;
    const sourceRoot = this._config.get('project.source_root', '') as string;
    if (!sourceRoot) return null;
    const relativePath = moduleId.replace(/\./g, '/') + '.ts';
    return `${sourceRoot}/${relativePath}`;
  }
}

export class ManifestFullModule {
  readonly description = 'Complete system manifest with filtering by prefix and tags';
  readonly annotations = { readonly: true, destructive: false, idempotent: true, requiresApproval: false, openWorld: false, streaming: false, cacheable: false, cacheTtl: 0, cacheKeyFields: null, paginated: false, paginationStyle: 'cursor' as const };
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      include_schemas: { type: 'boolean' as const, description: 'Whether to include input/output schemas', default: true },
      include_source_paths: { type: 'boolean' as const, description: 'Whether to include source paths', default: true },
      prefix: { type: 'string' as const, description: 'Filter modules by ID prefix' },
      tags: { type: 'array' as const, items: { type: 'string' as const }, description: 'Filter modules by tags' },
    },
  };
  readonly outputSchema = {
    type: 'object' as const,
    properties: {
      project_name: { type: 'string' as const, description: 'Project name from config' },
      module_count: { type: 'integer' as const, description: 'Number of modules returned' },
      modules: { type: 'array' as const, description: 'Module manifest entries' },
    },
    required: ['project_name', 'module_count', 'modules'],
  };

  private readonly _registry: Registry;
  private readonly _config: Config | null;

  constructor(
    registry: Registry,
    config: Config | null = null,
  ) {
    this._registry = registry;
    this._config = config;
  }

  execute(inputs: Record<string, unknown>, _context: unknown): Record<string, unknown> {
    const includeSchemas = inputs['include_schemas'] !== false;
    const includeSourcePaths = inputs['include_source_paths'] !== false;
    const prefix = inputs['prefix'] as string | undefined;
    const tags = inputs['tags'] as string[] | undefined;

    const moduleIds = this._registry.list({ prefix, tags });
    const modules: Record<string, unknown>[] = [];

    for (const mid of moduleIds) {
      const descriptor = this._registry.getDefinition(mid);
      if (!descriptor) continue;

      const sourcePath = includeSourcePaths ? this._computeSourcePath(mid) : null;
      modules.push({
        module_id: descriptor.moduleId,
        description: descriptor.description,
        documentation: descriptor.documentation,
        source_path: sourcePath,
        input_schema: includeSchemas ? descriptor.inputSchema : null,
        output_schema: includeSchemas ? descriptor.outputSchema : null,
        annotations: descriptor.annotations,
        tags: descriptor.tags,
        metadata: descriptor.metadata ?? {},
      });
    }

    const projectName = (this._config?.get('project.name', '') ?? '') as string;
    return { project_name: projectName, module_count: modules.length, modules };
  }

  private _computeSourcePath(moduleId: string): string | null {
    if (!this._config) return null;
    const sourceRoot = this._config.get('project.source_root', '') as string;
    if (!sourceRoot) return null;
    return `${sourceRoot}/${moduleId.replace(/\./g, '/')}.ts`;
  }
}
