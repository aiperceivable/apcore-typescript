/**
 * Side-effect module: best-effort synchronous load of `@opentelemetry/api`
 * via `createRequire`, installed as the default tracer factory on
 * `TracingMiddleware`.
 *
 * Imported by the package's Node entry (`src/index.ts`). The browser
 * entry never imports this file, which keeps the static `node:module`
 * import (and the `createRequire` / `import.meta.url` resolution) out
 * of the browser closure.
 *
 * If `@opentelemetry/api` is not installed at runtime, the loader
 * silently falls back to `null` and `TracingMiddleware` becomes a no-op
 * unless a tracer is explicitly injected via constructor options.
 */

import { createRequire } from 'node:module';
import type { OtelTracer } from './tracing.js';
import { _setDefaultTrace } from './tracing.js';

const _nodeRequire = createRequire(import.meta.url);
try {
  const otel = _nodeRequire('@opentelemetry/api') as {
    trace: { getTracer(n: string): OtelTracer };
  };
  _setDefaultTrace(otel.trace);
} catch {
  _setDefaultTrace(null);
}
