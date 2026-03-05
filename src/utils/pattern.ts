/**
 * Wildcard pattern matching for module IDs (Algorithm A08).
 */

export function matchPattern(pattern: string, moduleId: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === moduleId;

  const segments = pattern.split('*');
  let pos = 0;

  if (!pattern.startsWith('*')) {
    if (!moduleId.startsWith(segments[0])) return false;
    pos = segments[0].length;
  }

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const idx = moduleId.indexOf(segment, pos);
    if (idx === -1) return false;
    pos = idx + segment.length;
  }

  if (!pattern.endsWith('*')) {
    if (!moduleId.endsWith(segments[segments.length - 1])) return false;
  }

  return true;
}

/**
 * Calculate the specificity score of an ACL pattern (Algorithm A10).
 *
 * Higher scores indicate more specific patterns. Scoring per segment:
 * - "*" (pure wildcard) -> 0
 * - Segment containing "*" (partial wildcard) -> +1
 * - Exact segment (no wildcard) -> +2
 *
 * @example
 * calculateSpecificity("*")                       // 0
 * calculateSpecificity("api.*")                   // 2
 * calculateSpecificity("api.handler.*")           // 4
 * calculateSpecificity("api.handler.task_submit") // 6
 */
export function calculateSpecificity(pattern: string): number {
  if (pattern === '*') return 0;

  let score = 0;
  for (const segment of pattern.split('.')) {
    if (segment === '*') {
      // +0
    } else if (segment.includes('*')) {
      score += 1;
    } else {
      score += 2;
    }
  }
  return score;
}
