/**
 * Lightweight semver utilities and versioned storage for module version negotiation (F18).
 */

const SEMVER_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/;
const CONSTRAINT_RE = /^(>=|<=|>|<|=)?(.+)$/;

/**
 * Parse a version string into a [major, minor, patch] tuple.
 * Supports full semver (1.2.3), major.minor (1.2), and major-only (1).
 * Returns null if the string cannot be parsed.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(version.trim());
  if (m === null) {
    return null;
  }
  const major = parseInt(m[1], 10);
  const minor = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  return [major, minor, patch];
}

/**
 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
 * Invalid versions are treated as 0.0.0.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
}

function checkSingleConstraint(
  versionTuple: [number, number, number],
  constraint: string,
): boolean {
  constraint = constraint.trim();
  const m = CONSTRAINT_RE.exec(constraint);
  if (m === null) {
    return false;
  }
  const op = m[1] || '=';
  const target = parseSemver(m[2]) ?? [0, 0, 0];

  // Partial match: if constraint is just a major number (e.g. "1"),
  // match any version with the same major
  const parts = m[2].trim().split('.');
  if (op === '=' && parts.length === 1) {
    return versionTuple[0] === target[0];
  }
  if (op === '=' && parts.length === 2) {
    return versionTuple[0] === target[0] && versionTuple[1] === target[1];
  }

  const cmp = compareTuples(versionTuple, target);
  if (op === '=') return cmp === 0;
  if (op === '>=') return cmp >= 0;
  if (op === '>') return cmp > 0;
  if (op === '<=') return cmp <= 0;
  if (op === '<') return cmp < 0;
  return false;
}

function compareTuples(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function matchesVersionHint(version: string, hint: string): boolean {
  const versionTuple = parseSemver(version) ?? [0, 0, 0];
  const constraints = hint.split(',').map((c) => c.trim());
  return constraints.every((c) => checkSingleConstraint(versionTuple, c));
}

/**
 * Select the best matching version from a list.
 * If hint is undefined/null, returns the latest (highest) version.
 * If hint is given, returns the highest version that matches.
 * Returns null if no version matches.
 */
export function selectBestVersion(
  versions: string[],
  hint?: string | null,
): string | null {
  if (versions.length === 0) {
    return null;
  }

  const sorted = [...versions].sort(compareSemver);

  if (hint == null) {
    return sorted[sorted.length - 1];
  }

  const matching = sorted.filter((v) => matchesVersionHint(v, hint));
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

/**
 * Generic versioned storage for multiple versions of items keyed by module ID.
 * Stores items as Map<moduleId, Map<version, T>>.
 */
export class VersionedStore<T> {
  private readonly _data: Map<string, Map<string, T>> = new Map();

  /** Add an item for a given moduleId and version. */
  add(moduleId: string, version: string, item: T): void {
    let versions = this._data.get(moduleId);
    if (!versions) {
      versions = new Map();
      this._data.set(moduleId, versions);
    }
    versions.set(version, item);
  }

  /** Get a specific version of an item. Returns null if not found. */
  get(moduleId: string, version: string): T | null {
    const versions = this._data.get(moduleId);
    if (!versions) return null;
    return versions.get(version) ?? null;
  }

  /** Get the latest (highest semver) version of an item. */
  getLatest(moduleId: string): T | null {
    const versions = this._data.get(moduleId);
    if (!versions || versions.size === 0) return null;
    const best = selectBestVersion([...versions.keys()]);
    return best !== null ? (versions.get(best) ?? null) : null;
  }

  /** Resolve a module by ID and optional version hint. */
  resolve(moduleId: string, versionHint?: string | null): T | null {
    const versions = this._data.get(moduleId);
    if (!versions || versions.size === 0) return null;
    const best = selectBestVersion([...versions.keys()], versionHint);
    return best !== null ? (versions.get(best) ?? null) : null;
  }

  /** List all registered versions for a moduleId, sorted by semver. */
  listVersions(moduleId: string): string[] {
    const versions = this._data.get(moduleId);
    if (!versions) return [];
    return [...versions.keys()].sort(compareSemver);
  }

  /** List all unique module IDs. */
  listIds(): string[] {
    return [...this._data.keys()];
  }

  /** Remove a specific version. Returns true if the version existed and was removed. */
  remove(moduleId: string, version: string): boolean {
    const versions = this._data.get(moduleId);
    if (!versions) return false;
    const existed = versions.delete(version);
    if (versions.size === 0) {
      this._data.delete(moduleId);
    }
    return existed;
  }

  /** Remove all versions for a moduleId. Returns true if the moduleId existed. */
  removeAll(moduleId: string): boolean {
    return this._data.delete(moduleId);
  }

  /** Check if any version of a moduleId is registered. */
  has(moduleId: string): boolean {
    const versions = this._data.get(moduleId);
    return versions !== undefined && versions.size > 0;
  }

  /** Check if a specific version is registered. */
  hasVersion(moduleId: string, version: string): boolean {
    const versions = this._data.get(moduleId);
    return versions !== undefined && versions.has(version);
  }
}
