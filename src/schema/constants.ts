/**
 * Shared constants for the schema system.
 * Must be imported by both loader.ts (writes) and validator.ts (reads)
 * so that renaming either copy without the other causes a compile error.
 */

/** TypeBox schema property that marks a union built from JSON Schema `oneOf`.
 * loader.ts writes it; validator.ts reads it to apply exhaustive branch semantics. */
export const ONEOF_MARKER = 'x-apcore-keyword';
