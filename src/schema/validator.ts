/**
 * SchemaValidator — validates runtime data against TypeBox schemas.
 */

import { type TSchema, FormatRegistry, TypeGuard } from '@sinclair/typebox';
import { Value, type ValueError } from '@sinclair/typebox/value';
import type { SchemaValidationErrorDetail, SchemaValidationResult } from './types.js';
import { validationResultToError } from './types.js';
import { ONEOF_MARKER } from './constants.js';

// SHOULD-level format validators (Issue #44 §4).
// These check semantic correctness; failures emit warnings but do not reject.
const FORMAT_VALIDATORS: Record<string, (v: string) => boolean> = {
  'date-time': (v) => !isNaN(new Date(v).getTime()),
  'date': (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  'time': (v) => /^\d{2}:\d{2}:\d{2}/.test(v),
  'email': (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  'uri': (v) => { try { new URL(v); return true; } catch { return false; } },
  'uuid': (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  'ipv4': (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((n) => parseInt(n, 10) <= 255),
  'ipv6': (v) => /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i.test(v),
};

export class SchemaValidator {
  private _coerceTypes: boolean;

  constructor(coerceTypes: boolean = true) {
    this._coerceTypes = coerceTypes;
    // Register known formats with TypeBox so Value.Check accepts them structurally.
    // TypeBox 0.34+ rejects strings with unregistered formats; we override to always
    // pass the structural check and handle enforcement ourselves via SHOULD-level warnings.
    // Guarded by Has() so pre-existing registrations from the host process are not clobbered.
    for (const fmt of Object.keys(FORMAT_VALIDATORS)) {
      if (!FormatRegistry.Has(fmt)) {
        FormatRegistry.Set(fmt, () => true);
      }
    }
  }

  validate(data: Record<string, unknown>, schema: TSchema): SchemaValidationResult {
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
          errorCode: 'SCHEMA_VALIDATION_FAILED',
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
      errorCode: 'SCHEMA_VALIDATION_FAILED',
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
    if (this._coerceTypes) {
      try {
        return Value.Decode(schema, data) as Record<string, unknown>;
      } catch {
        const result: SchemaValidationResult = {
          valid: false,
          errors: this._collectErrors(schema, data),
        };
        throw validationResultToError(result);
      }
    }

    if (Value.Check(schema, data)) {
      return data;
    }

    const result: SchemaValidationResult = {
      valid: false,
      errors: this._collectErrors(schema, data),
    };
    throw validationResultToError(result);
  }

  /**
   * Walk the schema and data together to find format-annotated string fields.
   * Emits console.warn for each format violation (SHOULD-level enforcement).
   * Returns true if any warnings were emitted.
   */
  private _checkFormats(data: unknown, schema: TSchema): boolean {
    const warnings: string[] = [];
    this._walkFormats(data, schema as Record<string, unknown>, '/', warnings);
    for (const w of warnings) {
      console.warn(`[apcore:schema] ${w}`);
    }
    return warnings.length > 0;
  }

  private _walkFormats(data: unknown, schema: Record<string, unknown>, path: string, warnings: string[]): void {
    if (typeof schema !== 'object' || schema === null) return;

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
