<div align="center">
  <img src="https://raw.githubusercontent.com/aipartnerup/apcore-typescript/main/apcore-logo.svg" alt="apcore logo" width="200"/>
</div>

# apcore

**AI-Perceivable Core** — A schema-driven module development framework for TypeScript.

apcore provides a unified task orchestration framework with schema validation, access control, middleware pipelines, and observability built in.

## Features

- **Schema-driven modules** — Define input/output schemas with TypeBox for runtime validation
- **Executor pipeline** — 10-step execution pipeline: context → safety checks → lookup → ACL → validation → middleware before → execute → output validation → middleware after → return
- **Registry system** — File-based module discovery with metadata, dependencies, and topological ordering
- **Binding loader** — YAML-based module registration for no-code integration
- **Access control (ACL)** — Pattern-based rules with identity types, roles, and call-depth conditions
- **Approval system** — Pluggable approval gate in the executor pipeline with sync and async (polling) flows, built-in handlers, and tracing integration
- **Middleware** — Onion-model middleware with before/after/onError hooks and error recovery
- **Observability** — Tracing (spans + exporters), metrics (counters + histograms + Prometheus export), structured logging with redaction
- **Schema export** — JSON/YAML schema export with strict and compact modes

## Documentation

For full documentation, including Quick Start guides for both Python and TypeScript, visit:
**[https://aipartnerup.github.io/apcore/getting-started.html](https://aipartnerup.github.io/apcore/getting-started.html)**

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.5

## Installation

```bash
npm install apcore-js
```

## Quick Start

```typescript
import { Type } from '@sinclair/typebox';
import { FunctionModule, Registry, Executor } from 'apcore-js';

// Define a module
const greet = new FunctionModule({
  execute: (inputs) => ({ greeting: `Hello, ${inputs.name}!` }),
  moduleId: 'example.greet',
  inputSchema: Type.Object({ name: Type.String() }),
  outputSchema: Type.Object({ greeting: Type.String() }),
  description: 'Greet a user',
});

// Register and execute
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
  executor.ts           # 10-step execution pipeline
  context.ts            # Execution context and identity
  config.ts             # Dot-path configuration accessor
  acl.ts                # Access control with pattern matching
  approval.ts           # Pluggable approval gate (handlers, request/result types)
  async-task.ts         # Async task manager
  cancel.ts             # Cancellation token support
  decorator.ts          # FunctionModule class and helpers
  bindings.ts           # YAML binding loader
  errors.ts             # Error hierarchy (30+ typed errors)
  extensions.ts         # Extension manager
  module.ts             # Module types and annotations
  trace-context.ts     # W3C trace context (inject/extract)
  middleware/
    base.ts             # Middleware base class
    manager.ts          # MiddlewareManager (onion model)
    adapters.ts         # BeforeMiddleware, AfterMiddleware adapters
    logging.ts          # LoggingMiddleware
  registry/
    registry.ts         # Registry with discover() pipeline
    scanner.ts          # File-based module discovery
    entry-point.ts      # Dynamic import and entry point resolution
    metadata.ts         # YAML metadata and ID map loading
    dependencies.ts     # Topological sort with cycle detection
    validation.ts       # Module duck-type validation
    schema-export.ts    # Schema export (JSON/YAML, strict/compact)
    types.ts            # Registry type definitions
  schema/
    loader.ts           # JSON Schema to TypeBox conversion
    validator.ts        # Schema validation
    exporter.ts         # Schema serialization
    ref-resolver.ts     # $ref resolution
    strict.ts           # Strict schema transforms
    types.ts            # Schema type definitions
  observability/
    tracing.ts          # Span, SpanExporter, TracingMiddleware
    metrics.ts          # MetricsCollector, MetricsMiddleware
    context-logger.ts   # ContextLogger, ObsLoggingMiddleware
  utils/
    pattern.ts          # Glob-style pattern matching
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
