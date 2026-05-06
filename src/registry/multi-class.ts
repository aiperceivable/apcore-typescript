/**
 * Multi-class module discovery: opt-in scanner, snake_case ID derivation, conflict detection.
 *
 * Implements PROTOCOL_SPEC §2.1.1 (Multi-Module Discovery).
 */

import { IdTooLongError, InvalidSegmentError, ModuleIdConflictError } from '../errors.js';

const SEGMENT_RE = /^[a-z][a-z0-9_]*$/;
const CANONICAL_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_MODULE_ID_LEN = 192;

export interface ClassDescriptor {
  readonly name: string;
  readonly implementsModule: boolean;
  /**
   * Per-class opt-in marker for multi-class mode (apcore decision-log D-06).
   *
   * When at least one qualifying class in the file has `multiClass: true`,
   * the discovery routine derives a distinct module ID per class. When no
   * qualifying class sets the flag, whole-file mode is used and the bare
   * base_id is returned.
   *
   * This field replaces the previous global `multiClassEnabled` parameter
   * on `Registry.discoverMultiClass`. See apcore commit 973410b for the
   * upstream cleanup that removed the dead `extensions.multi_class_discovery`
   * config toggle.
   */
  readonly multiClass?: boolean;
}

export interface MultiClassEntry {
  readonly moduleId: string;
  readonly className: string;
}

/**
 * Convert a class name to a snake_case segment per PROTOCOL_SPEC §2.1.1.
 *
 * Algorithm:
 * 1. Insert boundary at ALLCAPS→CamelCase transitions (HTTPSender → HTTP_Sender).
 * 2. Insert boundary at lowercase/digit→uppercase transitions (MathOps → Math_Ops).
 * 3. Replace every non-alphanumeric character with `_`.
 * 4. Lowercase.
 * 5. Collapse consecutive `_` to a single `_`.
 * 6. Strip leading and trailing `_`.
 */
export function classNameToSegment(className: string): string {
  let s = className.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  s = s.replace(/([a-z\d])([A-Z])/g, '$1_$2');
  s = s.replace(/[^a-zA-Z0-9]/g, '_');
  s = s.toLowerCase();
  s = s.replace(/_+/g, '_');
  return s.replace(/^_+|_+$/g, '');
}

function computeBaseId(filePath: string, extensionsRoot: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const rootIdx = parts.findIndex(p => p === extensionsRoot);
  const relParts = rootIdx === -1 ? [parts[parts.length - 1]] : parts.slice(rootIdx + 1);
  // Strip file extension from the last segment
  relParts[relParts.length - 1] = relParts[relParts.length - 1].replace(/\.[^.]+$/, '');
  return relParts.join('.');
}

/**
 * Discover module IDs for classes in a single file under multi-class mode.
 *
 * Implements the Registry.discover_multi_class contract from PROTOCOL_SPEC §2.1.1.
 *
 * When multiClassEnabled is false (the default — multi-class mode is opt-in),
 * only the first qualifying class is used and the bare base_id is returned.
 *
 * When multiClassEnabled is true and exactly one class qualifies:
 * - If the class segment matches the file's last path segment (class named after
 *   the file), the bare base_id is returned to preserve existing module IDs.
 * - Otherwise the class segment is appended: base_id.class_segment.
 *
 * @internal Prefer `Registry.discoverMultiClass` (D-15) for the canonical
 * cross-language API surface; this free function is retained for backwards
 * compatibility and direct use by the scanner.
 *
 * @throws ModuleIdConflictError — two classes produce the same class_segment
 * @throws InvalidSegmentError   — a segment does not match ^[a-z][a-z0-9_]*$
 * @throws IdTooLongError        — a derived module_id exceeds 192 characters
 */
export function discoverMultiClass(
  filePath: string,
  classes: readonly ClassDescriptor[],
  extensionsRoot: string = 'extensions',
  multiClassEnabled: boolean = false,
): MultiClassEntry[] {
  const qualifying = classes.filter(c => c.implementsModule);
  if (qualifying.length === 0) return [];

  const baseId = computeBaseId(filePath, extensionsRoot);

  if (!multiClassEnabled) {
    return [{ moduleId: baseId, className: qualifying[0].name }];
  }

  if (qualifying.length === 1) {
    const segment = classNameToSegment(qualifying[0].name);
    const lastBaseSegment = baseId.split('.').pop()!;
    // Identity guarantee: when the class segment matches the file's last segment
    // (class named after the file), preserve the bare base_id so existing IDs
    // are not broken when multi-class mode is enabled.
    if (segment === lastBaseSegment) {
      return [{ moduleId: baseId, className: qualifying[0].name }];
    }
    // Class has a distinct name from the file — append the class segment.
    if (!SEGMENT_RE.test(segment)) throw new InvalidSegmentError(filePath, qualifying[0].name, segment);
    const moduleId = `${baseId}.${segment}`;
    if (!CANONICAL_ID_RE.test(moduleId)) throw new InvalidSegmentError(filePath, qualifying[0].name, segment);
    if (moduleId.length > MAX_MODULE_ID_LEN) throw new IdTooLongError(filePath, moduleId);
    return [{ moduleId, className: qualifying[0].name }];
  }

  // Multi-class path: derive IDs, detect conflicts, validate
  const seenSegments = new Map<string, string>(); // segment → className
  const results: MultiClassEntry[] = [];

  for (const cls of qualifying) {
    const segment = classNameToSegment(cls.name);

    if (!SEGMENT_RE.test(segment)) {
      throw new InvalidSegmentError(filePath, cls.name, segment);
    }

    if (seenSegments.has(segment)) {
      console.warn(
        `[apcore:multi-class] MODULE_ID_CONFLICT in '${filePath}': ` +
        `classes '${seenSegments.get(segment)}' and '${cls.name}' both produce segment '${segment}'`,
      );
      throw new ModuleIdConflictError(filePath, [seenSegments.get(segment)!, cls.name], segment);
    }
    seenSegments.set(segment, cls.name);

    const moduleId = `${baseId}.${segment}`;

    if (!CANONICAL_ID_RE.test(moduleId)) {
      throw new InvalidSegmentError(filePath, cls.name, segment);
    }

    if (moduleId.length > MAX_MODULE_ID_LEN) {
      throw new IdTooLongError(filePath, moduleId);
    }

    results.push({ moduleId, className: cls.name });
  }

  return results;
}

/**
 * Internal alias of {@link discoverMultiClass}. Use {@link Registry.discoverMultiClass}
 * instead — this name is preserved so the scanner and other internal callers
 * have a stable reference that signals the surface is not part of the public
 * API.
 *
 * @internal
 */
export const _discoverMultiClass = discoverMultiClass;
