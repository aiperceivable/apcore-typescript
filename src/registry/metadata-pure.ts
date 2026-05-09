/**
 * Pure metadata helpers — used by both the Node-side `Registry.discover`
 * pipeline and the browser-safe Registry surface (which still merges
 * code-side annotations even though it never reads YAML files).
 *
 * The filesystem-touching counterparts (`loadMetadata`, `loadIdMap`)
 * live in `./metadata.ts` and statically import `node:fs`. Browser
 * consumers re-export from here directly.
 */

import type { ModuleAnnotations, ModuleExample } from '../module.js';
import { mergeAnnotations, mergeExamples } from '../schema/annotations.js';
import type { DependencyInfo } from './types.js';

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
  const codeAnnotations =
    (moduleObj['annotations'] as ModuleAnnotations | null | undefined) ?? null;
  const codeExamples =
    (moduleObj['examples'] as ModuleExample[] | null | undefined) ?? null;
  const codeMetadata = (moduleObj['metadata'] as Record<string, unknown>) ?? {};
  const codeDocs = (moduleObj['documentation'] as string) ?? null;

  const yamlMetadata = (meta['metadata'] as Record<string, unknown>) ?? {};
  const mergedMetadata = { ...codeMetadata, ...yamlMetadata };

  // Spec PROTOCOL_SPEC.md §4.13: annotations must be FIELD-LEVEL merged
  // (YAML > code > defaults), not whole-replaced. Delegates to
  // mergeAnnotations / mergeExamples in schema/annotations.ts.
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
    // Tags use an explicit `!= null` check (not `||`) so a deliberately
    // empty YAML list (`tags: []`) overrides code-set tags. Pinned by
    // the "YAML empty array for tags overrides code tags" test.
    tags: meta['tags'] != null ? meta['tags'] : codeTags || [],
    version: (meta['version'] as string) || codeVersion,
    annotations: mergedAnnotations,
    examples: mergedExamples,
    metadata: mergedMetadata,
    documentation: (meta['documentation'] as string) || codeDocs,
  };
}
