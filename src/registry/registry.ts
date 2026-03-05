/**
 * Central module registry for discovering, registering, and querying modules.
 */

import type { Config } from '../config.js';
import { InvalidInputError, ModuleNotFoundError } from '../errors.js';
import type { ModuleAnnotations, ModuleExample } from '../module.js';
import { resolveDependencies } from './dependencies.js';
import { resolveEntryPoint } from './entry-point.js';
import { mergeModuleMetadata, parseDependencies } from './metadata.js';
import type { DependencyInfo, ModuleDescriptor } from './types.js';
import { validateModule } from './validation.js';

// ── Lazy-loaded Node.js modules ────────────────────────────────────
// These are loaded on first use so that importing Registry in a browser
// bundler does not fail at parse time. Only the filesystem-dependent
// methods (discover, watch, constructor with idMapPath) trigger the load.
// We use dynamic import() to avoid any top-level reference to node: modules.

let _nodeFs: typeof import('node:fs') | null = null;
let _nodePath: typeof import('node:path') | null = null;

async function ensureNodeModules(): Promise<{
  fs: typeof import('node:fs');
  path: typeof import('node:path');
}> {
  if (_nodeFs === null) {
    _nodeFs = await import('node:fs');
  }
  if (_nodePath === null) {
    _nodePath = await import('node:path');
  }
  return { fs: _nodeFs, path: _nodePath };
}

async function lazyLoadIdMap(idMapPath: string): Promise<Record<string, Record<string, unknown>>> {
  const { loadIdMap } = await import('./metadata.js');
  return loadIdMap(idMapPath);
}

async function lazyLoadMetadata(metaPath: string): Promise<Record<string, unknown>> {
  const { loadMetadata } = await import('./metadata.js');
  return loadMetadata(metaPath);
}

async function lazyScanExtensions(
  root: string, maxDepth: number, followSymlinks: boolean,
): Promise<import('./types.js').DiscoveredModule[]> {
  const { scanExtensions } = await import('./scanner.js');
  return scanExtensions(root, maxDepth, followSymlinks);
}

async function lazyScanMultiRoot(
  roots: Array<Record<string, unknown>>, maxDepth: number, followSymlinks: boolean,
): Promise<import('./types.js').DiscoveredModule[]> {
  const { scanMultiRoot } = await import('./scanner.js');
  return scanMultiRoot(roots, maxDepth, followSymlinks);
}

/**
 * Standard registry event names.
 */
export const REGISTRY_EVENTS = Object.freeze({
  REGISTER: "register",
  UNREGISTER: "unregister",
} as const);

/**
 * Valid module ID pattern. Only lowercase letters, digits, underscores, and dots.
 * Hyphens are prohibited to ensure bijective MCP/OpenAI tool name normalization.
 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Maximum allowed length for a module ID.
 */
export const MAX_MODULE_ID_LENGTH = 128;

/**
 * Reserved words that cannot appear as any segment of a module ID.
 */
export const RESERVED_WORDS = new Set(['system', 'internal', 'core', 'apcore', 'plugin', 'schema', 'acl']);

/**
 * Interface for custom module discovery.
 */
export interface Discoverer {
  discover(roots: string[]): Array<{ moduleId: string; module: unknown }> | Promise<Array<{ moduleId: string; module: unknown }>>;
}

/**
 * Interface for custom module validation.
 */
export interface ModuleValidator {
  validate(module: unknown): string[] | Promise<string[]>;
}

type EventCallback = (moduleId: string, module: unknown) => void;

export class Registry {
  private _extensionRoots: Array<Record<string, unknown>>;
  private _modules: Map<string, unknown> = new Map();
  private _moduleMeta: Map<string, Record<string, unknown>> = new Map();
  private _callbacks: Map<string, EventCallback[]> = new Map([
    [REGISTRY_EVENTS.REGISTER, []],
    [REGISTRY_EVENTS.UNREGISTER, []],
  ]);
  private _idMap: Record<string, Record<string, unknown>> = {};
  private _schemaCache: Map<string, Record<string, unknown>> = new Map();
  private _config: Config | null;
  private _watchers?: Array<{ close(): void }>;
  private _debounceTimers?: Map<string, number>;
  private _customDiscoverer: Discoverer | null = null;
  private _customValidator: ModuleValidator | null = null;
  private _idMapPath: string | null = null;
  private _idMapLoaded = false;

  // Safe hot-reload state (F09 / Algorithm A21)
  private _refCounts: Map<string, number> = new Map();
  private _draining: Set<string> = new Set();
  private _drainResolvers: Map<string, Array<() => void>> = new Map();

  constructor(options?: {
    config?: Config | null;
    extensionsDir?: string | null;
    extensionsDirs?: Array<string | Record<string, unknown>> | null;
    idMapPath?: string | null;
  }) {
    const config = options?.config ?? null;
    const extensionsDir = options?.extensionsDir ?? null;
    const extensionsDirs = options?.extensionsDirs ?? null;

    if (extensionsDir !== null && extensionsDirs !== null) {
      throw new InvalidInputError('Cannot specify both extensionsDir and extensionsDirs');
    }

    if (extensionsDir !== null) {
      this._extensionRoots = [{ root: extensionsDir }];
    } else if (extensionsDirs !== null) {
      this._extensionRoots = extensionsDirs.map((item) =>
        typeof item === 'string' ? { root: item } : item,
      );
    } else if (config !== null) {
      const extRoot = config.get('extensions.root') as string | undefined;
      this._extensionRoots = [{ root: extRoot ?? './extensions' }];
    } else {
      this._extensionRoots = [{ root: './extensions' }];
    }

    this._config = config;
    this._idMapPath = options?.idMapPath ?? null;
  }

  /** Lazily load the ID map from disk on first discover(). */
  private async _ensureIdMap(): Promise<void> {
    if (this._idMapLoaded || this._idMapPath === null) return;
    this._idMap = await lazyLoadIdMap(this._idMapPath);
    this._idMapLoaded = true;
  }

  setDiscoverer(discoverer: Discoverer): void {
    this._customDiscoverer = discoverer;
  }

  setValidator(validator: ModuleValidator): void {
    this._customValidator = validator;
  }

  async discover(): Promise<number> {
    if (this._customDiscoverer !== null) {
      return this._discoverCustom();
    }
    return this._discoverDefault();
  }

  private async _discoverCustom(): Promise<number> {
    const rootPaths = this._extensionRoots.map((r) => r['root'] as string);
    const customModules = await this._customDiscoverer!.discover(rootPaths);

    let count = 0;
    for (const entry of customModules) {
      const { moduleId, module: mod } = entry;

      // Apply custom validator if set
      if (this._customValidator !== null) {
        const errors = await this._customValidator.validate(mod);
        if (errors.length > 0) {
          console.warn(
            `[apcore:registry] Custom validator rejected module '${moduleId}': ${errors.join('; ')}`,
          );
          continue;
        }
      }

      try {
        this.register(moduleId, mod);
        count++;
      } catch (e) {
        console.warn(`[apcore:registry] Failed to register custom-discovered module '${moduleId}':`, e);
      }
    }

    return count;
  }

  private async _discoverDefault(): Promise<number> {
    await this._ensureIdMap();
    const discovered = await this._scanRoots();
    await this._applyIdMapOverrides(discovered);

    const rawMetadata = await this._loadAllMetadata(discovered);
    const resolvedModules = await this._resolveAllEntryPoints(discovered, rawMetadata);
    const validModules = await this._validateAll(resolvedModules);
    const loadOrder = this._resolveLoadOrder(validModules, rawMetadata);

    return this._registerInOrder(loadOrder, validModules, rawMetadata);
  }

  private async _scanRoots(): Promise<import('./types.js').DiscoveredModule[]> {
    let maxDepth = 8;
    let followSymlinks = false;
    if (this._config !== null) {
      maxDepth = (this._config.get('extensions.max_depth', 8) as number);
      followSymlinks = (this._config.get('extensions.follow_symlinks', false) as boolean);
    }

    const hasNamespace = this._extensionRoots.some((r) => 'namespace' in r);
    if (this._extensionRoots.length > 1 || hasNamespace) {
      return lazyScanMultiRoot(this._extensionRoots, maxDepth, followSymlinks);
    }
    return lazyScanExtensions(this._extensionRoots[0]['root'] as string, maxDepth, followSymlinks);
  }

  private async _applyIdMapOverrides(discovered: import('./types.js').DiscoveredModule[]): Promise<void> {
    if (Object.keys(this._idMap).length === 0) return;

    const { path: nodePath } = await ensureNodeModules();
    const resolvedRoots = this._extensionRoots.map((r) => nodePath.resolve(r['root'] as string));
    for (const dm of discovered) {
      for (const root of resolvedRoots) {
        try {
          const relPath = dm.filePath.startsWith(root)
            ? dm.filePath.slice(root.length + 1)
            : null;
          if (relPath && relPath in this._idMap) {
            dm.canonicalId = this._idMap[relPath]['id'] as string;
            break;
          }
        } catch (e) {
          console.warn(`[apcore:registry] Failed to apply ID map for ${dm.canonicalId}:`, e);
          continue;
        }
      }
    }
  }

  private async _loadAllMetadata(
    discovered: import('./types.js').DiscoveredModule[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const rawMetadata = new Map<string, Record<string, unknown>>();
    for (const dm of discovered) {
      rawMetadata.set(dm.canonicalId, dm.metaPath ? await lazyLoadMetadata(dm.metaPath) : {});
    }
    return rawMetadata;
  }

  private async _resolveAllEntryPoints(
    discovered: import('./types.js').DiscoveredModule[],
    rawMetadata: Map<string, Record<string, unknown>>,
  ): Promise<Map<string, unknown>> {
    const resolvedModules = new Map<string, unknown>();
    for (const dm of discovered) {
      const meta = rawMetadata.get(dm.canonicalId) ?? {};
      try {
        const mod = await resolveEntryPoint(dm.filePath, meta);
        resolvedModules.set(dm.canonicalId, mod);
      } catch (e) {
        console.warn(`[apcore:registry] Failed to resolve entry point for ${dm.canonicalId}:`, e);
      }
    }
    return resolvedModules;
  }

  private async _validateAll(resolvedModules: Map<string, unknown>): Promise<Map<string, unknown>> {
    const validModules = new Map<string, unknown>();
    for (const [modId, mod] of resolvedModules) {
      if (this._customValidator !== null) {
        const errors = await this._customValidator.validate(mod);
        if (errors.length === 0) {
          validModules.set(modId, mod);
        }
      } else if (validateModule(mod).length === 0) {
        validModules.set(modId, mod);
      }
    }
    return validModules;
  }

  private _resolveLoadOrder(
    validModules: Map<string, unknown>,
    rawMetadata: Map<string, Record<string, unknown>>,
  ): string[] {
    const modulesWithDeps: Array<[string, DependencyInfo[]]> = [];
    for (const modId of validModules.keys()) {
      const meta = rawMetadata.get(modId) ?? {};
      const depsRaw = (meta['dependencies'] as Array<Record<string, unknown>>) ?? [];
      modulesWithDeps.push([modId, depsRaw.length > 0 ? parseDependencies(depsRaw) : []]);
    }
    const knownIds = new Set(modulesWithDeps.map(([id]) => id));
    return resolveDependencies(modulesWithDeps, knownIds);
  }

  private _registerInOrder(
    loadOrder: string[],
    validModules: Map<string, unknown>,
    rawMetadata: Map<string, Record<string, unknown>>,
  ): number {
    let count = 0;
    for (const modId of loadOrder) {
      const mod = validModules.get(modId)!;
      const modObj = mod as Record<string, unknown>;
      const mergedMeta = mergeModuleMetadata(modObj, rawMetadata.get(modId) ?? {});

      this._modules.set(modId, mod);
      this._moduleMeta.set(modId, mergedMeta);

      if (typeof modObj['onLoad'] === 'function') {
        try {
          (modObj['onLoad'] as () => void)();
        } catch (e) {
          console.warn(`[apcore:registry] onLoad failed for ${modId}, skipping:`, e);
          this._modules.delete(modId);
          this._moduleMeta.delete(modId);
          continue;
        }
      }

      this._triggerEvent(REGISTRY_EVENTS.REGISTER, modId, mod);
      count++;
    }
    return count;
  }

  register(moduleId: string, module: unknown): void {
    if (!moduleId || typeof moduleId !== "string") {
      throw new InvalidInputError("Module ID must be a non-empty string");
    }
    if (!MODULE_ID_PATTERN.test(moduleId)) {
      throw new InvalidInputError(
        `Invalid module ID: "${moduleId}". Must match pattern: ${MODULE_ID_PATTERN} (lowercase, digits, underscores, dots only; no hyphens)`,
      );
    }

    const parts = moduleId.split('.');
    for (const part of parts) {
      if (RESERVED_WORDS.has(part)) {
        throw new InvalidInputError(`Module ID contains reserved word: '${part}'`);
      }
    }
    if (moduleId.length > MAX_MODULE_ID_LENGTH) {
      throw new InvalidInputError(`Module ID exceeds maximum length of ${MAX_MODULE_ID_LENGTH}: ${moduleId.length}`);
    }

    if (this._modules.has(moduleId)) {
      throw new InvalidInputError(`Module already exists: ${moduleId}`);
    }

    this._modules.set(moduleId, module);

    // Populate metadata from the module object
    const modObj = module as Record<string, unknown>;
    this._moduleMeta.set(moduleId, mergeModuleMetadata(modObj, {}));

    // Call onLoad if available
    if (typeof modObj['onLoad'] === 'function') {
      try {
        (modObj['onLoad'] as () => void)();
      } catch (e) {
        this._modules.delete(moduleId);
        this._moduleMeta.delete(moduleId);
        throw e;
      }
    }

    this._triggerEvent(REGISTRY_EVENTS.REGISTER, moduleId, module);
  }

  unregister(moduleId: string): boolean {
    if (!this._modules.has(moduleId)) return false;

    const module = this._modules.get(moduleId)!;
    this._modules.delete(moduleId);
    this._moduleMeta.delete(moduleId);
    this._schemaCache.delete(moduleId);

    // Call onUnload if available
    const modObj = module as Record<string, unknown>;
    if (typeof modObj['onUnload'] === 'function') {
      try {
        (modObj['onUnload'] as () => void)();
      } catch (e) {
        console.warn(`[apcore:registry] onUnload failed for ${moduleId}:`, e);
      }
    }

    this._triggerEvent(REGISTRY_EVENTS.UNREGISTER, moduleId, module);
    return true;
  }

  get(moduleId: string): unknown | null {
    if (moduleId === '') {
      throw new ModuleNotFoundError('');
    }
    return this._modules.get(moduleId) ?? null;
  }

  has(moduleId: string): boolean {
    return this._modules.has(moduleId);
  }

  list(options?: { tags?: string[]; prefix?: string }): string[] {
    let ids = [...this._modules.keys()];

    if (options?.prefix != null) {
      ids = ids.filter((id) => id.startsWith(options.prefix!));
    }

    if (options?.tags != null) {
      const tagSet = new Set(options.tags);
      ids = ids.filter((id) => {
        const mod = this._modules.get(id) as Record<string, unknown>;
        const modTags = new Set((mod['tags'] as string[]) ?? []);
        const metaTags = (this._moduleMeta.get(id) ?? {})['tags'];
        if (Array.isArray(metaTags)) {
          for (const t of metaTags) modTags.add(t as string);
        }
        for (const t of tagSet) {
          if (!modTags.has(t)) return false;
        }
        return true;
      });
    }

    return ids.sort();
  }

  iter(): IterableIterator<[string, unknown]> {
    return this._modules.entries();
  }

  get count(): number {
    return this._modules.size;
  }

  get moduleIds(): string[] {
    return [...this._modules.keys()].sort();
  }

  getDefinition(moduleId: string): ModuleDescriptor | null {
    const module = this._modules.get(moduleId);
    if (module == null) return null;
    const meta = this._moduleMeta.get(moduleId) ?? {};
    const mod = module as Record<string, unknown>;

    return {
      moduleId,
      name: ((meta['name'] as string) ?? (mod['name'] as string)) ?? null,
      description: ((meta['description'] as string) ?? (mod['description'] as string)) ?? '',
      documentation: ((meta['documentation'] as string) ?? (mod['documentation'] as string)) ?? null,
      inputSchema: (mod['inputSchema'] as Record<string, unknown>) ?? {},
      outputSchema: (mod['outputSchema'] as Record<string, unknown>) ?? {},
      version: ((meta['version'] as string) ?? (mod['version'] as string)) ?? '1.0.0',
      tags: (meta['tags'] as string[]) ?? (mod['tags'] as string[]) ?? [],
      annotations: (mod['annotations'] as ModuleAnnotations) ?? null,
      examples: (mod['examples'] as ModuleExample[]) ?? [],
      metadata: (meta['metadata'] as Record<string, unknown>) ?? {},
    };
  }

  describe(moduleId: string): string {
    const module = this.get(moduleId);
    if (module === null) {
      throw new ModuleNotFoundError(moduleId);
    }

    // Check for custom describe method
    const modObj = module as Record<string, unknown>;
    if (typeof modObj['describe'] === 'function') {
      return (modObj['describe'] as () => string)();
    }

    // Auto-generate from descriptor
    const descriptor = this.getDefinition(moduleId);
    if (descriptor === null) {
      return `Module: ${moduleId}\n\nNo description available.`;
    }

    const lines: string[] = [`# ${descriptor.moduleId}`];
    if (descriptor.description) {
      lines.push(`\n${descriptor.description}`);
    }
    if (descriptor.tags.length > 0) {
      lines.push(`\n**Tags:** ${descriptor.tags.join(', ')}`);
    }
    const props = descriptor.inputSchema['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (props && Object.keys(props).length > 0) {
      lines.push('\n**Parameters:**');
      const requiredFields = (descriptor.inputSchema['required'] as string[]) ?? [];
      for (const [param, schema] of Object.entries(props)) {
        const paramType = (schema['type'] as string) ?? 'any';
        const paramDesc = (schema['description'] as string) ?? '';
        const isRequired = requiredFields.includes(param);
        const reqMarker = isRequired ? ' (required)' : '';
        lines.push(`- \`${param}\` (${paramType})${reqMarker}: ${paramDesc}`);
      }
    }
    if (descriptor.documentation) {
      lines.push(`\n**Documentation:**\n${descriptor.documentation}`);
    }
    return lines.join('\n');
  }

  on(event: string, callback: EventCallback): void {
    const validEvents = Object.values(REGISTRY_EVENTS) as string[];
    if (!validEvents.includes(event)) {
      throw new InvalidInputError(
        `Invalid event: ${event}. Must be one of: ${validEvents.map((e) => `'${e}'`).join(', ')}`,
      );
    }
    this._callbacks.get(event)!.push(callback);
  }

  private _triggerEvent(event: string, moduleId: string, module: unknown): void {
    const callbacks = this._callbacks.get(event) ?? [];
    for (const cb of callbacks) {
      try {
        cb(moduleId, module);
      } catch (e) {
        console.warn(`[apcore:registry] Event callback error for '${event}' on ${moduleId}:`, e);
      }
    }
  }

  async watch(): Promise<void> {
    if (this._watchers && this._watchers.length > 0) {
      return; // Already watching
    }

    const { fs, path: nodePath } = await ensureNodeModules();
    const { join } = nodePath;

    this._watchers = [];
    this._debounceTimers = new Map<string, number>();

    for (const root of this._extensionRoots) {
      const rootPath = typeof root === "string" ? root : (root as Record<string, unknown>).root as string;
      if (!rootPath) continue;

      try {
        const watcher = fs.watch(rootPath, { recursive: true }, (eventType: string, filename: string | null) => {
          if (!filename) return;
          if (!filename.endsWith(".ts") && !filename.endsWith(".js")) return;

          const fullPath = join(rootPath, filename);
          const now = Date.now();
          const last = this._debounceTimers?.get(fullPath) ?? 0;
          if (now - last < 300) return;
          this._debounceTimers?.set(fullPath, now);

          if (eventType === "rename") {
            // Could be create or delete
            try {
              fs.accessSync(fullPath);
              this._handleFileChange(fullPath);
            } catch {
              this._handleFileDeletion(fullPath);
            }
          } else {
            this._handleFileChange(fullPath);
          }
        });
        this._watchers.push(watcher);
      } catch {
        // Skip directories that don't exist
      }
    }
  }

  unwatch(): void {
    if (this._watchers) {
      for (const watcher of this._watchers) {
        watcher.close();
      }
      this._watchers = [];
    }
    this._debounceTimers = undefined;
  }

  private async _handleFileChange(filePath: string): Promise<void> {
    const { path: nodePath } = await ensureNodeModules();
    const { basename, extname } = nodePath;
    const moduleId = this._pathToModuleId(filePath);

    if (moduleId && this.has(moduleId)) {
      const oldModule = this.get(moduleId) as Record<string, unknown> | null;
      if (oldModule && typeof oldModule.onUnload === "function") {
        try { oldModule.onUnload(); } catch { /* ignore */ }
      }
      this.unregister(moduleId);
    }

    // Re-import is complex in ES modules - emit event for user to handle
    this._triggerEvent("register", moduleId ?? basename(filePath, extname(filePath)), null);
  }

  private async _handleFileDeletion(path: string): Promise<void> {
    const moduleId = this._pathToModuleId(path);
    if (moduleId && this.has(moduleId)) {
      const module = this.get(moduleId) as Record<string, unknown> | null;
      if (module && typeof module.onUnload === "function") {
        try { module.onUnload(); } catch { /* ignore */ }
      }
      this.unregister(moduleId);
    }
  }

  private _pathToModuleId(filePath: string): string | null {
    // _nodePath is guaranteed loaded when this is called from watch/handleFile*
    const { basename, extname } = _nodePath!;
    const base = basename(filePath, extname(filePath));
    for (const mid of this.moduleIds) {
      if (mid.endsWith(base) || mid === base) {
        return mid;
      }
    }
    return null;
  }

  clearCache(): void {
    this._schemaCache.clear();
  }

  // ── Safe Hot-Reload (F09 / Algorithm A21) ───────────────────────

  /**
   * Number of in-flight executions per module.
   */
  get refCount(): ReadonlyMap<string, number> {
    return new Map(this._refCounts);
  }

  /**
   * Acquire a reference to a module for execution.
   *
   * Increments the reference count. Throws ModuleNotFoundError if the
   * module is draining or not registered. Call {@link release} when done.
   */
  acquire(moduleId: string): unknown {
    if (this._draining.has(moduleId)) {
      throw new ModuleNotFoundError(moduleId);
    }
    const mod = this._modules.get(moduleId);
    if (mod == null) {
      throw new ModuleNotFoundError(moduleId);
    }
    this._refCounts.set(moduleId, (this._refCounts.get(moduleId) ?? 0) + 1);
    return mod;
  }

  /**
   * Release a previously acquired module reference.
   *
   * Decrements the reference count and notifies drain waiters when it
   * reaches zero.
   */
  release(moduleId: string): void {
    const count = (this._refCounts.get(moduleId) ?? 1) - 1;
    if (count <= 0) {
      this._refCounts.delete(moduleId);
      const resolvers = this._drainResolvers.get(moduleId);
      if (resolvers) {
        for (const resolve of resolvers) resolve();
        this._drainResolvers.delete(moduleId);
      }
    } else {
      this._refCounts.set(moduleId, count);
    }
  }

  /**
   * Check whether a module is marked for unload (draining).
   */
  isDraining(moduleId: string): boolean {
    return this._draining.has(moduleId);
  }

  /**
   * Mark a module as draining so no new acquire() calls are accepted.
   */
  beginDrain(moduleId: string): void {
    this._draining.add(moduleId);
  }

  /**
   * Remove the draining mark and clean up drain state.
   */
  endDrain(moduleId: string): void {
    this._draining.delete(moduleId);
    this._drainResolvers.delete(moduleId);
    this._refCounts.delete(moduleId);
  }

  /**
   * Wait until all in-flight executions of a module have completed.
   *
   * Returns a promise that resolves to `true` if the module drained
   * cleanly, or `false` if the timeout was reached.
   */
  waitDrained(moduleId: string, timeoutMs: number = 5000): Promise<boolean> {
    const current = this._refCounts.get(moduleId) ?? 0;
    if (current <= 0) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const resolvers = this._drainResolvers.get(moduleId) ?? [];
      resolvers.push(() => resolve(true));
      this._drainResolvers.set(moduleId, resolvers);

      setTimeout(() => {
        // If still draining when timeout fires, resolve false
        if (this._refCounts.has(moduleId)) {
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  /**
   * Safely unregister a module with cooperative drain.
   *
   * Marks the module as draining, waits for in-flight executions to
   * complete (up to timeoutMs), then unregisters the module.
   *
   * Returns true if drained cleanly, false if force-unloaded after timeout.
   */
  async safeUnregister(moduleId: string, timeoutMs: number = 5000): Promise<boolean> {
    if (!this._modules.has(moduleId)) return false;

    this.beginDrain(moduleId);
    const clean = await this.waitDrained(moduleId, timeoutMs);

    if (!clean) {
      console.warn(
        `[apcore:registry] Force-unloading module ${moduleId} after ${timeoutMs}ms timeout ` +
        `(${this._refCounts.get(moduleId) ?? 0} in-flight executions)`,
      );
    }

    this.endDrain(moduleId);
    this.unregister(moduleId);
    return clean;
  }
}
