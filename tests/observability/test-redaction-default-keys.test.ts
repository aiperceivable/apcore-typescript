/**
 * Issue #45 §3 — DEFAULT_REDACTION_FIELD_PATTERNS must match the Python
 * canonical superset (15 entries). Python is authoritative because broader
 * default redaction is safer than narrower.
 *
 * Canonical PY list:
 *   _secret_*, password, passwd, secret, token, api_key, apikey, apiKey,
 *   access_key, private_key, authorization, auth, credential, cookie,
 *   session, bearer
 *
 * Note: 16 strings above but `apikey` and `apiKey` are matched
 * case-insensitively in Python; in TypeScript we keep both spellings as
 * separate entries because matchPattern is case-sensitive — the same
 * coverage with explicit camelCase parity. Final TS count: 16 if
 * `apikey` is also kept; the spec says "15 entries with apiKey camelCase
 * parity", treating `apikey`/`apiKey` as one logical sensitive key but
 * two TS patterns. We assert the full superset is present.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REDACTION_FIELD_PATTERNS,
  RedactionConfig,
} from '../../src/observability/context-logger.js';
import { Config } from '../../src/config.js';

describe('DEFAULT_REDACTION_FIELD_PATTERNS canonical superset (#45 §3)', () => {
  const expected = [
    '_secret_*',
    'password',
    'passwd',
    'secret',
    'token',
    'api_key',
    'apikey',
    'apiKey',
    'access_key',
    'private_key',
    'authorization',
    'auth',
    'credential',
    'cookie',
    'session',
    'bearer',
  ];

  it('contains every entry from the Python canonical set', () => {
    for (const key of expected) {
      expect(DEFAULT_REDACTION_FIELD_PATTERNS).toContain(key);
    }
  });

  it('keeps apiKey camelCase parity alongside api_key/apikey', () => {
    expect(DEFAULT_REDACTION_FIELD_PATTERNS).toContain('apiKey');
    expect(DEFAULT_REDACTION_FIELD_PATTERNS).toContain('api_key');
    expect(DEFAULT_REDACTION_FIELD_PATTERNS).toContain('apikey');
  });

  it('default config redacts every canonical sensitive field', () => {
    const rc = RedactionConfig.fromConfig(new Config());

    const sample: Record<string, unknown> = {
      _secret_x: 'a',
      password: 'b',
      passwd: 'c',
      secret: 'd',
      token: 'e',
      api_key: 'f',
      apikey: 'g',
      apiKey: 'h',
      access_key: 'i',
      private_key: 'j',
      authorization: 'k',
      auth: 'l',
      credential: 'm',
      cookie: 'n',
      session: 'o',
      bearer: 'p',
      visible: 'ok',
    };

    const result = rc.apply(sample);
    for (const key of Object.keys(sample)) {
      if (key === 'visible') {
        expect(result[key]).toBe('ok');
      } else {
        expect(result[key]).toBe('***REDACTED***');
      }
    }
  });
});
