/**
 * Default configuration values, runtime-neutral.
 *
 * These constants and the `getDefault` helper are pure data and have no
 * dependency on `node:*` builtins. They are intentionally factored out of
 * `config.ts` so that browser-side consumers (e.g. the in-browser apcore-js
 * runtime used by apwebsite) can import the runtime classes (Registry,
 * Executor, APCore) without dragging the filesystem-loading code in
 * `config.ts` into the bundle.
 *
 * The full Node-side `Config` API and `discoverConfigFile` live in
 * `./config.ts` and re-export `DEFAULTS` / `getDefault` from here so
 * existing `import { getDefault } from './config.js'` paths keep working.
 */

/**
 * Default configuration values for legacy mode.
 *
 * NOTE: `version` is the frozen baseline for legacy-mode configs (those that
 * omit an explicit `version` field). It identifies the spec version whose
 * semantics legacy mode parses against, NOT the current SDK version. Do not
 * bump this with each spec MINOR — only when legacy-mode parsing semantics
 * actually change.
 */
export const DEFAULTS: Record<string, unknown> = {
  version: '0.16.0',
  extensions: {
    root: './extensions',
    auto_discover: true,
    max_depth: 8,
    follow_symlinks: false,
  },
  schema: {
    root: './schemas',
    strategy: 'yaml_first',
    max_ref_depth: 32,
  },
  acl: {
    root: './acl',
    default_effect: 'deny',
  },
  executor: {
    default_timeout: 30000,
    global_timeout: 60000,
    max_call_depth: 32,
    max_module_repeat: 3,
  },
  observability: {
    tracing: {
      enabled: false,
      sampling_rate: 1.0,
    },
    metrics: {
      enabled: false,
    },
  },
  project: {
    name: 'apcore',
  },
  sys_modules: {
    enabled: false,
  },
  stream: {
    max_merge_depth: 32,
  },
};

/**
 * Single source of truth for default values.
 * Components MUST use this instead of hardcoding defaults.
 */
export function getDefault(key: string, fallback?: unknown): unknown {
  const parts = key.split('.');
  let node: unknown = DEFAULTS;
  for (const part of parts) {
    if (node != null && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return fallback;
    }
  }
  return node;
}
