/**
 * SchemaValidator — validates runtime data against TypeBox schemas.
 */

import { type TSchema, TypeGuard } from '@sinclair/typebox';
import { Value, type ValueError } from '@sinclair/typebox/value';
import type { SchemaValidationErrorDetail, SchemaValidationResult } from './types.js';
import { validationResultToError } from './types.js';
import { ONEOF_MARKER } from './constants.js';
import { FORMAT_VALIDATORS, withFormatsAsAnnotations } from './formats.js';

export class SchemaValidator {
  private _coerceTypes: boolean;

  constructor(coerceTypes: boolean = true) {
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
    if (s[ONEOF_MARKER] === 'oneOf') {
      return this._validateOneOf(data, schema);
    }

    // anyOf: at least one branch must match; use Value.Check per branch for SCHEMA_UNION_NO_MATCH
    if ('anyOf' in s && !(ONEOF_MARKER in s)) {
      return this._validateAnyOf(data, schema);
    }

    if (this._coerceTypes) {
      try {
        Value.Decode(schema, data);
        const warnLogged = this._checkFormats(data, schema);
        return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
      } catch {
        return {
          valid: false,
          errors: this._collectErrors(schema, data),
          errorCode: 'SCHEMA_VALIDATION_ERROR',
        };
      }
    }

    if (Value.Check(schema, data)) {
      const warnLogged = this._checkFormats(data, schema);
      return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
    }
    return {
      valid: false,
      errors: this._collectErrors(schema, data),
      errorCode: 'SCHEMA_VALIDATION_ERROR',
    };
  }

  validateInput(data: Record<string, unknown>, schema: TSchema): Record<string, unknown> {
    return this._validateAndReturn(data, schema);
  }

  validateOutput(data: Record<string, unknown>, schema: TSchema): Record<string, unknown> {
    return this._validateAndReturn(data, schema);
  }

  private _validateOneOf(data: unknown, schema: TSchema): SchemaValidationResult {
    if (!TypeGuard.IsUnion(schema)) {
      // TypeBox 0.34 unwraps single-element unions to the branch type itself.
      // A single-branch oneOf always matches exactly one branch if the data is valid.
      if (!Value.Check(schema, data)) {
        return {
          valid: false,
          errors: this._collectErrors(schema, data),
          errorCode: 'SCHEMA_UNION_NO_MATCH',
        };
      }
      const warnLogged = this._checkFormats(data, schema);
      return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
    }
    const branches = schema.anyOf as TSchema[];
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
    const warnLogged = this._checkFormats(data, schema);
    return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
  }

  private _validateAnyOf(data: unknown, schema: TSchema): SchemaValidationResult {
    if (!TypeGuard.IsUnion(schema)) {
      // TypeBox 0.34 unwraps single-element unions; treat the unwrapped schema as a single branch.
      if (!Value.Check(schema, data)) {
        return {
          valid: false,
          errors: this._collectErrors(schema, data),
          errorCode: 'SCHEMA_UNION_NO_MATCH',
        };
      }
      const warnLogged = this._checkFormats(data, schema);
      return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
    }
    const branches = schema.anyOf as TSchema[];
    const hasMatch = branches.some((b) => Value.Check(b, data));
    if (!hasMatch) {
      return {
        valid: false,
        errors: [{ path: '/', message: 'anyOf: no branches matched', constraint: 'anyOf' }],
        errorCode: 'SCHEMA_UNION_NO_MATCH',
      };
    }
    const warnLogged = this._checkFormats(data, schema);
    return { valid: true, errors: [], ...(warnLogged && { warnLogged: true }) };
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

    // Object: recurse into properties
    if (schema['type'] === 'object' && schema['properties'] && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const props = schema['properties'] as Record<string, Record<string, unknown>>;
      const dataObj = data as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in dataObj) {
          this._walkFormats(dataObj[key], propSchema, `${path}${path === '/' ? '' : '/'}${key}`, warnings);
        }
      }
    }

    // Array: recurse into each element using the items schema
    if (schema['type'] === 'array' && schema['items'] && Array.isArray(data)) {
      const itemSchema = schema['items'] as Record<string, unknown>;
      data.forEach((item, i) => {
        this._walkFormats(item, itemSchema, `${path === '/' ? '' : path}/${i}`, warnings);
      });
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
