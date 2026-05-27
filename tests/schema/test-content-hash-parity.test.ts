/**
 * A-D-037 support — compute contentHash for tricky schemas (float 1.0, unicode
 * string/key, large integer, unsorted-key object, baseline) and surface the
 * hex digests so cross-repo (Python/Rust) byte-for-byte parity can be verified.
 *
 * Schemas mirror apcore/conformance/fixtures/schema_content_hash.json. The
 * fixture intentionally records no `expected` hash — each SDK computes it and
 * the harness compares across repos.
 */

import { describe, it, expect } from 'vitest';
import { contentHash } from '../../src/schema/loader.js';

// Schemas are parsed from raw JSON text (mirroring how the conformance harness
// consumes apcore/conformance/fixtures/schema_content_hash.json) so that
// large-integer literals are not introduced as JS source-level numbers (which
// biome's noPrecisionLoss flags). This faithfully reproduces the SDK's real
// canonicalization path: JSON in → contentHash out.
const CASES_JSON: Record<string, string> = {
  float_one_point_zero:
    '{"type":"object","properties":{"ratio":{"type":"number","default":1.0,"minimum":0.0,"maximum":1.0}},"required":["ratio"]}',
  non_ascii_unicode_key_and_value:
    '{"type":"object","properties":{"名前":{"type":"string","default":"café—naïve—🦀","description":"Unicode key with combining/emoji value"},"δ":{"type":"string","default":"Ω≈ç√∫"}},"required":["名前"]}',
  large_integer:
    '{"type":"object","properties":{"max_id":{"type":"integer","default":9007199254740993,"maximum":18446744073709551615}},"required":["max_id"]}',
  nested_unsorted_keys:
    '{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"object","properties":{"yankee":{"type":"boolean"},"bravo":{"type":"integer"},"mike":{"type":"string"}}},"delta":{"type":"array","items":{"type":"number"}}},"required":["zeta","alpha"]}',
  baseline_simple_object:
    '{"type":"object","properties":{"name":{"type":"string"},"count":{"type":"integer"}},"required":["name"]}',
};

const CASES: Record<string, unknown> = Object.fromEntries(
  Object.entries(CASES_JSON).map(([id, json]) => [id, JSON.parse(json)]),
);

describe('contentHash parity digests (A-D-037)', () => {
  it('computes a stable 64-char hex digest for each tricky schema and reports them', () => {
    const digests: Record<string, string> = {};
    for (const [id, schema] of Object.entries(CASES)) {
      const hex = contentHash(schema);
      digests[id] = hex;
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
    // Determinism: hashing again yields identical digests.
    for (const [id, schema] of Object.entries(CASES)) {
      expect(contentHash(schema)).toBe(digests[id]);
    }
    // Surface the digests for cross-repo comparison.
    // eslint-disable-next-line no-console
    console.log('A-D-037 contentHash digests (apcore-js):\n' + JSON.stringify(digests, null, 2));
  });
});
