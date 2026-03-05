import { describe, it, expect, vi } from 'vitest';
import { negotiateVersion, VersionIncompatibleError } from '../src/version.js';

describe('negotiateVersion', () => {
  it('returns declared version when minor versions match', () => {
    expect(negotiateVersion('1.2.3', '1.2.3')).toBe('1.2.3');
  });

  it('returns max when same minor, different patch', () => {
    expect(negotiateVersion('1.2.3', '1.2.5')).toBe('1.2.5');
    expect(negotiateVersion('1.2.5', '1.2.3')).toBe('1.2.5');
  });

  it('throws on major version mismatch', () => {
    expect(() => negotiateVersion('1.0.0', '2.0.0')).toThrow(VersionIncompatibleError);
    expect(() => negotiateVersion('2.0.0', '1.0.0')).toThrow(VersionIncompatibleError);
  });

  it('throws when declared minor > SDK minor', () => {
    expect(() => negotiateVersion('1.5.0', '1.2.0')).toThrow(VersionIncompatibleError);
    expect(() => negotiateVersion('1.5.0', '1.2.0')).toThrow('SDK version too low');
  });

  it('returns declared version in backward compatibility mode', () => {
    expect(negotiateVersion('1.2.0', '1.4.0')).toBe('1.2.0');
  });

  it('warns when gap exceeds threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    negotiateVersion('1.2.0', '1.5.0');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('3 minor versions behind'));
    warnSpy.mockRestore();
  });

  it('does not warn when gap is within threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    negotiateVersion('1.2.0', '1.4.0');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handles pre-release versions', () => {
    // Pre-release has lower precedence
    expect(negotiateVersion('1.2.3-alpha', '1.2.3')).toBe('1.2.3');
    expect(negotiateVersion('1.2.3', '1.2.3-alpha')).toBe('1.2.3');
  });

  it('throws on invalid semver', () => {
    expect(() => negotiateVersion('not-a-version', '1.0.0')).toThrow('Invalid semantic version');
  });

  it('handles 0.x versions', () => {
    expect(negotiateVersion('0.7.0', '0.7.2')).toBe('0.7.2');
  });
});
