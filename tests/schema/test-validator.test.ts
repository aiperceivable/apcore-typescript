import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { SchemaValidator } from '../../src/schema/validator.js';
import { SchemaValidationError } from '../../src/errors.js';
import { validationResultToError } from '../../src/schema/types.js';

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

