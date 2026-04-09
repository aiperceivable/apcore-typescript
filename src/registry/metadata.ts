/**
 * Metadata and ID map loading for the registry system.
 */

import yaml from 'js-yaml';
import { ConfigError, ConfigNotFoundError } from '../errors.js';
import type { ModuleAnnotations, ModuleExample } from '../module.js';
import { mergeAnnotations, mergeExamples } from '../schema/annotations.js';
import type { DependencyInfo } from './types.js';

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
try { _nodeFs = await import('node:fs'); } catch { /* browser environment */ }

export function loadMetadata(metaPath: string): Record<string, unknown> {
  const { existsSync, readFileSync } = _nodeFs!;
  if (!existsSync(metaPath)) return {};

  const content = readFileSync(metaPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (e) {
    throw new ConfigError(`Invalid YAML in metadata file: ${metaPath}`);
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Metadata file must be a YAML mapping: ${metaPath}`);
  }

  return parsed as Record<string, unknown>;
}

export function parseDependencies(depsRaw: Array<Record<string, unknown>>): DependencyInfo[] {
  if (!depsRaw || depsRaw.length === 0) return [];

  const result: DependencyInfo[] = [];
  for (const dep of depsRaw) {
    const moduleId = dep['module_id'] as string | undefined;
    if (!moduleId) {
      console.warn(`[apcore:metadata] Dependency entry missing 'module_id', skipping`);
      continue;
    }
    result.push({
      moduleId,
      version: (dep['version'] as string) ?? null,
      optional: (dep['optional'] as boolean) ?? false,
    });
  }
  return result;
}

export function mergeModuleMetadata(
  moduleObj: Record<string, unknown>,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const codeDesc = (moduleObj['description'] as string) ?? '';
  const codeName = (moduleObj['name'] as string) ?? null;
  const codeTags = (moduleObj['tags'] as string[]) ?? [];
  const codeVersion = (moduleObj['version'] as string) ?? '1.0.0';
  const codeAnnotations = (moduleObj['annotations'] as ModuleAnnotations | null | undefined) ?? null;
  const codeExamples = (moduleObj['examples'] as ModuleExample[] | null | undefined) ?? null;
  const codeMetadata = (moduleObj['metadata'] as Record<string, unknown>) ?? {};
  const codeDocs = (moduleObj['documentation'] as string) ?? null;

  const yamlMetadata = (meta['metadata'] as Record<string, unknown>) ?? {};
  const mergedMetadata = { ...codeMetadata, ...yamlMetadata };

  // Spec PROTOCOL_SPEC.md §4.13: annotations must be FIELD-LEVEL merged
  // (YAML > code > defaults), not whole-replaced. The previous
  // implementation passed `meta['annotations']` through verbatim, which
  // silently dropped any code-set flag the YAML did not also set.
  // Delegates to mergeAnnotations / mergeExamples in schema/annotations.ts.
  const yamlAnnotations = meta['annotations'] as Record<string, unknown> | null | undefined;
  let mergedAnnotations: ModuleAnnotations | null;
  if (yamlAnnotations == null && codeAnnotations == null) {
    mergedAnnotations = null;
  } else {
    mergedAnnotations = mergeAnnotations(yamlAnnotations, codeAnnotations);
  }

  const yamlExamples = meta['examples'] as Array<Record<string, unknown>> | null | undefined;
  const mergedExamples = mergeExamples(yamlExamples, codeExamples);

  return {
    description: (meta['description'] as string) || codeDesc,
    name: (meta['name'] as string) || codeName,
    tags: meta['tags'] != null ? meta['tags'] : codeTags || [],
    version: (meta['version'] as string) || codeVersion,
    annotations: mergedAnnotations,
    examples: mergedExamples,
    metadata: mergedMetadata,
    documentation: (meta['documentation'] as string) || codeDocs,
  };
}

export function loadIdMap(idMapPath: string): Record<string, Record<string, unknown>> {
  const { existsSync, readFileSync } = _nodeFs!;
  if (!existsSync(idMapPath)) {
    throw new ConfigNotFoundError(idMapPath);
  }

  const content = readFileSync(idMapPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (e) {
    throw new ConfigError(`Invalid YAML in ID map file: ${idMapPath}`);
  }

  if (typeof parsed !== 'object' || parsed === null || !('mappings' in (parsed as Record<string, unknown>))) {
    throw new ConfigError("ID map must contain a 'mappings' list");
  }

  const mappings = (parsed as Record<string, unknown>)['mappings'];
  if (!Array.isArray(mappings)) {
    throw new ConfigError("ID map must contain a 'mappings' list");
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const entry of mappings) {
    const filePath = (entry as Record<string, unknown>)['file'] as string;
    if (!filePath) {
      console.warn(`[apcore:metadata] ID map entry missing 'file' field, skipping`);
      continue;
    }
    result[filePath] = {
      id: ((entry as Record<string, unknown>)['id'] as string) ?? filePath,
      class: (entry as Record<string, unknown>)['class'] ?? null,
    };
  }
  return result;
}
