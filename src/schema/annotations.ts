/**
 * Annotation conflict resolution — merge YAML and code metadata.
 */

import type { ModuleAnnotations, ModuleExample } from '../module.js';
import { DEFAULT_ANNOTATIONS } from '../module.js';

const ANNOTATION_FIELDS: ReadonlyArray<keyof ModuleAnnotations> = [
  'readonly',
  'destructive',
  'idempotent',
  'requiresApproval',
  'openWorld',
  'streaming',
  'cacheable',
  'cacheTtl',
  'cacheKeyFields',
  'paginated',
  'paginationStyle',
];

export function mergeAnnotations(
  yamlAnnotations: Record<string, unknown> | null | undefined,
  codeAnnotations: ModuleAnnotations | null | undefined,
): ModuleAnnotations {
  const values: Record<string, unknown> = {};
  for (const f of ANNOTATION_FIELDS) {
    values[f] = DEFAULT_ANNOTATIONS[f];
  }

  if (codeAnnotations != null) {
    for (const f of ANNOTATION_FIELDS) {
      values[f] = codeAnnotations[f];
    }
  }

  if (yamlAnnotations != null) {
    for (const [key, val] of Object.entries(yamlAnnotations)) {
      if ((ANNOTATION_FIELDS as readonly string[]).includes(key)) {
        values[key] = val;
      }
    }
  }

  return values as unknown as ModuleAnnotations;
}

export function mergeExamples(
  yamlExamples: Array<Record<string, unknown>> | null | undefined,
  codeExamples: ModuleExample[] | null | undefined,
): ModuleExample[] {
  if (yamlExamples != null) {
    return yamlExamples.map((d) => ({
      title: d['title'] as string,
      inputs: (d['inputs'] as Record<string, unknown>) ?? {},
      output: (d['output'] as Record<string, unknown>) ?? {},
      description: d['description'] as string | undefined,
    }));
  }
  if (codeExamples != null) return codeExamples;
  return [];
}

export function mergeMetadata(
  yamlMetadata: Record<string, unknown> | null | undefined,
  codeMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const result = codeMetadata != null ? { ...codeMetadata } : {};
  if (yamlMetadata != null) {
    Object.assign(result, yamlMetadata);
  }
  return result;
}
