/**
 * SchemaValidator — validates runtime data against TypeBox schemas.
 */

import type { TSchema } from '@sinclair/typebox';
import { Value, type ValueError } from '@sinclair/typebox/value';
import type { SchemaValidationErrorDetail, SchemaValidationResult } from './types.js';
import { validationResultToError } from './types.js';
import { KEYWORD_MARKER } from './constants.js';
import { FORMAT_VALIDATORS, withFormatsAsAnnotations } from './formats.js';

/**
 * The branch list of a union node, or `null` when the schema is not one.
 *
 * Reads `anyOf` directly rather than going through `TypeGuard.IsUnion`, because
 * the converter emits `oneOf` as a custom kind (exclusivity has to hold at every
 * nesting depth, which a plain `Type.Union` cannot express) while still keeping
 * the branch array under `anyOf`.
 */
function _unionBranches(schema: TSchema): TSchema[] | null {
  const branches = (schema as Record<string, unknown>)['anyOf'];
  return Array.isArray(branches) ? (branches as TSchema[]) : null;
}

/**
 * Find the union node carrying {@link KEYWORD_MARKER}, descending through the
 * `allOf` members the converter produces when `oneOf` / `anyOf` has a `type`
 * sibling. Returns `null` when the schema expresses no union assertion.
 */
function findMarkedUnion(schema: Record<string, unknown>): TSchema | null {
  if (typeof schema[KEYWORD_MARKER] === 'string') return schema as TSchema;
  const allOf = schema['allOf'];
  if (!Array.isArray(allOf)) return null;
  for (const member of allOf as Record<string, unknown>[]) {
    const found = findMarkedUnion(member);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Validates runtime data against a TypeBox schema.
 *
 * `coerceTypes` is a **library-level** knob, for a caller validating its own
 * untyped input (a CLI parsing argv, a form handler). It does **not** reach the
 * module-invocation boundary: `builtin-steps.ts` holds a
 * `new SchemaValidator(false)` and never coerces, under any host configuration
 * (TYPE_MAPPING §17.3). There is no `schema.validation.coerce_types` setting —
 * a module's contract has to mean the same thing regardless of who loaded it.
 *
 * It defaults to `false`, matching the boundary and the other two SDKs. Coercion
 * is opt-in: a validator that silently rewrites its input is the wrong default
 * for the common case of checking data you already believe is well-formed.
 *
 * **Known limitation:** passing `true` does not currently coerce. It switches the
 * check from `Value.Check` to `Value.Decode`, which applies TypeBox transforms
 * but not type conversion — `"42"` is still rejected for `{type: "integer"}`,
 * where apcore-python and apcore-rust accept it in their coercing mode. Closing
 * the gap means picking a conversion semantics all three can agree on:
 * `Value.Convert` mutates its argument in place and truncates (`"4.5"` becomes
 * `4`), while pydantic refuses a lossy conversion. Until that is settled, treat
 * `coerceTypes: true` as unimplemented rather than as a different dialect. The
 * module-invocation boundary is unaffected — it never coerces on any SDK
 * (TYPE_MAPPING §17.3).
 */
export class SchemaValidator {
  private _coerceTypes: boolean;

  constructor(coerceTypes: boolean = false) {
    this._coerceTypes = coerceTypes;
  }

  /**
   * A `format` TypeBox does not know would otherwise make the structural check
   * fail. JSON Schema 2020-12 §7.2.1 makes `format` an annotation rather than an
   * assertion by default, so every format the schema carries is neutralised for
   * the duration of the check and restored afterwards (apexe#32). Recognised
   * formats are enforced at SHOULD level by `_checkFormats`, never here.
   */
  validate(data: Record<string, unknown>, schema: TSchema): SchemaValidationResult {
    return withFormatsAsAnnotations(schema, () => this._validate(data, schema));
  }

  private _validate(data: Record<string, unknown>, schema: TSchema): SchemaValidationResult {
    const s = schema as Record<string, unknown>;

    // oneOf: exhaustive counting — exactly one branch must match
    if (s[KEYWORD_MARKER] === 'oneOf') {
      return this._validateOneOf(data, schema);
    }

    // anyOf: at least one branch must match; use Value.Check per branch for
    // SCHEMA_UNION_NO_MATCH. An unmarked TypeBox `Type.Union` (a schema the
    // module author wrote by hand) gets the same treatment.
    if (s[KEYWORD_MARKER] === 'anyOf' || ('anyOf' in s && !(KEYWORD_MARKER in s))) {
      return this._validateAnyOf(data, schema);
    }

    // A `type` sibling wraps the marked union in an intersection, burying the
    // marker one or more levels down. The union assertion still applies, so
    // `{type: 'object', oneOf: [...]}` and `{type: 'object', anyOf: [...]}`
    // report SCHEMA_UNION_AMBIGUOUS / SCHEMA_UNION_NO_MATCH exactly like their
    // bare counterparts instead of degrading to SCHEMA_VALIDATION_ERROR. Only
    // failures short-circuit here; a satisfied union falls through so the rest
    // of the intersection (the `type` half) is still checked.
    const nestedUnion = findMarkedUnion(s);
    if (nestedUnion !== null) {
      const failure = this._unionFailure(data, nestedUnion);
      if (failure !== null) return failure;
    }

    return this._validateStructural(data, schema);
  }

  /** The plain TypeBox check, decoding first when type coercion is enabled. */
  private _validateStructural(data: unknown, schema: TSchema): SchemaValidationResult {
    let passed: boolean;
    if (this._coerceTypes) {
      try {
        Value.Decode(schema, data);
        passed = true;
      } catch {
        passed = false;
      }
    } else {
      passed = Value.Check(schema, data);
    }

    if (!passed) {
      // Errors are collected only on the failing path — `Value.Errors` walks
      // the whole schema.
      return {
        valid: false,
        errors: this._collectErrors(schema, data),
        errorCode: 'SCHEMA_VALIDATION_ERROR',
      };
    }
    const warnLogged = this._checkFormats(data, schema);
    return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
  }

  validateInput(data: Record<string, unknown>, schema: TSchema): Record<string, unknown> {
    return this._validateAndReturn(data, schema);
  }

  validateOutput(data: Record<string, unknown>, schema: TSchema): Record<string, unknown> {
    return this._validateAndReturn(data, schema);
  }

  private _validateOneOf(data: unknown, schema: TSchema): SchemaValidationResult {
    const failure = this._oneOfFailure(data, schema);
    if (failure !== null) return failure;
    const warnLogged = this._checkFormats(data, schema);
    return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
  }

  /**
   * `oneOf` exhaustive counting: exactly one branch must match. Returns the
   * failure result, or `null` when the data satisfies the exclusivity rule.
   * Kept free of format reporting so it can also be applied to a marked union
   * nested inside an intersection without warning twice.
   */
  private _oneOfFailure(data: unknown, schema: TSchema): SchemaValidationResult | null {
    const branches = _unionBranches(schema);
    if (branches === null) {
      // TypeBox 0.34 unwraps single-element unions to the branch type itself.
      // A single-branch oneOf always matches exactly one branch if the data is valid.
      if (!Value.Check(schema, data)) {
        return {
          valid: false,
          errors: this._collectErrors(schema, data),
          errorCode: 'SCHEMA_UNION_NO_MATCH',
        };
      }
      return null;
    }
    const matchCount = branches.filter((b) => Value.Check(b, data)).length;
    if (matchCount === 0) {
      return {
        valid: false,
        errors: [{ path: '/', message: 'oneOf: no branches matched', constraint: 'oneOf' }],
        errorCode: 'SCHEMA_UNION_NO_MATCH',
      };
    }
    if (matchCount > 1) {
      return {
        valid: false,
        errors: [{ path: '/', message: `oneOf: expected exactly 1 match, got ${matchCount}`, constraint: 'oneOf' }],
        errorCode: 'SCHEMA_UNION_AMBIGUOUS',
      };
    }
    return null;
  }

  private _validateAnyOf(data: unknown, schema: TSchema): SchemaValidationResult {
    const failure = this._anyOfFailure(data, schema);
    if (failure !== null) return failure;
    const warnLogged = this._checkFormats(data, schema);
    return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
  }

  /**
   * `anyOf`: at least one branch must match. Unlike `oneOf` there is no
   * exclusivity rule — several branches matching is valid — so the only failure
   * is zero matches. Returns the failure result, or `null` when satisfied.
   */
  private _anyOfFailure(data: unknown, schema: TSchema): SchemaValidationResult | null {
    const branches = _unionBranches(schema);
    if (branches === null) {
      // TypeBox 0.34 unwraps single-element unions; treat the unwrapped schema as a single branch.
      if (!Value.Check(schema, data)) {
        return {
          valid: false,
          errors: this._collectErrors(schema, data),
          errorCode: 'SCHEMA_UNION_NO_MATCH',
        };
      }
      return null;
    }
    if (!branches.some((b) => Value.Check(b, data))) {
      return {
        valid: false,
        errors: [{ path: '/', message: 'anyOf: no branches matched', constraint: 'anyOf' }],
        errorCode: 'SCHEMA_UNION_NO_MATCH',
      };
    }
    return null;
  }

  /** Apply the branch semantics the marked union's originating keyword implies. */
  private _unionFailure(data: unknown, union: TSchema): SchemaValidationResult | null {
    const keyword = (union as Record<string, unknown>)[KEYWORD_MARKER];
    return keyword === 'oneOf'
      ? this._oneOfFailure(data, union)
      : this._anyOfFailure(data, union);
  }

  private _validateAndReturn(data: Record<string, unknown>, schema: TSchema): Record<string, unknown> {
    return withFormatsAsAnnotations(schema, () => {
      // Route through _validate() so union schemas surface their specific error
      // code (SCHEMA_UNION_NO_MATCH / SCHEMA_UNION_AMBIGUOUS) and plain failures
      // surface SCHEMA_VALIDATION_ERROR — all preserved through the thrown error.
      const result = this._validate(data, schema);
      if (!result.valid) {
        throw validationResultToError(result);
      }

      if (this._coerceTypes) {
        return Value.Decode(schema, data) as Record<string, unknown>;
      }
      return data;
    });
  }

  /**
   * Walk the schema and data together to find format-annotated string fields.
   * Emits console.warn for each format violation (SHOULD-level enforcement).
   * Returns true if any warnings were emitted.
   */
  private _checkFormats(data: unknown, schema: TSchema): boolean {
    const warnings: string[] = [];
    this._walkFormats(data, schema as Record<string, unknown>, '/', warnings);
    // The same annotation can be reached through more than one union branch.
    const unique = [...new Set(warnings)];
    for (const w of unique) {
      console.warn(`[apcore:schema] ${w}`);
    }
    return unique.length > 0;
  }

  private _walkFormats(data: unknown, schema: Record<string, unknown>, path: string, warnings: string[]): void {
    if (typeof schema !== 'object' || schema === null) return;

    // Union (a `type` array, `anyOf` or `oneOf`): the format annotation lives on
    // the branches, not on the union node. Only branches the data satisfies
    // contribute — a sibling branch describes a different shape, and warning
    // from it would report a format the value was never meant to carry.
    const anyOf = schema['anyOf'];
    if (Array.isArray(anyOf)) {
      for (const branch of anyOf as Record<string, unknown>[]) {
        if (Value.Check(branch as TSchema, data)) {
          this._walkFormats(data, branch, path, warnings);
        }
      }
      return;
    }

    // Intersection (`type` plus a combinator sibling, or `allOf`): every member
    // applies, so every member's annotations are collected.
    const allOf = schema['allOf'];
    if (Array.isArray(allOf)) {
      for (const member of allOf as Record<string, unknown>[]) {
        this._walkFormats(data, member, path, warnings);
      }
      return;
    }

    // String with format annotation
    if (schema['type'] === 'string' && typeof schema['format'] === 'string' && typeof data === 'string') {
      const format = schema['format'] as string;
      const validator = FORMAT_VALIDATORS[format];
      if (validator && !validator(data)) {
        warnings.push(`Format '${format}' validation failed at ${path}: "${data}"`);
      }
      return;
    }

    // Object: recurse into declared properties and the additionalProperties schema
    if (schema['type'] === 'object' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      this._walkObjectFormats(data as Record<string, unknown>, schema, path, warnings);
    }

    // Array: recurse into each element using the items schema
    if (schema['type'] === 'array' && schema['items'] && Array.isArray(data)) {
      const itemSchema = schema['items'] as Record<string, unknown>;
      data.forEach((item, i) => {
        this._walkFormats(item, itemSchema, `${path === '/' ? '' : path}/${i}`, warnings);
      });
    }
  }

  /**
   * Recurse into an object's declared `properties` and, for the keys none of
   * them covers, into the `additionalProperties` subschema. Skipping the latter
   * hid every format annotation on an open-ended map — apcore-python reports
   * that shape.
   */
  private _walkObjectFormats(
    data: Record<string, unknown>,
    schema: Record<string, unknown>,
    path: string,
    warnings: string[],
  ): void {
    const child = (key: string): string => `${path}${path === '/' ? '' : '/'}${key}`;
    const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in data) this._walkFormats(data[key], propSchema, child(key), warnings);
    }

    const additional = schema['additionalProperties'];
    if (additional === null || typeof additional !== 'object' || Array.isArray(additional)) return;
    for (const [key, value] of Object.entries(data)) {
      if (key in props) continue;
      this._walkFormats(value, additional as Record<string, unknown>, child(key), warnings);
    }
  }

  private _collectErrors(schema: TSchema, data: unknown): SchemaValidationErrorDetail[] {
    const errors: SchemaValidationErrorDetail[] = [];
    for (const error of Value.Errors(schema, data)) {
      errors.push(this._typeboxErrorToDetail(error));
    }
    return errors;
  }

  private _typeboxErrorToDetail(error: ValueError): SchemaValidationErrorDetail {
    return {
      path: error.path || '/',
      message: error.message,
      constraint: String(error.type),
      expected: error.schema,
      actual: error.value,
    };
  }
}
