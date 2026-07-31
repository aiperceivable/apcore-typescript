/**
 * `format` keyword handling, shared by the schema converter and the validator.
 *
 * JSON Schema 2020-12 §7.2.1 puts `format` in the **format-annotation**
 * vocabulary by default: assertion behaviour is opt-in, so a format value is
 * collected as an annotation and MUST NOT be treated as an assertion failure.
 * TypeBox does the opposite — `Value.Check` rejects any string whose `format` is
 * absent from the global `FormatRegistry`, so a schema carrying, say,
 * `format: "path"` made every call that passed such a field fail with
 * `SCHEMA_VALIDATION_ERROR` (apexe#32).
 *
 * The formats apcore *does* recognise are enforced separately at SHOULD level
 * (a `console.warn` from `SchemaValidator`, never a rejection), matching
 * apcore-python (`schema/hardening.py`) and apcore-rust (`schema/hardening.rs`).
 *
 * ## Why the neutralisation is scoped rather than permanent
 *
 * `FormatRegistry` is **process-global** and shared with the host application.
 * Registering accept-everything checkers into it permanently would be wrong in
 * both directions:
 *
 * - A host that registered a strict `email` checker before apcore loaded would
 *   make apcore *reject* a bad e-mail address, breaking the annotation
 *   semantics above — apcore's behaviour would depend on registration order.
 * - Every format apcore ever met would stay accept-everything forever, so a
 *   host's own `Type.String({ format: 'email' })` would silently stop
 *   rejecting garbage.
 *
 * {@link withFormatsAsAnnotations} instead overrides only the formats the
 * schema at hand carries, for the duration of one synchronous TypeBox call, and
 * restores the previous entries (including their absence) in a `finally`. No
 * `await` can interleave inside that window — `Value.Check` / `Value.Decode` /
 * `Value.Errors` are synchronous — so the override is never observable from
 * outside apcore.
 *
 * Consequence to be aware of: apcore no longer mutates the registry on the
 * caller's behalf, so calling `Value.Check` **directly** on a schema that
 * carries an unrecognised format (rather than going through
 * `SchemaValidator`) gets TypeBox's own reject-unknown-format behaviour.
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

/** The checker that makes a `format` a pure annotation for TypeBox. */
const ACCEPT_EVERYTHING = (): boolean => true;

/** Format sets already collected, keyed by the schema node they were read from. */
const collectedFormats = new WeakMap<object, ReadonlySet<string>>();

const NO_FORMATS: ReadonlySet<string> = new Set<string>();

/**
 * Collect every `format` value appearing anywhere in `schema`.
 *
 * The traversal is generic (every nested object and array is visited) so
 * `properties`, `items`, `anyOf`/`oneOf`/`allOf`/`not` and any future keyword
 * are covered without enumerating them. The result is memoised per schema
 * object, so a repeat validation of the same schema does not re-walk it; a
 * schema mutated after its first validation keeps the earlier set.
 */
export function collectSchemaFormats(schema: unknown): ReadonlySet<string> {
  if (schema === null || typeof schema !== 'object') return NO_FORMATS;
  const cached = collectedFormats.get(schema);
  if (cached !== undefined) return cached;

  const formats = new Set<string>();
  // Recorded before the walk so a cyclic schema graph terminates.
  collectedFormats.set(schema, formats);
  _collectInto(schema, formats, new Set<object>());
  return formats;
}

function _collectInto(node: unknown, formats: Set<string>, seen: Set<object>): void {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (!Array.isArray(node)) {
    const format = (node as Record<string, unknown>)['format'];
    if (typeof format === 'string') formats.add(format);
  }
  for (const value of Object.values(node)) {
    _collectInto(value, formats, seen);
  }
}

/**
 * Run `fn` with every `format` carried by `schema` neutralised to an
 * accept-everything checker, restoring the process-global `FormatRegistry` to
 * its previous state afterwards.
 *
 * `fn` MUST be synchronous — the registry override is only safe because nothing
 * else can run inside the window.
 */
export function withFormatsAsAnnotations<T>(schema: unknown, fn: () => T): T {
  const formats = collectSchemaFormats(schema);
  if (formats.size === 0) return fn();

  const previous = new Map<string, ((value: string) => boolean) | undefined>();
  for (const format of formats) {
    previous.set(format, FormatRegistry.Get(format));
    FormatRegistry.Set(format, ACCEPT_EVERYTHING);
  }
  try {
    return fn();
  } finally {
    for (const [format, checker] of previous) {
      if (checker === undefined) FormatRegistry.Delete(format);
      else FormatRegistry.Set(format, checker);
    }
  }
}
