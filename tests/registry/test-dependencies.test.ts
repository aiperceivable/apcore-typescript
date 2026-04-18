import { describe, it, expect } from 'vitest';
import { resolveDependencies } from '../../src/registry/dependencies.js';
import {
  CircularDependencyError,
  DependencyNotFoundError,
  DependencyVersionMismatchError,
} from '../../src/errors.js';

describe('resolveDependencies', () => {
  it('returns empty for empty input', () => {
    expect(resolveDependencies([])).toEqual([]);
  });

  it('returns single module', () => {
    const result = resolveDependencies([['mod.a', []]]);
    expect(result).toEqual(['mod.a']);
  });

  it('resolves linear dependency chain', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.b', [{ moduleId: 'mod.a', optional: false, version: null }]],
      ['mod.a', []],
    ];
    const result = resolveDependencies(modules);
    expect(result.indexOf('mod.a')).toBeLessThan(result.indexOf('mod.b'));
  });

  it('resolves diamond dependency', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.d', [{ moduleId: 'mod.b', optional: false, version: null }, { moduleId: 'mod.c', optional: false, version: null }]],
      ['mod.b', [{ moduleId: 'mod.a', optional: false, version: null }]],
      ['mod.c', [{ moduleId: 'mod.a', optional: false, version: null }]],
      ['mod.a', []],
    ];
    const result = resolveDependencies(modules);
    expect(result.indexOf('mod.a')).toBeLessThan(result.indexOf('mod.b'));
    expect(result.indexOf('mod.a')).toBeLessThan(result.indexOf('mod.c'));
    expect(result.indexOf('mod.b')).toBeLessThan(result.indexOf('mod.d'));
    expect(result.indexOf('mod.c')).toBeLessThan(result.indexOf('mod.d'));
  });

  it('throws CircularDependencyError on cycle', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.b', optional: false, version: null }]],
      ['mod.b', [{ moduleId: 'mod.a', optional: false, version: null }]],
    ];
    expect(() => resolveDependencies(modules)).toThrow(CircularDependencyError);
  });

  it('throws DependencyNotFoundError with DEPENDENCY_NOT_FOUND code for missing required dependency', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.missing', optional: false, version: null }]],
    ];
    try {
      resolveDependencies(modules);
      throw new Error('expected DependencyNotFoundError');
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyNotFoundError);
      expect((err as DependencyNotFoundError).code).toBe('DEPENDENCY_NOT_FOUND');
      const details = (err as DependencyNotFoundError).details as Record<string, unknown>;
      expect(details.moduleId).toBe('mod.a');
      expect(details.dependencyId).toBe('mod.missing');
    }
  });

  it('skips optional missing dependencies', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.missing', optional: true, version: null }]],
    ];
    const result = resolveDependencies(modules);
    expect(result).toEqual(['mod.a']);
  });

  it('cycle path contains only nodes that form a real cycle', () => {
    // Regression: C blocked on external known-but-not-in-batch dep must not
    // get lumped into the reported cycle path alongside the real A<->B cycle.
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.b', optional: false, version: null }]],
      ['mod.b', [{ moduleId: 'mod.a', optional: false, version: null }]],
      ['mod.c', [{ moduleId: 'mod.external', optional: false, version: null }]],
    ];
    const knownIds = new Set(['mod.a', 'mod.b', 'mod.c', 'mod.external']);
    try {
      resolveDependencies(modules, knownIds);
      throw new Error('expected CircularDependencyError');
    } catch (err) {
      expect(err).toBeInstanceOf(CircularDependencyError);
      const path = (err as CircularDependencyError).details.cyclePath as string[];
      expect(path[0]).toBe(path[path.length - 1]);
      expect(new Set(path.slice(0, -1))).toEqual(new Set(['mod.a', 'mod.b']));
    }
  });

  it('accepts dependency when version constraint is satisfied', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.b', optional: false, version: '>=1.0.0' }]],
      ['mod.b', []],
    ];
    const result = resolveDependencies(modules, null, { 'mod.a': '1.0.0', 'mod.b': '1.2.3' });
    expect(result).toEqual(['mod.b', 'mod.a']);
  });

  it('throws DependencyVersionMismatchError when constraint is violated', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.b', optional: false, version: '>=2.0.0' }]],
      ['mod.b', []],
    ];
    try {
      resolveDependencies(modules, null, { 'mod.a': '1.0.0', 'mod.b': '1.2.3' });
      throw new Error('expected DependencyVersionMismatchError');
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyVersionMismatchError);
      const details = (err as DependencyVersionMismatchError).details as Record<string, unknown>;
      expect(details.moduleId).toBe('mod.a');
      expect(details.dependencyId).toBe('mod.b');
      expect(details.required).toBe('>=2.0.0');
      expect(details.actual).toBe('1.2.3');
    }
  });

  it('supports caret (^) and tilde (~) constraints', () => {
    // ^1.2.3 accepts 1.x but not 2.x
    const mkModules = (version: string): Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> => [
      ['mod.a', [{ moduleId: 'mod.b', optional: false, version: version }]],
      ['mod.b', []],
    ];
    expect(() => resolveDependencies(mkModules('^1.2.3'), null, { 'mod.a': '1.0.0', 'mod.b': '1.9.0' })).not.toThrow();
    expect(() => resolveDependencies(mkModules('^1.2.3'), null, { 'mod.a': '1.0.0', 'mod.b': '2.0.0' })).toThrow(
      DependencyVersionMismatchError,
    );
    // ~1.2.3 accepts 1.2.x but not 1.3.0
    expect(() => resolveDependencies(mkModules('~1.2.3'), null, { 'mod.a': '1.0.0', 'mod.b': '1.2.9' })).not.toThrow();
    expect(() => resolveDependencies(mkModules('~1.2.3'), null, { 'mod.a': '1.0.0', 'mod.b': '1.3.0' })).toThrow(
      DependencyVersionMismatchError,
    );
  });

  it('warns when version constraint cannot be evaluated because target has no version', () => {
    // Regression: when a dep declares a version but the target module is
    // absent from moduleVersions (e.g., a pre-registered module whose class
    // lacks a string `version` field), the constraint was silently skipped.
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.b', optional: false, version: '>=2.0.0' }]],
      ['mod.b', []],
    ];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const knownIds = new Set(['mod.a', 'mod.b']);
      const result = resolveDependencies(modules, knownIds, { 'mod.a': '1.0.0' });
      expect(result).toEqual(['mod.b', 'mod.a']);
    } finally {
      console.warn = originalWarn;
    }
    const matching = warnings.filter((w) => w.includes('Cannot enforce version constraint'));
    expect(matching.length).toBe(1);
    expect(matching[0]).toContain("'>=2.0.0'");
    expect(matching[0]).toContain("'mod.b'");
    expect(matching[0]).toContain("'mod.a'");
  });

  it('ignores version when moduleVersions is not provided', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.a', [{ moduleId: 'mod.b', optional: false, version: '>=99.0.0' }]],
      ['mod.b', []],
    ];
    // No moduleVersions arg -> version field is silently ignored
    expect(resolveDependencies(modules)).toEqual(['mod.b', 'mod.a']);
  });

  it('independent modules in deterministic order', () => {
    const modules: Array<[string, Array<{ moduleId: string; optional: boolean; version: string | null }>]> = [
      ['mod.c', []],
      ['mod.a', []],
      ['mod.b', []],
    ];
    const result = resolveDependencies(modules);
    expect(result).toEqual(['mod.a', 'mod.b', 'mod.c']);
  });
});
