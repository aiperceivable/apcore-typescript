/**
 * Side-effect module: installs the Node-side YAML loader on `ACL.load`.
 *
 * Imported by the package's Node entry (`src/index.ts`). The browser
 * entry intentionally does NOT import this file — `ACL.load(...)` then
 * throws a clear runtime error directing the caller to construct ACL
 * programmatically.
 *
 * `node:fs` lives only on this leaf so the browser closure stays clean.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  ACL,
  _parseAclRule,
  _rejectInvalidDefaultEffect,
  _setAclFileLoader,
  _setAclDiscoverer,
} from './acl.js';
import type { AclConfigLike } from './acl.js';
import { getDefault } from './config-defaults.js';
import { ACLRuleError, ConfigNotFoundError } from './errors.js';

_setAclFileLoader((yamlPath: string): ACL => {
  if (!existsSync(yamlPath)) {
    throw new ConfigNotFoundError(yamlPath);
  }

  let data: unknown;
  try {
    const content = readFileSync(yamlPath, 'utf-8');
    data = yaml.load(content);
  } catch (e) {
    if (e instanceof ConfigNotFoundError) throw e;
    throw new ACLRuleError(`Invalid YAML in ${yamlPath}: ${e}`);
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ACLRuleError(`ACL config must be a mapping, got ${typeof data}`);
  }

  const dataObj = data as Record<string, unknown>;

  // §6.2.1 point 2 (v1.31.0, #112) — `default_effect` is judged FIRST, before
  // any rule. It is not a rule and has no index, so the rule ordering never
  // reaches it, and a file wrong in both was refused for its rule here and for
  // `default_effect` at the constructor door, because the rules were all parsed
  // on the way to it. The same function runs at both doors, so there is one
  // check and one message.
  //
  // `?? 'deny'` alone would coerce an ABSENT key and an explicit
  // `default_effect: null` to the same fallback — `??` treats a `null` read
  // off the object identically to an `undefined` one, so it cannot tell
  // "key absent" from "key present with value null" apart. Only the absent
  // case is a real default; an explicit `null` is a value the operator
  // wrote, and `schemas/acl-config.schema.json` declares `default_effect` as a
  // plain string enum, not nullable, so it is exactly as invalid as `"block"`
  // and must reach `_rejectInvalidDefaultEffect` unchanged rather than being
  // silently normalized away before that check ever sees it.
  const hasDefaultEffectKey = 'default_effect' in dataObj;
  const defaultEffect = hasDefaultEffectKey ? (dataObj['default_effect'] as string) : 'deny';
  _rejectInvalidDefaultEffect(defaultEffect);

  if (!('rules' in dataObj)) {
    throw new ACLRuleError("ACL config missing required 'rules' key");
  }

  const rawRules = dataObj['rules'];
  if (!Array.isArray(rawRules)) {
    throw new ACLRuleError(`'rules' must be a list, got ${typeof rawRules}`);
  }

  // One pass, in file order, and every per-rule check lives inside
  // `_parseAclRule` — the rule-key closure (#107) included, which is a
  // loader-only axis and therefore exactly the kind §6.2.1 point 2's sweep
  // prohibition binds. Sweeping any one of them across the file first would
  // refuse a later rule for a fault a lower-indexed rule already had.
  const rules = rawRules.map((raw, i) => _parseAclRule(raw, i));

  const acl = new ACL(rules, defaultEffect);
  acl._setYamlPath(yamlPath);
  return acl;
});

// ---------------------------------------------------------------------------
// Config-driven ACL discovery (D-64, Recommendation A — issue #74)
// ---------------------------------------------------------------------------

_setAclDiscoverer((config: AclConfigLike): ACL | null => {
  // Read `acl.root`, falling back to the canonical default ("./acl").
  const rawRoot = config.get('acl.root', getDefault('acl.root'));
  if (rawRoot === null || rawRoot === undefined) {
    return null;
  }

  let rootPath = String(rawRoot);
  if (!isAbsolute(rootPath)) {
    // Anchor a relative root at the config file's directory when known,
    // otherwise at the process CWD. Parity with apcore-python
    // (Config.source_path) and apcore-rust (D-64).
    const sourcePath = config.sourcePath;
    const base = sourcePath !== null ? dirname(resolve(sourcePath)) : process.cwd();
    rootPath = resolve(base, rootPath);
  }

  // Missing path => no enforcement. CRITICAL: do NOT synthesize an empty
  // default-deny ACL — that would silently deny every inter-module call in
  // every project lacking an acl file. `acl.default_effect` only applies once
  // a real ACL file is loaded (read by ACL.load from the file itself).
  if (!existsSync(rootPath)) {
    return null;
  }

  // acl.root is a directory by convention (the default "./acl"): load the
  // conventional `<root>/global_acl.yaml` (PROTOCOL_SPEC §3.1 `acl/{scope}_acl.yaml`).
  // A directory without that file is a no-op. acl.root MAY also point directly
  // at a YAML file. Parity with apcore-python and apcore-rust.
  if (statSync(rootPath).isDirectory()) {
    const globalAcl = join(rootPath, 'global_acl.yaml');
    if (!existsSync(globalAcl)) {
      return null;
    }
    return ACL.load(globalAcl);
  }

  return ACL.load(rootPath);
});
