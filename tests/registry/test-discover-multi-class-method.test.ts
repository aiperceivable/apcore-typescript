/**
 * D-15: Registry must expose `discoverMultiClass` as an instance method,
 * mirroring Python's `Registry.discover_multi_class` and the Rust trait.
 *
 * The free function is preserved as `_discoverMultiClass` (internal).
 */

import { describe, it, expect } from 'vitest';
import { Registry } from '../../src/registry/registry.js';
import { _discoverMultiClass, discoverMultiClass } from '../../src/registry/multi-class.js';

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
