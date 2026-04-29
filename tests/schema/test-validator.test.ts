import { describe, it, expect, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { SchemaValidator } from '../../src/schema/validator.js';
import { SchemaValidationError } from '../../src/errors.js';
import { validationResultToError } from '../../src/schema/types.js';
import { jsonSchemaToTypeBox } from '../../src/schema/loader.js';

describe('SchemaValidator', () => {
  it('validates correct data', () => {
    const validator = new SchemaValidator();
    const schema = Type.Object({ name: Type.String() });
    const result = validator.validate({ name: 'Alice' }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid data', () => {
    const validator = new SchemaValidator();
    const schema = Type.Object({ name: Type.String() });
    const result = validator.validate({ name: 123 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates without coercion', () => {
    const validator = new SchemaValidator(false);
    const schema = Type.Object({ x: Type.Number() });
    const result = validator.validate({ x: 42 }, schema);
    expect(result.valid).toBe(true);
  });

  it('validateInput returns data on valid input', () => {
    const validator = new SchemaValidator();
    const schema = Type.Object({ x: Type.Number() });
    const data = validator.validateInput({ x: 42 }, schema);
    expect(data['x']).toBe(42);
  });

  it('validateInput throws on invalid input', () => {
    const validator = new SchemaValidator();
    const schema = Type.Object({ x: Type.Number() });
    expect(() => validator.validateInput({ x: 'not-a-number' }, schema)).toThrow(SchemaValidationError);
  });

  it('validateOutput returns data on valid output', () => {
    const validator = new SchemaValidator();
    const schema = Type.Object({ result: Type.String() });
    const data = validator.validateOutput({ result: 'ok' }, schema);
    expect(data['result']).toBe('ok');
  });

  it('validateOutput throws on invalid output', () => {
    const validator = new SchemaValidator();
    const schema = Type.Object({ result: Type.String() });
    expect(() => validator.validateOutput({ result: 123 }, schema)).toThrow(SchemaValidationError);
  });

  it('error details include path and message', () => {
    const validator = new SchemaValidator();
    const schema = Type.Object({ nested: Type.Object({ x: Type.Number() }) });
    const result = validator.validate({ nested: { x: 'bad' } }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBeDefined();
    expect(result.errors[0].message).toBeDefined();
  });

  it('returns invalid result without coercion when data fails Check', () => {
    const validator = new SchemaValidator(false);
    const schema = Type.Object({ x: Type.Number() });
    const result = validator.validate({ x: 'not-a-number' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validateInput without coercion returns data on valid input', () => {
    const validator = new SchemaValidator(false);
    const schema = Type.Object({ x: Type.Number() });
    const data = validator.validateInput({ x: 42 }, schema);
    expect(data['x']).toBe(42);
  });

  it('validateInput without coercion throws on invalid input', () => {
    const validator = new SchemaValidator(false);
    const schema = Type.Object({ x: Type.Number() });
    expect(() => validator.validateInput({ x: 'not-a-number' }, schema)).toThrow(SchemaValidationError);
  });
});

describe('SchemaValidator — oneOf exhaustive validation', () => {
  const validator = new SchemaValidator(false);

  it('accepts input matching exactly one oneOf branch', () => {
    const schema = jsonSchemaToTypeBox({
      oneOf: [
        { type: 'object', properties: { kind: { const: 'circle' }, radius: { type: 'number' } }, required: ['kind', 'radius'] },
        { type: 'object', properties: { kind: { const: 'rect' }, width: { type: 'number' } }, required: ['kind', 'width'] },
      ],
    });
    const result = validator.validate({ kind: 'circle', radius: 5 }, schema);
    expect(result.valid).toBe(true);
  });

  it('rejects input matching zero oneOf branches with SCHEMA_UNION_NO_MATCH', () => {
    const schema = jsonSchemaToTypeBox({
      oneOf: [
        { type: 'object', properties: { kind: { const: 'circle' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { const: 'rect' } }, required: ['kind'] },
      ],
    });
    const result = validator.validate({ kind: 'triangle' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SCHEMA_UNION_NO_MATCH');
  });

  it('rejects input matching multiple oneOf branches with SCHEMA_UNION_AMBIGUOUS', () => {
    // Both branches accept this input — regression test for short-circuit bug
    const schema = jsonSchemaToTypeBox({
      oneOf: [
        { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
        { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
      ],
    });
    const result = validator.validate({ value: 42 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SCHEMA_UNION_AMBIGUOUS');
  });
});

describe('SchemaValidator — anyOf validation', () => {
  const validator = new SchemaValidator(false);

  it('accepts input matching the first anyOf branch', () => {
    const schema = jsonSchemaToTypeBox({
      anyOf: [
        { type: 'object', properties: { kind: { const: 'circle' }, radius: { type: 'number' } }, required: ['kind', 'radius'] },
        { type: 'object', properties: { kind: { const: 'rect' }, width: { type: 'number' } }, required: ['kind', 'width'] },
      ],
    });
    const result = validator.validate({ kind: 'circle', radius: 5 }, schema);
    expect(result.valid).toBe(true);
  });

  it('accepts input matching only the second anyOf branch', () => {
    const schema = jsonSchemaToTypeBox({
      anyOf: [
        { type: 'object', properties: { kind: { const: 'circle' } }, required: ['kind', 'radius'] },
        { type: 'object', properties: { kind: { const: 'rect' }, width: { type: 'number' } }, required: ['kind', 'width'] },
      ],
    });
    const result = validator.validate({ kind: 'rect', width: 10 }, schema);
    expect(result.valid).toBe(true);
  });

  it('rejects input matching no anyOf branches with SCHEMA_UNION_NO_MATCH', () => {
    const schema = jsonSchemaToTypeBox({
      anyOf: [
        { type: 'object', properties: { kind: { const: 'circle' } }, required: ['kind'] },
        { type: 'object', properties: { kind: { const: 'rect' } }, required: ['kind'] },
      ],
    });
    const result = validator.validate({ kind: 'triangle' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SCHEMA_UNION_NO_MATCH');
  });
});

describe('SchemaValidator — format warnings (SHOULD-level)', () => {
  it('passes structurally valid data and does not warn for valid formats', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
      required: ['email'],
    });
    const result = validator.validate({ email: 'alice@example.com' }, schema);
    expect(result.valid).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('passes structurally but warns for invalid format (warn_logged: true)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { ts: { type: 'string', format: 'date-time' } },
      required: ['ts'],
    });
    const result = validator.validate({ ts: 'not-a-date' }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('emits format warning for invalid email inside oneOf branch (regression: union skipped _checkFormats)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      oneOf: [
        {
          type: 'object',
          properties: { contact: { type: 'string', format: 'email' } },
          required: ['contact'],
        },
      ],
    });
    const result = validator.validate({ contact: 'not-an-email' }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('emits format warning for invalid format inside array items (regression: _walkFormats array coverage)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        emails: { type: 'array', items: { type: 'string', format: 'email' } },
      },
      required: ['emails'],
    });
    const result = validator.validate({ emails: ['valid@example.com', 'not-an-email'] }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('SchemaValidator — errorCode in results', () => {
  const validator = new SchemaValidator(false);

  it('sets errorCode SCHEMA_VALIDATION_FAILED on plain type failure', () => {
    const schema = jsonSchemaToTypeBox({ type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] });
    const result = validator.validate({ x: 'not-an-int' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SCHEMA_VALIDATION_FAILED');
  });
});

describe('validationResultToError', () => {
  it('throws when result is valid', () => {
    expect(() => validationResultToError({ valid: true, errors: [] })).toThrow(
      'Cannot convert valid result to error',
    );
  });

  it('converts invalid result to SchemaValidationError', () => {
    const result = {
      valid: false,
      errors: [{ path: '/foo', message: 'required', constraint: 'required', expected: 'string', actual: null }],
    };
    const err = validationResultToError(result);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err.message).toContain('Schema validation failed');
  });

  it('normalizes absent constraint and expected to null', () => {
    const result = {
      valid: false,
      errors: [{ path: '/bar', message: 'missing field' }],
    };
    const err = validationResultToError(result);
    expect(err).toBeInstanceOf(SchemaValidationError);
  });
});

