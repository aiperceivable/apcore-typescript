<div align="center">
  <img src="https://raw.githubusercontent.com/aipartnerup/apcore/main/apcore-logo.svg" alt="apcore logo" width="200"/>
</div>

# apcore

**AI-Perceivable Core** — A schema-driven module development framework for TypeScript.

apcore provides a unified task orchestration framework with schema validation, access control, middleware pipelines, and observability built in.

## Features

- **Schema-driven modules** — Define input/output schemas with TypeBox for runtime validation
- **Executor pipeline** — 11-step execution pipeline: context → safety checks → lookup → ACL → approval gate → validation → middleware before → execute → output validation → middleware after → return
- **Registry system** — File-based module discovery with metadata, dependencies, and topological ordering
- **Binding loader** — YAML-based module registration for no-code integration
- **Access control (ACL)** — Pattern-based rules with identity types, roles, and call-depth conditions
- **Approval system** — Pluggable approval gate in the executor pipeline with sync and async (polling) flows, built-in handlers, and tracing integration
- **Middleware** — Onion-model middleware with before/after/onError hooks and error recovery
- **Observability** — Tracing (spans + exporters), metrics (counters + histograms + Prometheus export), structured logging with redaction
- **Schema export** — JSON/YAML schema export with strict and compact modes

## Documentation

For full documentation, including Quick Start guides and API reference, visit:
**[https://aipartnerup.github.io/apcore/getting-started.html](https://aipartnerup.github.io/apcore/getting-started.html)**

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.5

## Installation

```bash
npm install apcore-js
```

## Quick Start

### Simplified Client (Recommended)

The `APCore` client provides a unified entry point that manages Registry and Executor for you:

```typescript
import { Type } from '@sinclair/typebox';
import { APCore } from 'apcore-js';

const client = new APCore();

// Register a module
client.module({
  id: 'math.add',
  description: 'Add two numbers',
  inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
  outputSchema: Type.Object({ sum: Type.Number() }),
  execute: (inputs) => ({ sum: (inputs.a as number) + (inputs.b as number) }),
});

// Call, validate, stream — all from one client
const result = await client.call('math.add', { a: 10, b: 5 });
// => { sum: 15 }

const preflight = client.validate('math.add', { a: 10, b: 5 });
// => { valid: true, checks: [...], requiresApproval: false, errors: [] }
```

### Advanced: Manual Registry + Executor

```typescript
import { Type } from '@sinclair/typebox';
import { FunctionModule, Registry, Executor } from 'apcore-js';

const greet = new FunctionModule({
  execute: (inputs) => ({ greeting: `Hello, ${inputs.name}!` }),
  moduleId: 'example.greet',
  inputSchema: Type.Object({ name: Type.String() }),
  outputSchema: Type.Object({ greeting: Type.String() }),
  description: 'Greet a user',
});

const registry = new Registry();
registry.register('example.greet', greet);

const executor = new Executor({ registry });
const result = await executor.call('example.greet', { name: 'World' });
// => { greeting: 'Hello, World!' }
```

## Architecture

```
src/
  index.ts              # Public API exports
  client.ts             # High-level APCore client (unified entry point)
  executor.ts           # 11-step execution pipeline
  context.ts            # Execution context and identity
  config.ts             # Dot-path configuration accessor
  acl.ts                # Access control with pattern matching
  approval.ts           # Pluggable approval gate (handlers, request/result types)
  async-task.ts         # Async task manager
  cancel.ts             # Cancellation token support
  decorator.ts          # FunctionModule class and helpers
  bindings.ts           # YAML binding loader
  errors.ts             # Error hierarchy (35 typed errors)
  error-code-registry.ts # Custom error code registration with collision detection
  extensions.ts         # Extension manager
  module.ts             # Module types and annotations
  trace-context.ts      # W3C trace context (inject/extract)
  version.ts            # Version negotiation (semver parsing)
  events/
    index.ts            # Event module barrel exports
    emitter.ts          # Global event bus with fan-out delivery
    subscribers.ts      # Webhook and A2A protocol event subscribers
  middleware/
    index.ts            # Middleware barrel exports
    base.ts             # Middleware base class
    manager.ts          # MiddlewareManager (onion model)
    adapters.ts         # BeforeMiddleware, AfterMiddleware adapters
    logging.ts          # LoggingMiddleware
    retry.ts            # RetryMiddleware for automatic retry of retryable errors
    error-history.ts    # Middleware that records errors into ErrorHistory
    platform-notify.ts  # Threshold sensor with hysteresis for error/latency alerts
  registry/
    index.ts            # Registry barrel exports
    registry.ts         # Registry with discover() pipeline
    scanner.ts          # File-based module discovery
    entry-point.ts      # Dynamic import and entry point resolution
    metadata.ts         # YAML metadata and ID map loading
    dependencies.ts     # Topological sort with cycle detection
    validation.ts       # Module duck-type validation
    schema-export.ts    # Schema export (JSON/YAML, strict/compact)
    types.ts            # Registry type definitions
  schema/
    index.ts            # Schema barrel exports
    loader.ts           # JSON Schema to TypeBox conversion
    validator.ts        # Schema validation
    exporter.ts         # Schema serialization
    ref-resolver.ts     # $ref resolution
    strict.ts           # Strict schema transforms
    types.ts            # Schema type definitions
    annotations.ts      # Annotation conflict resolution (YAML + code metadata)
  observability/
    index.ts            # Observability barrel exports
    tracing.ts          # Span, SpanExporter, TracingMiddleware
    metrics.ts          # MetricsCollector, MetricsMiddleware
    metrics-utils.ts    # Shared metric extraction utilities
    context-logger.ts   # ContextLogger, ObsLoggingMiddleware
    usage.ts            # Time-windowed usage tracking with analytics
    error-history.ts    # Error history with ring-buffer eviction and dedup
  sys-modules/
    index.ts            # System module barrel exports
    registration.ts     # Auto-registration of sys.* modules and middleware
    control.ts          # Runtime config update and hot-reload modules
    health.ts           # System and per-module health modules
    manifest.ts         # Module metadata and system manifest modules
    toggle.ts           # Module disable/enable without unloading
    usage.ts            # Usage summary and per-module usage detail modules
  utils/
    index.ts            # Utils barrel exports
    pattern.ts          # Glob-style pattern matching
    call-chain.ts       # Call chain safety guard (depth, frequency, cycles)
    error-propagation.ts # Standardized error wrapping
    normalize.ts        # Cross-language module ID normalization
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build
npm run build
```

## Testing

- Core executor pipeline
- Schema validation (strict mode, type coercion)
- Middleware chain (ordering, transforms, error recovery)
- ACL enforcement (patterns, conditions, identity types)
- Registry system (scanner, metadata, entry points, dependencies)
- Binding loader (YAML loading, target resolution, schema modes)
- Observability (tracing, metrics, structured logging)
- Integration tests (end-to-end flows, error propagation, safety checks)

## License

Apache-2.0
