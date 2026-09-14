/**
 * Drive `allow_unknown_namespaces.json` — §9.6.3 `_config.allow_unknown`
 * (#118 D-69).
 *
 * Both halves of the `strict: false` row were inert. `allow_unknown: false` is
 * documented as "silently ignored (not stored)" and the namespace was stored
 * anyway; `allow_unknown: true` is documented as "stored, accessible, **WARN
 * logged**" and nothing logged. Fixing one without the other leaves the row
 * half true, so the fixture drives both — and the legacy-mode boundary
 * besides, so the namespace-only scoping is a decision rather than an omission.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import yaml from 'js-yaml';

import { Config } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { findFixturesRoot } from './spec-repo.js';

interface AllowUnknownCase {
  readonly id: string;
  readonly input: {
    readonly mode: 'namespace' | 'legacy';
    readonly config: Record<string, unknown> | null;
    readonly namespace: string | null;
  };
  readonly expected: Record<string, unknown>;
}

const fixture: { test_cases: readonly AllowUnknownCase[] } = JSON.parse(
  fs.readFileSync(path.join(findFixturesRoot(), 'allow_unknown_namespaces.json'), 'utf-8'),
);

const BASE = { version: '1.0', project: { name: 'allow-unknown-probe' } };

describe('allow_unknown_namespaces.json', () => {
  for (const testCase of fixture.test_cases) {
    it(testCase.id, () => {
      const { input, expected } = testCase;
      const doc: Record<string, unknown> =
        input.mode === 'namespace' ? { apcore: { ...BASE } } : { ...BASE };
      if (input.config !== null) doc['_config'] = { ...input.config };
      if (input.namespace !== null) doc[input.namespace] = { x: 1 };

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-allow-unknown-'));
      const file = path.join(dir, 'apcore.yaml');
      fs.writeFileSync(file, yaml.dump(doc), 'utf-8');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});

      if (expected['loads'] === false) {
        let thrown: unknown;
        try {
          Config.load(file);
        } catch (e) {
          thrown = e;
        }
        warn.mockRestore();
        info.mockRestore();
        expect(thrown).toBeInstanceOf(ConfigError);
        expect((thrown as ConfigError).code).toBe(expected['error_code']);
        expect(String(thrown)).toContain(expected['error_message_contains']);
        return;
      }

      const config = Config.load(file);
      const messages = [...warn.mock.calls, ...info.mock.calls].map((c) => String(c[0]));
      warn.mockRestore();
      info.mockRestore();

      if ('value_readable' in expected) {
        const value = config.get(`${input.namespace}.x`);
        expect(value !== undefined && value !== null).toBe(expected['value_readable']);
      }
      if ('warns_naming' in expected) {
        const needle = expected['warns_naming'] as string;
        const hits = messages.filter((m) => m.includes(needle) && m.includes('registered'));
        expect(hits).toHaveLength(1);
      }
      if ('warns_absent' in expected) {
        const needle = expected['warns_absent'] as string;
        expect(messages.some((m) => m.includes(needle))).toBe(false);
      }
    });
  }
});
