import { describe, it, expect } from 'vitest';
import { ErrorCodeRegistry, ErrorCodeCollisionError, FRAMEWORK_ERROR_CODE_PREFIXES } from '../src/error-code-registry.js';
import { ErrorCodes } from '../src/errors.js';

describe('ErrorCodeRegistry', () => {
  it('registers custom codes successfully', () => {
    const reg = new ErrorCodeRegistry();
    reg.register('my.module', new Set(['CUSTOM_ERROR_1', 'CUSTOM_ERROR_2']));
    expect(reg.allCodes.has('CUSTOM_ERROR_1')).toBe(true);
    expect(reg.allCodes.has('CUSTOM_ERROR_2')).toBe(true);
  });

  it('throws on collision with framework codes', () => {
    const reg = new ErrorCodeRegistry();
    expect(() => reg.register('my.module', new Set([ErrorCodes.MODULE_NOT_FOUND]))).toThrow(ErrorCodeCollisionError);
  });

  it('throws on collision with reserved prefix', () => {
    const reg = new ErrorCodeRegistry();
    expect(() => reg.register('my.module', new Set(['MODULE_CUSTOM']))).toThrow(ErrorCodeCollisionError);
  });

  it('throws on collision with another module', () => {
    const reg = new ErrorCodeRegistry();
    reg.register('module.a', new Set(['CUSTOM_CODE']));
    expect(() => reg.register('module.b', new Set(['CUSTOM_CODE']))).toThrow(ErrorCodeCollisionError);
  });

  it('allows same module to re-register same codes', () => {
    const reg = new ErrorCodeRegistry();
    reg.register('my.module', new Set(['CUSTOM_CODE']));
    expect(() => reg.register('my.module', new Set(['CUSTOM_CODE']))).not.toThrow();
  });

  it('unregisters codes', () => {
    const reg = new ErrorCodeRegistry();
    reg.register('my.module', new Set(['CUSTOM_CODE']));
    reg.unregister('my.module');
    expect(reg.allCodes.has('CUSTOM_CODE')).toBe(false);
  });

  it('skips empty code set', () => {
    const reg = new ErrorCodeRegistry();
    reg.register('my.module', new Set());
    // No error thrown
  });

  it('includes framework codes in allCodes', () => {
    const reg = new ErrorCodeRegistry();
    expect(reg.allCodes.has(ErrorCodes.MODULE_NOT_FOUND)).toBe(true);
  });

  it('has expected framework prefixes', () => {
    expect(FRAMEWORK_ERROR_CODE_PREFIXES.has('MODULE_')).toBe(true);
    expect(FRAMEWORK_ERROR_CODE_PREFIXES.has('SCHEMA_')).toBe(true);
    expect(FRAMEWORK_ERROR_CODE_PREFIXES.has('ACL_')).toBe(true);
  });
});
