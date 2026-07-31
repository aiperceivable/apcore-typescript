import { describe, it, expect, vi, afterEach } from 'vitest';
import { Type, FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
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

describe('SchemaValidator — unrecognised format is an annotation (apexe#32)', () => {
  // JSON Schema 2020-12 format-annotation vocabulary: a format the implementation
  // does not recognise is collected as an annotation and MUST NOT fail validation.
  // apcore-python (pydantic json_schema_extra) and apcore-rust (jsonschema crate,
  // Draft 2020-12 with format assertion off) both ignore it; TS used to reject.

  it('accepts a string carrying an unregistered format', () => {
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { path: { type: 'string', format: 'path' } },
      required: ['path'],
    });
    const result = validator.validate({ path: '/tmp/z' }, schema);
    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('does not warn for an unrecognised format (nothing to assert)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: 'string', format: 'bogus-xyz' } },
      required: ['a'],
    });
    const result = validator.validate({ a: '/tmp/z' }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts an unregistered format inside array items (the apexe path operand case)', () => {
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { path: { type: 'array', items: { type: 'string', format: 'path' } } },
      required: ['path'],
    });
    const result = validator.validate({ path: ['/tmp/z'] }, schema);
    expect(result.valid).toBe(true);
  });

  it('accepts an unregistered format inside a oneOf branch', () => {
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      oneOf: [
        { type: 'object', properties: { p: { type: 'string', format: 'path' } }, required: ['p'] },
      ],
    });
    const result = validator.validate({ p: '/tmp/z' }, schema);
    expect(result.valid).toBe(true);
  });

  it('validateInput returns the data instead of throwing for an unregistered format', () => {
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { p: { type: 'string', format: 'path' } },
      required: ['p'],
    });
    expect(validator.validateInput({ p: '/tmp/z' }, schema)['p']).toBe('/tmp/z');
  });

  it('accepts an unregistered format on a TypeBox schema built without the converter', () => {
    const validator = new SchemaValidator(false);
    const schema = Type.Object({ p: Type.String({ format: 'unregistered-xyz' }) });
    expect(validator.validate({ p: '/tmp/z' }, schema).valid).toBe(true);
  });

  it('keeps the format value on the converted schema (it is an annotation, not dropped)', () => {
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { p: { type: 'string', format: 'path' } },
      required: ['p'],
    }) as unknown as { properties: { p: { format?: string } } };
    expect(schema.properties.p.format).toBe('path');
  });

  it('still rejects a type mismatch on a property carrying an unregistered format', () => {
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { p: { type: 'string', format: 'path' } },
      required: ['p'],
    });
    const result = validator.validate({ p: 42 } as unknown as Record<string, unknown>, schema);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SCHEMA_VALIDATION_ERROR');
  });

  it('a recognised format that fails still warns and still passes (SHOULD-level, unchanged)', () => {
    // The other half of apexe#32: this stays a warning. The cross-SDK contract is
    // the conformance fixture schema_hardening_formats.json — valid: true,
    // warn_logged: true — and both apcore-python and apcore-rust behave this way.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: 'string', format: 'uri' } },
      required: ['a'],
    });
    const result = validator.validate({ a: '/tmp/z' }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Format 'uri' validation failed at /a"));
    warnSpy.mockRestore();
  });
});

describe('SchemaValidator — errorCode in results', () => {
  const validator = new SchemaValidator(false);

  it('sets errorCode SCHEMA_VALIDATION_ERROR on plain type failure', () => {
    const schema = jsonSchemaToTypeBox({ type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] });
    const result = validator.validate({ x: 'not-an-int' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('SCHEMA_VALIDATION_ERROR');
  });

  it('throws SchemaValidationError carrying SCHEMA_VALIDATION_ERROR code via validateInput', () => {
    const schema = jsonSchemaToTypeBox({ type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] });
    try {
      validator.validateInput({ x: 'not-an-int' }, schema);
      throw new Error('expected validateInput to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).code).toBe('SCHEMA_VALIDATION_ERROR');
    }
  });

  it('preserves SCHEMA_UNION_AMBIGUOUS code through validateInput (A-D-033)', () => {
    const schema = jsonSchemaToTypeBox({
      oneOf: [
        { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
        { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
      ],
    });
    try {
      validator.validateInput({ value: 42 }, schema);
      throw new Error('expected validateInput to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).code).toBe('SCHEMA_UNION_AMBIGUOUS');
    }
  });
});

describe('SchemaValidator — format warnings reach into unions and intersections', () => {
  it('warns for a format on a branch of a type array', () => {
    // `{type: ["string","null"], format: "email"}` converts to a union, and the
    // format annotation lands on the string branch. The walk used to stop at the
    // union node, so this was the one shape where a recognised format was not
    // enforced at all.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: ['string', 'null'], format: 'email' } },
      required: ['a'],
    });
    const result = new SchemaValidator(false).validate({ a: 'not-an-email' }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Format 'email' validation failed at /a"));
    warnSpy.mockRestore();
  });

  it('does not warn when the data matches a branch carrying no format', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: ['string', 'null'], format: 'email' } },
      required: ['a'],
    });
    const result = new SchemaValidator(false).validate({ a: null }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns for a format on a schema that also carries a combinator sibling', () => {
    // `type` + `enum` converts to an intersection; the format annotation is on
    // the type-derived member.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        a: { type: 'string', format: 'email', enum: ['not-an-email', 'a@b.com'] },
      },
      required: ['a'],
    });
    const result = new SchemaValidator(false).validate({ a: 'not-an-email' }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Format 'email' validation failed at /a"));
    warnSpy.mockRestore();
  });
});

describe('SchemaValidator — format handling does not leak into the global registry', () => {
  // `FormatRegistry` is process-global and shared with the host application.
  // apcore's annotation semantics must not depend on who registered first, and
  // apcore must not leave accept-everything checkers behind for the host.
  afterEach(() => {
    FormatRegistry.Delete('email');
    FormatRegistry.Delete('apcore-leaked-fmt');
  });

  it('keeps warn-only semantics when the host registered a strict checker first', () => {
    // The failing scenario: a TypeBox host registers a strict `email` checker at
    // startup. Before the scoped override, apcore deferred to it and turned the
    // conformance fixture case into a hard SCHEMA_VALIDATION_ERROR.
    FormatRegistry.Set('email', (v) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validator = new SchemaValidator(false);
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: 'string', format: 'email' } },
      required: ['a'],
    });
    const result = validator.validate({ a: 'not-an-email' }, schema);
    expect(result.valid).toBe(true);
    expect(result.warnLogged).toBe(true);
    expect(result.errorCode).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("restores the host's own checker after validating", () => {
    const strict = (v: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v);
    FormatRegistry.Set('email', strict);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: 'string', format: 'email' } },
      required: ['a'],
    });
    new SchemaValidator(false).validate({ a: 'not-an-email' }, schema);
    warnSpy.mockRestore();
    expect(FormatRegistry.Get('email')).toBe(strict);
    // The host's schema still rejects garbage.
    expect(Value.Check(Type.String({ format: 'email' }), 'not-an-email')).toBe(false);
  });

  it('does not register an unknown format the schema carried', () => {
    const schema = jsonSchemaToTypeBox({
      type: 'object',
      properties: { a: { type: 'string', format: 'apcore-leaked-fmt' } },
      required: ['a'],
    });
    expect(new SchemaValidator(false).validate({ a: 'anything' }, schema).valid).toBe(true);
    expect(FormatRegistry.Has('apcore-leaked-fmt')).toBe(false);
  });

  it('does not register the formats apcore recognises', () => {
    // Constructing a validator used to register every FORMAT_VALIDATORS key
    // process-globally, so a host's `Type.String({format:'email'})` silently
    // stopped rejecting garbage.
    new SchemaValidator(false);
    expect(FormatRegistry.Has('email')).toBe(false);
  });
});

describe('SchemaValidator — enum beside a type array (apexe value-optional flag)', () => {
  // `{"type": ["string","boolean"], "enum": [...]}` is what apexe emits for
  // `ls --color[=WHEN]`. The enum must be enforced at the validation boundary,
  // or a bogus value reaches argv. apcore-rust and apcore-python both reject it.
  const schema = jsonSchemaToTypeBox({
    type: 'object',
    properties: {
      color: {
        type: ['string', 'boolean'],
        enum: ['always', 'auto', 'never'],
        description: 'colorize the output',
      },
    },
    required: ['color'],
    additionalProperties: false,
  });

  for (const coerceTypes of [true, false]) {
    it(`accepts an enum member (coerceTypes=${coerceTypes})`, () => {
      const validator = new SchemaValidator(coerceTypes);
      expect(validator.validate({ color: 'always' }, schema).valid).toBe(true);
    });

    it(`rejects a non-member string (coerceTypes=${coerceTypes})`, () => {
      const validator = new SchemaValidator(coerceTypes);
      const result = validator.validate({ color: 'bogus-not-in-enum' }, schema);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('SCHEMA_VALIDATION_ERROR');
    });
  }
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

