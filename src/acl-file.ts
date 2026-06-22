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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import yaml from 'js-yaml';
import { ACL, _parseAclRule, _setAclFileLoader, _setAclDiscoverer } from './acl.js';
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
  if (!('rules' in dataObj)) {
    throw new ACLRuleError("ACL config missing required 'rules' key");
  }

  const rawRules = dataObj['rules'];
  if (!Array.isArray(rawRules)) {
    throw new ACLRuleError(`'rules' must be a list, got ${typeof rawRules}`);
  }

  const defaultEffect = (dataObj['default_effect'] as string) ?? 'deny';
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

  return ACL.load(rootPath);
});
