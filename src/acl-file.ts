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
import yaml from 'js-yaml';
import { ACL, _parseAclRule, _setAclFileLoader } from './acl.js';
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
