/**
 * Registry types: ModuleDescriptor, DiscoveredModule, DependencyInfo.
 */

import type { ModuleAnnotations, ModuleExample } from '../module.js';

export interface ModuleDescriptor {
  moduleId: string;
  name: string | null;
  description: string;
  documentation: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  version: string;
  tags: string[];
  annotations: ModuleAnnotations | null;
  examples: ModuleExample[];
  metadata: Record<string, unknown>;
  sunsetDate: string | null;
}

export interface DiscoveredModule {
  filePath: string;
  canonicalId: string;
  metaPath: string | null;
  namespace: string | null;
}

export interface DependencyInfo {
  moduleId: string;
  version: string | null;
  optional: boolean;
}
