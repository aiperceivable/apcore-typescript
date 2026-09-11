/**
 * Directory scanner for discovering TypeScript/JavaScript extension modules.
 */

import { statSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, join, extname, basename, sep } from 'node:path';
import { ConfigError, ConfigNotFoundError } from '../errors.js';
import type { DiscoveredModule } from './types.js';
import { matchGlob } from '../utils/pattern.js';

const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__']);
const VALID_EXTENSIONS = new Set(['.ts', '.js']);
const SKIP_SUFFIXES = ['.d.ts', '.test.ts', '.test.js', '.spec.ts', '.spec.js'];

function existsAndIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `ignorePatterns` is `extensions.ignore_patterns`, matched with Algorithm A25
 * (PROTOCOL_SPEC §9.2.3) against the ENTRY NAME — one path segment, never a
 * path, case-sensitively. It is a UNION with `SKIP_DIR_NAMES` and §3.5's
 * hidden/internal prefixes: a configured pattern adds to those and cannot
 * switch one off.
 *
 * Until spec v1.42.0 the key was registered in every SDK's configuration key
 * surface and read by none, so §3.6 step 3a was a MUST whose input nothing
 * supplied and a directory a project had excluded from discovery was scanned
 * and registered anyway — a skip rule that failed OPEN (apcore#118).
 */
export function scanExtensions(
  root: string,
  maxDepth: number = 8,
  followSymlinks: boolean = false,
  ignorePatterns: readonly string[] = [],
): DiscoveredModule[] {
  const rootResolved = resolve(root);
  if (!existsAndIsDir(rootResolved)) {
    throw new ConfigNotFoundError(rootResolved);
  }

  // Empty entries are dropped rather than treated as a pattern: A25 anchors, so
  // `''` would match only the empty name, and an operator who leaves a blank
  // line in a YAML list means nothing by it.
  const patterns = ignorePatterns.filter((p) => p !== '');

  const visitedRealPaths = new Set([realpathSync(rootResolved)]);
  const results: DiscoveredModule[] = [];
  const seenIds = new Map<string, string>();
  const seenIdsLower = new Map<string, string>();

  function scanDir(dirPath: string, depth: number): void {
    if (depth > maxDepth) {
      console.warn(`[apcore:scanner] Max depth ${maxDepth} exceeded at: ${dirPath}`);
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      console.warn(`[apcore:scanner] Cannot read directory: ${dirPath}`);
      return;
    }

    for (const name of entries) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      if (SKIP_DIR_NAMES.has(name)) continue;
      if (patterns.some((pattern) => matchGlob(pattern, name))) continue;

      const entryPath = join(dirPath, name);
      let lstat;
      try {
        lstat = lstatSync(entryPath);
      } catch {
        console.warn(`[apcore:scanner] Cannot stat entry: ${entryPath}`);
        continue;
      }

      const isSymlink = lstat.isSymbolicLink();
      let isDir: boolean;
      let isFile: boolean;

      if (isSymlink) {
        if (!followSymlinks) continue;
        const real = realpathSync(entryPath);
        if (visitedRealPaths.has(real)) continue;
        // Confinement check — reject symlinks that escape the extension root
        const normalizedRoot = resolve(rootResolved);
        if (!real.startsWith(normalizedRoot + sep) && real !== normalizedRoot) {
          console.warn(`[apcore] Symlink target outside extension root, skipping: ${entryPath} -> ${real}`);
          continue;
        }
        visitedRealPaths.add(real);
        // Resolve the symlink target to check if it's a dir or file
        let targetStat;
        try {
          targetStat = statSync(entryPath);
        } catch {
          console.warn(`[apcore:scanner] Cannot resolve symlink target: ${entryPath}`);
          continue;
        }
        isDir = targetStat.isDirectory();
        isFile = targetStat.isFile();
      } else {
        isDir = lstat.isDirectory();
        isFile = lstat.isFile();
      }

      if (isDir) {
        scanDir(entryPath, depth + 1);
      } else if (isFile) {
        const ext = extname(name);
        if (!VALID_EXTENSIONS.has(ext)) continue;
        if (SKIP_SUFFIXES.some((s) => name.endsWith(s))) continue;

        const rel = relative(rootResolved, entryPath);
        const canonicalId = rel
          .replace(new RegExp(`\\${sep}`, 'g'), '.')
          .replace(/\.(ts|js)$/, '');

        if (seenIds.has(canonicalId)) {
          console.warn(`[apcore:scanner] Duplicate module ID '${canonicalId}', skipping: ${entryPath}`);
          continue;
        }

        const lowerId = canonicalId.toLowerCase();
        if (seenIdsLower.has(lowerId) && seenIdsLower.get(lowerId) !== canonicalId) {
          console.warn(`[apcore:scanner] Case collision: '${canonicalId}' vs '${seenIdsLower.get(lowerId)}'`);
        }

        // Check for companion metadata file
        const stem = basename(entryPath, ext);
        const metaPath = join(dirPath, stem + '_meta.yaml');
        let metaPathResult: string | null = null;
        try {
          if (statSync(metaPath).isFile()) metaPathResult = metaPath;
        } catch {
          // no meta file
        }

        seenIds.set(canonicalId, entryPath);
        seenIdsLower.set(lowerId, canonicalId);
        results.push({
          filePath: entryPath,
          canonicalId,
          metaPath: metaPathResult,
          namespace: null,
        });
      }
    }
  }

  scanDir(rootResolved, 1);
  return results;
}

export function scanMultiRoot(
  roots: Array<Record<string, unknown>>,
  maxDepth: number = 8,
  followSymlinks: boolean = false,
  ignorePatterns: readonly string[] = [],
): DiscoveredModule[] {
  const allResults: DiscoveredModule[] = [];
  const seenNamespaces = new Set<string>();

  const resolved: Array<[string, string]> = [];
  for (const entry of roots) {
    const rootPath = entry['root'] as string;
    const namespace = (entry['namespace'] as string) || basename(rootPath);
    if (seenNamespaces.has(namespace)) {
      throw new ConfigError(`Duplicate namespace: '${namespace}'`);
    }
    seenNamespaces.add(namespace);
    resolved.push([rootPath, namespace]);
  }

  for (const [rootPath, namespace] of resolved) {
    const modules = scanExtensions(rootPath, maxDepth, followSymlinks, ignorePatterns);
    for (const m of modules) {
      allResults.push({
        filePath: m.filePath,
        canonicalId: `${namespace}.${m.canonicalId}`,
        metaPath: m.metaPath,
        namespace,
      });
    }
  }

  return allResults;
}
