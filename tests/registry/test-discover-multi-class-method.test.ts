/**
 * D-15: Registry must expose `discoverMultiClass` as an instance method,
 * mirroring Python's `Registry.discover_multi_class` and the Rust trait.
 *
 * The free function is preserved as `_discoverMultiClass` (internal).
 */

import { describe, it, expect } from 'vitest';
import { Registry } from '../../src/registry/registry.js';
import { _discoverMultiClass, discoverMultiClass, classNameToSegment } from '../../src/registry/multi-class.js';
import { IdTooLongError, InvalidSegmentError, ModuleIdConflictError } from '../../src/errors.js';

describe('Registry.discoverMultiClass', () => {
  it('exists as an instance method', () => {
    const registry = new Registry();
    expect(typeof (registry as unknown as { discoverMultiClass: unknown }).discoverMultiClass).toBe('function');
  });

  it('returns the same result as the free function', () => {
    const registry = new Registry();
    const filePath = 'extensions/email/sender.ts';
    const classes = [
      { name: 'EmailSender', implementsModule: true },
      { name: 'EmailFormatter', implementsModule: true },
    ];

    const free = _discoverMultiClass(filePath, classes, 'extensions', true);
    const method = registry.discoverMultiClass(filePath, classes, 'extensions', true);
    expect(method).toEqual(free);
  });

  it('preserves single-class identity guarantee', () => {
    const registry = new Registry();
    const result = registry.discoverMultiClass(
      'extensions/email/sender.ts',
      [{ name: 'Sender', implementsModule: true }],
      'extensions',
      true,
    );
    expect(result).toEqual([{ moduleId: 'email.sender', className: 'Sender' }]);
  });

  it('public free function is still exported for backwards compatibility', () => {
    expect(typeof discoverMultiClass).toBe('function');
  });
});

describe('discoverMultiClass — edge branches', () => {
  it('returns empty array when no classes implement Module', () => {
    const result = discoverMultiClass(
      'extensions/foo/bar.ts',
      [{ name: 'Plain', implementsModule: false }],
      'extensions',
      true,
    );
    expect(result).toEqual([]);
  });

  it('non-multi-class mode returns the bare base_id even with multiple qualifying classes', () => {
    const result = discoverMultiClass(
      'extensions/email/sender.ts',
      [
        { name: 'A', implementsModule: true },
        { name: 'B', implementsModule: true },
      ],
      'extensions',
      false,
    );
    expect(result).toEqual([{ moduleId: 'email.sender', className: 'A' }]);
  });

  it('throws InvalidSegmentError for a single class whose segment is not a valid identifier', () => {
    expect(() =>
      discoverMultiClass(
        'extensions/email/sender.ts',
        [{ name: '__', implementsModule: true }],
        'extensions',
        true,
      ),
    ).toThrow(InvalidSegmentError);
  });

  it('throws IdTooLongError for a single class whose appended id exceeds 192 chars', () => {
    const longSegment = 'a'.repeat(220);
    const filePath = `extensions/${longSegment}/file.ts`;
    expect(() =>
      discoverMultiClass(
        filePath,
        [{ name: 'Other', implementsModule: true }],
        'extensions',
        true,
      ),
    ).toThrow(IdTooLongError);
  });

  it('throws ModuleIdConflictError when two classes derive the same segment', () => {
    expect(() =>
      discoverMultiClass(
        'extensions/email/sender.ts',
        [
          { name: 'EmailSender', implementsModule: true },
          { name: 'Email_Sender', implementsModule: true },
        ],
        'extensions',
        true,
      ),
    ).toThrow(ModuleIdConflictError);
  });

  it('throws InvalidSegmentError in the multi-class loop when the file path produces a non-canonical baseId', () => {
    // baseId="123bad.sender" — starts with a digit, so the composed moduleId
    // fails CANONICAL_ID_RE even though the per-class segment passes SEGMENT_RE.
    expect(() =>
      discoverMultiClass(
        'extensions/123bad/sender.ts',
        [
          { name: 'Alpha', implementsModule: true },
          { name: 'Beta', implementsModule: true },
        ],
        'extensions',
        true,
      ),
    ).toThrow(InvalidSegmentError);
  });

  it('throws IdTooLongError in the multi-class loop when the composed id exceeds 192 chars', () => {
    const longDir = 'a'.repeat(200);
    expect(() =>
      discoverMultiClass(
        `extensions/${longDir}/file.ts`,
        [
          { name: 'Alpha', implementsModule: true },
          { name: 'Beta', implementsModule: true },
        ],
        'extensions',
        true,
      ),
    ).toThrow(IdTooLongError);
  });

  it('classNameToSegment handles the documented transitions', () => {
    expect(classNameToSegment('HTTPSender')).toBe('http_sender');
    expect(classNameToSegment('MathOps')).toBe('math_ops');
    expect(classNameToSegment('Has-Dash')).toBe('has_dash');
    expect(classNameToSegment('_LeadingUnderscore_')).toBe('leading_underscore');
  });
});
