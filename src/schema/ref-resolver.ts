/**
 * $ref resolution for JSON Schema documents following Algorithm A05.
 */

import yaml from 'js-yaml';
import { SchemaCircularRefError, SchemaNotFoundError, SchemaParseError } from '../errors.js';
import { deepCopy } from '../utils/index.js';

// Lazy-load Node.js built-in modules for browser compatibility
let _nodeFs: typeof import('node:fs') | null = null;
let _nodePath: typeof import('node:path') | null = null;
try { _nodeFs = await import('node:fs'); } catch { /* browser environment */ }
try { _nodePath = await import('node:path'); } catch { /* browser environment */ }

const INLINE_SENTINEL = '__inline__';

export class RefResolver {
  private _schemasDir: string;
  private _maxDepth: number;
  private _fileCache: Map<string, Record<string, unknown>> = new Map();

  constructor(schemasDir: string, maxDepth: number = 32) {
    const { resolve } = _nodePath!;
    this._schemasDir = resolve(schemasDir);
    this._maxDepth = maxDepth;
  }

  resolve(schema: Record<string, unknown>, currentFile?: string | null): Record<string, unknown> {
    const result = deepCopy(schema);
    this._fileCache.set(INLINE_SENTINEL, result);
    try {
      this._resolveNode(result, currentFile ?? null, new Set(), 0);
    } finally {
      this._fileCache.delete(INLINE_SENTINEL);
    }
    return result;
  }

  resolveRef(
    refString: string,
    currentFile: string | null,
    visitedRefs?: Set<string>,
    depth: number = 0,
    siblingKeys?: Record<string, unknown> | null,
  ): unknown {
    const visited = visitedRefs ?? new Set<string>();

    if (visited.has(refString)) {
      throw new SchemaCircularRefError(refString);
    }

    if (depth >= this._maxDepth) {
      throw new SchemaCircularRefError(
        `Maximum reference depth ${this._maxDepth} exceeded resolving: ${refString}`,
      );
    }

    visited.add(refString);

    const [filePath, jsonPointer] = this._parseRef(refString, currentFile);
    const document = this._loadFile(filePath);
    const target = this._resolveJsonPointer(document, jsonPointer, refString);

    let result: unknown = deepCopy(target);

    if (siblingKeys && typeof result === 'object' && result !== null && !Array.isArray(result)) {
      Object.assign(result as Record<string, unknown>, siblingKeys);
    }

    const effectiveFile = filePath === INLINE_SENTINEL ? currentFile : filePath;

    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      const resultObj = result as Record<string, unknown>;
      if ('$ref' in resultObj) {
        const nestedRef = resultObj['$ref'] as string;
        delete resultObj['$ref'];
        const nestedSiblings = Object.keys(resultObj).length > 0 ? { ...resultObj } : null;
        result = this.resolveRef(nestedRef, effectiveFile, visited, depth + 1, nestedSiblings);
      }
    }

    this._resolveNode(result, effectiveFile, visited, depth + 1);
    return result;
  }

  private _resolveNode(
    node: unknown,
    currentFile: string | null,
    visitedRefs: Set<string>,
    depth: number,
  ): unknown {
    if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
      const nodeObj = node as Record<string, unknown>;
      if ('$ref' in nodeObj) {
        const refString = nodeObj['$ref'] as string;
        const siblingKeys: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(nodeObj)) {
          if (k !== '$ref') siblingKeys[k] = v;
        }
        const resolved = this.resolveRef(
          refString,
          currentFile,
          new Set(visitedRefs),
          depth,
          Object.keys(siblingKeys).length > 0 ? siblingKeys : null,
        );
        // Clear and replace
        for (const key of Object.keys(nodeObj)) delete nodeObj[key];
        if (typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)) {
          Object.assign(nodeObj, resolved as Record<string, unknown>);
        } else {
          return resolved;
        }
      } else {
        for (const key of Object.keys(nodeObj)) {
          const result = this._resolveNode(nodeObj[key], currentFile, visitedRefs, depth);
          if (result !== nodeObj[key]) {
            nodeObj[key] = result;
          }
        }
      }
    } else if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const result = this._resolveNode(node[i], currentFile, visitedRefs, depth);
        if (result !== node[i]) {
          node[i] = result;
        }
      }
    }
    return node;
  }

  private _parseRef(refString: string, currentFile: string | null): [string, string] {
    const { resolve, dirname } = _nodePath!;
    if (refString.startsWith('#')) {
      const pointer = refString.slice(1);
      if (currentFile) return [currentFile, pointer];
      return [INLINE_SENTINEL, pointer];
    }

    if (refString.startsWith('apcore://')) {
      return this._convertCanonicalToPath(refString);
    }

    if (refString.includes('#')) {
      const [filePart, pointer] = refString.split('#', 2);
      const base = currentFile ? dirname(currentFile) : this._schemasDir;
      const resolvedPath = resolve(base, filePart);
      this._assertWithinSchemasDir(resolvedPath, refString);
      return [resolvedPath, pointer];
    }

    const base = currentFile ? dirname(currentFile) : this._schemasDir;
    const resolvedPath = resolve(base, refString);
    this._assertWithinSchemasDir(resolvedPath, refString);
    return [resolvedPath, ''];
  }

  private _assertWithinSchemasDir(resolvedPath: string, refString: string): void {
    const pathMod = _nodePath!;
    if (resolvedPath === this._schemasDir) return;
    const rel = pathMod.relative(this._schemasDir, resolvedPath);
    // A path is inside schemasDir iff its relative form is non-empty, not
    // absolute, and does not start with a parent-directory traversal segment.
    // Using path.relative() makes this check cross-platform — the previous
    // startsWith(schemasDir + '/') check was hard-coded to POSIX separators
    // and silently disabled on Windows where resolve() emits backslash paths.
    if (!rel || pathMod.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + pathMod.sep)) {
      throw new SchemaNotFoundError(
        `Reference '${refString}' resolves outside schemas directory`,
      );
    }
  }

  private _convertCanonicalToPath(uri: string): [string, string] {
    const { resolve } = _nodePath!;
    const remainder = uri.slice('apcore://'.length);
    const parts = remainder.split('/');
    const canonicalId = parts[0];
    const pointerParts = parts.slice(1);

    const fileRel = canonicalId.replace(/\./g, '/') + '.schema.yaml';
    const filePath = resolve(this._schemasDir, fileRel);

    const pointer = pointerParts.length > 0 ? '/' + pointerParts.join('/') : '';
    return [filePath, pointer];
  }

  private _resolveJsonPointer(document: unknown, pointer: string, refString: string): unknown {
    if (!pointer) return document;

    let segments = pointer.split('/');
    if (segments.length > 0 && segments[0] === '') {
      segments = segments.slice(1);
    }

    let current = document;
    for (const rawSegment of segments) {
      const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
        const obj = current as Record<string, unknown>;
        if (segment in obj) {
          current = obj[segment];
        } else {
          throw new SchemaNotFoundError(`${refString} (segment '${segment}' not found)`);
        }
      } else {
        throw new SchemaNotFoundError(`${refString} (segment '${segment}' not found)`);
      }
    }
    return current;
  }

  private _loadFile(filePath: string): Record<string, unknown> {
    if (filePath === INLINE_SENTINEL) {
      return this._fileCache.get(INLINE_SENTINEL) ?? {};
    }

    const { resolve } = _nodePath!;
    const { existsSync, readFileSync } = _nodeFs!;
    const resolved = resolve(filePath);
    const cached = this._fileCache.get(resolved);
    if (cached !== undefined) return cached;

    if (!existsSync(resolved)) {
      throw new SchemaNotFoundError(resolved);
    }

    const content = readFileSync(resolved, 'utf-8');
    if (!content.trim()) {
      this._fileCache.set(resolved, {});
      return {};
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch (e) {
      throw new SchemaParseError(`Invalid YAML in ${resolved}: ${e}`);
    }

    if (parsed === null || parsed === undefined) {
      this._fileCache.set(resolved, {});
      return {};
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SchemaParseError(
        `Schema file ${resolved} must be a YAML mapping, got ${typeof parsed}`,
      );
    }

    const result = parsed as Record<string, unknown>;
    this._fileCache.set(resolved, result);
    return result;
  }

  clearCache(): void {
    this._fileCache.clear();
  }
}
