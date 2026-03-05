/**
 * Cross-language module ID normalization (Algorithm A02).
 */

const SEPARATORS: Record<string, string> = {
  python: '.',
  rust: '::',
  go: '.',
  java: '.',
  typescript: '.',
};

const SUPPORTED_LANGUAGES = new Set(Object.keys(SEPARATORS));

/**
 * Regex for splitting PascalCase / camelCase into words.
 * Handles transitions like: "Http" | "JSON" | "Parser" | "v2".
 */
const CASE_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

/** Canonical ID format from PROTOCOL_SPEC section 2.7 EBNF grammar. */
const CANONICAL_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function toSnakeCase(segment: string): string {
  if (!segment) return segment;

  // If already snake_case (all lowercase + underscores), return as-is.
  if (segment === segment.toLowerCase() && /^[a-z_]\w*$/.test(segment)) {
    return segment;
  }

  // Split at case boundaries, join with underscore, lowercase.
  const words = segment.split(CASE_BOUNDARY).filter(Boolean);
  return words.map((w) => w.toLowerCase()).join('_');
}

/**
 * Convert a language-local module ID to Canonical ID format (Algorithm A02).
 *
 * Steps:
 *   1. Split by language-specific separator.
 *   2. Normalize each segment from PascalCase/camelCase to snake_case.
 *   3. Join with "." and validate against Canonical ID EBNF.
 *
 * @param localId - Language-local format ID (e.g. "executor::validator::DbParams").
 * @param language - Source language ("python" | "rust" | "go" | "java" | "typescript").
 * @returns Dot-separated snake_case Canonical ID.
 * @throws {Error} If language is unsupported or the result is not a valid Canonical ID.
 */
export function normalizeToCanonicalId(localId: string, language: string): string {
  if (!localId) {
    throw new Error('localId must be a non-empty string');
  }

  if (!SUPPORTED_LANGUAGES.has(language)) {
    const supported = [...SUPPORTED_LANGUAGES].sort().join(', ');
    throw new Error(`Unsupported language '${language}'. Must be one of: ${supported}`);
  }

  const separator = SEPARATORS[language];
  const segments = localId.split(separator);
  const normalized = segments.map(toSnakeCase);
  const canonicalId = normalized.join('.');

  if (!CANONICAL_ID_RE.test(canonicalId)) {
    throw new Error(
      `Normalized ID '${canonicalId}' (from '${localId}', language='${language}') ` +
      'does not conform to Canonical ID grammar',
    );
  }

  return canonicalId;
}
