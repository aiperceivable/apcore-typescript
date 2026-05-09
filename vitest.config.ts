import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Side-effect setup: wire Node-only file readers onto the
    // browser-safe runtime modules (ACL.load, registerSysModules, the
    // OTel auto-detector, the sys-modules overrides loader). Tests that
    // import individual source files directly (e.g. `from '../src/acl.js'`)
    // bypass the package's Node entry, so we install them here instead.
    setupFiles: ['./tests/setup-node-installers.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
