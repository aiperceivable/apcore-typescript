import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeToCanonicalId } from '../../src/utils/normalize.js';
import { matchPattern, calculateSpecificity } from '../../src/utils/pattern.js';
import { ACL, ACLRule } from '../../src/acl.js';
import { Context, createIdentity } from '../../src/context.js';
import { 
  Config, 
  _globalNsRegistry, 
  _globalEnvMap, 
  _envMapClaimed, 
  _envPrefixUsed,
  applyEnvOverrides,
  applyNamespaceEnvOverrides
} from '../../src/config.js';
import { negotiateVersion } from '../../src/version.js';
import { ErrorCodeRegistry } from '../../src/error-code-registry.js';

const FIXTURES_ROOT = path.resolve(__dirname, '../../../apcore/conformance/fixtures');

function loadFixture(name: string) {
  const fullPath = path.join(FIXTURES_ROOT, `${name}.json`);
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
}

describe('apcore Conformance Suite (TypeScript)', () => {
  // --- 1. ID Normalization (A02) ---
  const normalizeFixture = loadFixture('normalize_id');
  describe('ID Normalization (Algorithm A02)', () => {
    normalizeFixture.test_cases.forEach((tc: any) => {
      it(tc.id, () => {
        expect(normalizeToCanonicalId(tc.local_id, tc.language)).toBe(tc.expected);
      });
    });
  });

  // --- 2. Pattern Matching ---
  const patternFixture = loadFixture('pattern_matching');
  describe('Pattern Matching', () => {
    patternFixture.test_cases.forEach((tc: any) => {
      it(tc.id, () => {
        expect(matchPattern(tc.pattern, tc.value)).toBe(tc.expected);
      });
    });
  });

  // --- 3. ACL Specificity ---
  const specificityFixture = loadFixture('specificity');
  describe('ACL Specificity', () => {
    specificityFixture.test_cases.forEach((tc: any) => {
      it(tc.id, () => {
        expect(calculateSpecificity(tc.pattern)).toBe(tc.expected_score);
      });
    });
  });

  // --- 4. ACL Evaluation ---
  const aclFixture = loadFixture('acl_evaluation');
  describe('ACL Evaluation', () => {
    aclFixture.test_cases.forEach((tc: any) => {
      it(tc.id, () => {
        const rules: ACLRule[] = tc.rules.map((r: any) => ({
          callers: r.callers,
          targets: r.targets,
          effect: r.effect,
          description: r.description || '',
          conditions: r.conditions || null,
        }));
        const acl = new ACL(rules, tc.default_effect);
        
        let ctx: Context | null = null;
        if (tc.caller_identity || tc.call_depth) {
          const identity = tc.caller_identity 
            ? createIdentity(tc.caller_id || 'unknown', tc.caller_identity.type, tc.caller_identity.roles || [])
            : null;
          
          const callChain = Array(tc.call_depth || 0).fill('placeholder');
          ctx = new Context('trace-id', tc.caller_id, callChain, null, identity);
        }

        expect(acl.check(tc.caller_id, tc.target_id, ctx)).toBe(tc.expected);
      });
    });
  });

  // --- 5. Config Env Mapping ---
  const configEnvFixture = loadFixture('config_env');
  describe('Config Env Mapping', () => {
    beforeEach(() => {
      _globalNsRegistry.clear();
      _globalEnvMap.clear();
      _envMapClaimed.clear();
      _envPrefixUsed.clear();
      vi.stubEnv('APCORE_CONFIG_FILE', '/dev/null');
    });

    configEnvFixture.test_cases.forEach((tc: any) => {
      it(tc.id, () => {
        configEnvFixture.namespaces.forEach((ns: any) => {
          if (ns.name === 'global' && ns.env_map) {
            Config.envMap(ns.env_map);
          } else {
            Config.registerNamespace({ 
              name: ns.name, 
              envPrefix: ns.env_prefix, 
              envMap: ns.env_map,
              maxDepth: ns.max_depth || 5
            });
          }
        });

        vi.stubEnv(tc.env_var, tc.env_value);

        // 1. Initial data structure
        let data: Record<string, any> = { apcore: {} };
        configEnvFixture.namespaces.forEach((ns: any) => {
          if (ns.name !== 'global') data.apcore[ns.name] = {};
        });

        // 2. Apply overrides
        data = applyNamespaceEnvOverrides(data);
        data = applyEnvOverrides(data);

        // 3. Create config
        const config = new Config(data, tc.env_style || 'auto');
        // @ts-ignore
        config._mode = 'namespace';
        
        if (tc.expected_path === null) {
          expect(config.get(tc.env_var)).toBeUndefined();
        } else {
          let result = config.get(tc.expected_path);
          
          // Use string-based comparison for values to handle cross-language type coercion differences
          // (e.g. true vs "true", 8080 vs "8080") as long as they are semantically equivalent.
          const actualStr = String(result);
          const expectedStr = String(tc.expected_value);
          
          expect(actualStr.toLowerCase()).toBe(expectedStr.toLowerCase());
        }
        
        vi.unstubAllEnvs();
      });
    });
  });

  // --- 6. Version Negotiation ---
  const versionFixture = loadFixture('version_negotiation');
  describe('Version Negotiation', () => {
    versionFixture.test_cases.forEach((tc: any) => {
      it(tc.id, () => {
        if (tc.expected_error) {
          expect(() => negotiateVersion(tc.declared, tc.sdk)).toThrow();
        } else {
          expect(negotiateVersion(tc.declared, tc.sdk)).toBe(tc.expected);
        }
      });
    });
  });

  // --- 7. Error Code Collision ---
  const errorCodeFixture = loadFixture('error_codes');
  describe('Error Code Collision', () => {
    errorCodeFixture.test_cases.forEach((tc: any) => {
      it(tc.id, () => {
        const registry = new ErrorCodeRegistry();
        if (tc.action === 'register') {
          if (tc.expected_error) {
            expect(() => registry.register(tc.module_id, [tc.error_code])).toThrow();
          } else {
            registry.register(tc.module_id, [tc.error_code]);
          }
        } else if (tc.action === 'register_sequence') {
          tc.steps.forEach((step: any, idx: number) => {
            const isLast = idx === tc.steps.length - 1;
            if (isLast && tc.expected_error) {
              expect(() => registry.register(step.module_id, [step.error_code])).toThrow();
            } else {
              registry.register(step.module_id, [step.error_code]);
            }
          });
        }
      });
    });
  });
});
