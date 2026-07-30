/**
 * `format` keyword handling, shared by the schema converter and the validator.
 *
 * JSON Schema 2020-12 puts `format` in the **format-annotation** vocabulary by
 * default: an implementation that does not recognise a format value collects it
 * as an annotation and MUST NOT treat it as an assertion failure. TypeBox does
 * the opposite — `Value.Check` rejects any string whose `format` is absent from
 * the global `FormatRegistry`, so a schema carrying, say, `format: "path"` made
 * every call that passed such a field fail with `SCHEMA_VALIDATION_ERROR`
 * (apexe#32).
 *
 * Registering an accept-everything checker for every format apcore encounters
 * restores annotation semantics. The formats apcore *does* recognise are
 * enforced separately at SHOULD level (a `console.warn` from `SchemaValidator`,
 * never a rejection), matching apcore-python (`schema/hardening.py`),
 * apcore-rust (`schema/hardening.rs`) and the shared conformance fixture
 * `schema_hardening_formats.json`.
 *
 * Browser-safe: no `node:*` imports may be added here (see
 * `tests/browser-entry.test.ts`).
 */

import { FormatRegistry } from '@sinclair/typebox';

/**
 * Semantic checkers for the formats apcore recognises. A `false` result is a
 * SHOULD-level warning, never a validation failure.
 */
export const FORMAT_VALIDATORS: Record<string, (v: string) => boolean> = {
  'date-time': (v) => !isNaN(new Date(v).getTime()),
  'date': (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  'time': (v) => /^\d{2}:\d{2}:\d{2}/.test(v),
  'email': (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  'uri': (v) => { try { new URL(v); return true; } catch { return false; } },
  'uuid': (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  'ipv4': (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((n) => parseInt(n, 10) <= 255),
  'ipv6': (v) => /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i.test(v),
};

/**
 * Make `format` a pure annotation for TypeBox's structural check by registering
 * an accept-everything checker for it.
 *
 * Guarded by `Has()` so a stricter checker already registered by the host
 * process (or by another apcore instance) is never clobbered.
 */
export function registerFormatAsAnnotation(format: string): void {
  if (!FormatRegistry.Has(format)) {
    FormatRegistry.Set(format, () => true);
  }
}

/** Schemas already scanned by `registerSchemaFormats` — the walk runs once each. */
const scannedSchemas = new WeakSet<object>();

/**
 * Register every `format` value found anywhere in `schema` as an annotation.
 *
 * The traversal is generic (every nested object and array is visited) so
 * `properties`, `items`, `anyOf`/`oneOf`/`allOf`/`not` and any future keyword
 * are covered without enumerating them. Visited nodes are recorded, which both
 * caches repeat calls and makes a cyclic schema graph safe.
 */
export function registerSchemaFormats(schema: unknown): void {
  if (schema === null || typeof schema !== 'object') return;
  if (scannedSchemas.has(schema)) return;
  scannedSchemas.add(schema);

  if (!Array.isArray(schema)) {
    const format = (schema as Record<string, unknown>)['format'];
    if (typeof format === 'string') registerFormatAsAnnotation(format);
  }
  for (const value of Object.values(schema)) {
    registerSchemaFormats(value);
  }
}
