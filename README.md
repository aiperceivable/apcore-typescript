<div align="center">
  <img src="https://raw.githubusercontent.com/aiperceivable/apcore/main/apcore-logo.svg" alt="apcore logo" width="200"/>
</div>

# apcore

**AI-Perceivable Core**

> **Build once, invoke by Code or AI.**

A schema-enforced module standard for the AI-Perceivable era.

apcore is an AI-Perceivable module standard that makes every interface naturally perceivable and understandable by AI through enforced Schema definitions and behavioral annotations. It provides schema validation, access control, middleware pipelines, and observability built in.

## Features

- **Schema-driven modules** — Define input/output schemas with TypeBox for runtime validation
- **Executor pipeline** — Secured execution lifecycle: context → safety checks → lookup → ACL → approval gate → validation → middleware before → execute → output validation → middleware after → return
- **Registry system** — File-based module discovery with metadata, dependencies, and topological ordering
- **Binding loader** — YAML-based module registration for no-code integration
- **Access control (ACL)** — Pattern-based rules with identity types, roles, and call-depth conditions
- **Approval system** — Pluggable approval gate in the executor pipeline with sync and async (polling) flows, built-in handlers, and tracing integration
- **Middleware** — Onion-model middleware with before/after/onError hooks and error recovery
- **Observability** — Tracing (spans + exporters), metrics (counters + histograms + Prometheus export), structured logging with redaction
- **Schema export** — JSON/YAML schema export with strict and compact modes
- **Caching & pagination annotations** — `cacheable`, `cacheTtl`, `cacheKeyFields` for result caching; `paginated`, `paginationStyle` for paginated modules
- **Config Bus** — Namespace-based configuration registry with typed access, env prefix dispatch, hot-reload, and external config mounting (`Config.registerNamespace()`, `config.namespace()`, `config.bind<T>()`, `config.mount()`)

## Documentation

For full documentation, including Quick Start guides and API reference, visit:
**[https://aiperceivable.github.io/apcore/getting-started.html](https://aiperceivable.github.io/apcore/getting-started.html)**

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

## API Overview

| Class | Description |
|-------|-------------|
| `APCore` | High-level client — register modules, call, stream, validate |
| `Registry` | Module storage — discover, register, get, list, watch |
| `Executor` | Execution engine — call with middleware pipeline, ACL, approval |
| `Context` | Request context — trace ID, identity, call chain, cancel token |
| `Config` | Configuration — load from YAML, namespace bus, get/set/bind values |
| `ACL` | Access control — rule-based caller/target authorization |
| `Middleware` | Pipeline hooks — before/after/onError interception |
| `EventEmitter` | Event system — subscribe, emit, flush |

## Configuration

### Config Bus

`Config` acts as an ecosystem-level Config Bus. Any package can register a namespace with optional JSON Schema validation, environment variable prefix, and defaults.

```typescript
import { Config } from 'apcore-js';

// Register a namespace (class-level, shared across all Config instances)
Config.registerNamespace('myPlugin', {
  envPrefix: 'MY_PLUGIN',
  defaults: { timeout: 5000, retries: 3 },
  schema: {
    type: 'object',
    properties: {
      timeout: { type: 'number' },
      retries: { type: 'number' },
    },
  },
});

const config = Config.load('apcore.yaml');

// Dot-path access with namespace resolution
const timeout = config.get('myPlugin.timeout');   // 5000 (or env override)

// Full namespace subtree
const pluginConfig = config.namespace('myPlugin');

// Typed access — pass a class constructor; its constructor receives the namespace dict
class MyPluginConfig {
  timeout: number;
  retries: number;
  constructor(data: Record<string, unknown>) {
    this.timeout = (data['timeout'] as number) ?? 5000;
    this.retries = (data['retries'] as number) ?? 3;
  }
}
const typed = config.bind('myPlugin', MyPluginConfig);

// Mount an external config source (e.g. an existing config file)
config.mount('myPlugin', { fromFile: './my-plugin.yaml' });
// Or from an in-memory object:
config.mount('myPlugin', { fromDict: { timeout: 10000 } });

// Introspect registered namespaces
const names = Config.registeredNamespaces(); // string[]
```

### Environment Variable Overrides

Merge priority (highest wins): **environment variables > config file > namespace defaults**.

Two prefix conventions are supported:

| Convention | Applies to | Example |
|------------|------------|---------|
| `APCORE_` + `KEY_PATH` (single `_` → `.`) | Legacy flat keys | `APCORE_EXECUTOR_DEFAULT_TIMEOUT=5000` |
| `APCORE__` + namespace prefix (double `__`) | apcore sub-package namespaces | `APCORE__OBSERVABILITY_TRACING_ENABLED=true` |

apcore pre-registers the following namespaces and env prefixes:

| Namespace | Env prefix | Wraps |
|-----------|-----------|-------|
| `observability` | `APCORE__OBSERVABILITY` | `apcore.observability.*` keys |
| `sysModules` | `APCORE__SYS` | `apcore.sys_modules.*` keys |

Third-party packages should use their own prefix (e.g. `APCORE__MCP` for apcore-mcp) to avoid collisions.

### Hot Reload

`config.reload()` re-reads the source YAML, re-detects legacy/namespace mode, re-applies all namespace defaults and env overrides, re-validates, and re-reads any mounted files.

```typescript
const config = Config.load('apcore.yaml');
// ... runtime config change on disk ...
config.reload(); // picks up all changes
```

### YAML File Format

Configuration files support two modes. **Legacy mode** (no `apcore:` key) is fully backward compatible. **Namespace mode** is activated when an `apcore:` top-level key is present; each namespace occupies its own top-level section. The `_config` reserved namespace controls validation behavior.

```yaml
# Namespace mode
apcore:
  version: "0.15.0"

_config:
  strict: true

observability:
  tracing:
    enabled: true
    samplingRate: 1.0

myPlugin:
  timeout: 10000
  retries: 5
```

### Error Codes

New error codes added in v0.15.0:

| Code | Description |
|------|-------------|
| `CONFIG_NAMESPACE_DUPLICATE` | `Config.registerNamespace()` called with an already-registered name |
| `CONFIG_NAMESPACE_RESERVED` | `Config.registerNamespace()` called with a reserved name (e.g. `_config`) |
| `CONFIG_ENV_PREFIX_CONFLICT` | Two namespaces declare the same `envPrefix` |
| `CONFIG_MOUNT_ERROR` | `config.mount()` cannot read or parse the external source |
| `CONFIG_BIND_ERROR` | `config.bind<T>()` or `config.getTyped<T>()` type guard fails |
| `ERROR_FORMATTER_DUPLICATE` | `ErrorFormatterRegistry.register()` called for an already-registered surface |

### Event Type Canonical Names

apcore 0.15.0 resolves two event-type collisions. Canonical dot-namespaced names should be used in new code; legacy short-form names remain emitted as aliases during the transition period.

| Legacy name (alias) | Canonical name | Meaning |
|---------------------|----------------|---------|
| `"module_health_changed"` | `"apcore.module.toggled"` | Module enabled/disabled toggle |
| `"module_health_changed"` | `"apcore.health.recovered"` | Error-rate recovery after spike |
| `"config_changed"` | `"apcore.config.updated"` | Config key updated at runtime |
| `"config_changed"` | `"apcore.module.reloaded"` | Module reloaded from disk |

Naming convention: `apcore.*` is reserved for core events. Adapter packages use their own prefix (`apcore-mcp.*`, `apcore-a2a.*`, `apcore-cli.*`).

---

## Examples

The `examples/` directory contains runnable demos:

---

### `simple-client` — APCore client with module registration and calls

Initializes an `APCore` client, registers modules inline, and calls them.

```typescript
import { Type } from '@sinclair/typebox';
import { APCore } from 'apcore-js';

const client = new APCore();

client.module({
  id: 'math.add',
  description: 'Add two integers',
  inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
  outputSchema: Type.Object({ sum: Type.Number() }),
  execute: (inputs) => ({ sum: (inputs.a as number) + (inputs.b as number) }),
});

client.module({
  id: 'greet',
  description: 'Greet a user by name',
  inputSchema: Type.Object({
    name: Type.String(),
    greeting: Type.Optional(Type.String()),
  }),
  outputSchema: Type.Object({ message: Type.String() }),
  execute: (inputs) => ({
    message: `${(inputs.greeting as string) || 'Hello'}, ${inputs.name}!`,
  }),
});

const result = await client.call('math.add', { a: 10, b: 5 });
console.log(result); // { sum: 15 }

const greetResult = await client.call('greet', { name: 'Alice' });
console.log(greetResult); // { message: 'Hello, Alice!' }
```

---

### `greet` — Minimal FunctionModule

Demonstrates the core `FunctionModule` structure with TypeBox schemas.

```typescript
import { Type } from '@sinclair/typebox';
import { FunctionModule } from 'apcore-js';

export const greetModule = new FunctionModule({
  moduleId: 'greet',
  description: 'Greet a user by name',
  inputSchema: Type.Object({ name: Type.String() }),
  outputSchema: Type.Object({ message: Type.String() }),
  execute: (inputs) => ({ message: `Hello, ${inputs.name}!` }),
});
```

---

### `get-user` — Readonly + idempotent annotations

Shows behavioral annotations and simulated database lookup.

```typescript
import { Type } from '@sinclair/typebox';
import { FunctionModule } from 'apcore-js';

const users: Record<string, { id: string; name: string; email: string }> = {
  'user-1': { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
  'user-2': { id: 'user-2', name: 'Bob', email: 'bob@example.com' },
};

export const getUserModule = new FunctionModule({
  moduleId: 'user.get',
  description: 'Get user details by ID',
  inputSchema: Type.Object({ userId: Type.String() }),
  outputSchema: Type.Object({
    id: Type.String(),
    name: Type.String(),
    email: Type.String(),
  }),
  annotations: {
    readonly: true,
    destructive: false,
    idempotent: true,
    requiresApproval: false,
    openWorld: true,
    streaming: false,
  },
  execute: (inputs) => {
    const user = users[inputs.userId as string];
    if (!user) {
      return { id: inputs.userId as string, name: 'Unknown', email: 'unknown@example.com' };
    }
    return { ...user };
  },
});
```

---

### `send-email` — Full-featured: annotations, examples, metadata, ContextLogger

Demonstrates destructive annotations, `ModuleExample` for AI-perceivable documentation, metadata, and `ContextLogger` usage.

```typescript
import { Type } from '@sinclair/typebox';
import { FunctionModule, ContextLogger } from 'apcore-js';
import type { Context } from 'apcore-js';

export const sendEmailModule = new FunctionModule({
  moduleId: 'email.send',
  description: 'Send an email message',
  inputSchema: Type.Object({
    to: Type.String(),
    subject: Type.String(),
    body: Type.String(),
    apiKey: Type.String(),
  }),
  outputSchema: Type.Object({
    status: Type.String(),
    messageId: Type.String(),
  }),
  tags: ['email', 'communication', 'external'],
  version: '1.2.0',
  metadata: { provider: 'example-smtp', maxRetries: 3 },
  annotations: {
    readonly: false,
    destructive: true,
    idempotent: false,
    requiresApproval: false,
    openWorld: true,
    streaming: false,
  },
  examples: [
    {
      title: 'Send a welcome email',
      inputs: { to: 'user@example.com', subject: 'Welcome!', body: '...', apiKey: 'sk-xxx' },
      output: { status: 'sent', messageId: 'msg-12345' },
      description: 'Sends a welcome email to a new user.',
    },
  ],
  execute: (inputs, context: Context) => {
    const logger = ContextLogger.fromContext(context, 'send_email');
    logger.info('Sending email', { to: inputs.to as string, subject: inputs.subject as string });
    const hash = Math.abs(
      (inputs.to as string).split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 100000,
    );
    const messageId = `msg-${String(hash).padStart(5, '0')}`;
    logger.info('Email sent successfully', { messageId });
    return { status: 'sent', messageId };
  },
});
```

---

### `decorated-add` — `module()` function for creating modules

```typescript
import { Type } from '@sinclair/typebox';
import { module } from 'apcore-js';

export const addModule = module({
  id: 'math.add',
  description: 'Add two integers',
  inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
  outputSchema: Type.Object({ sum: Type.Number() }),
  execute: (inputs) => ({ sum: (inputs.a as number) + (inputs.b as number) }),
});
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

## Links

- **Documentation:** [https://aiperceivable.github.io/apcore/getting-started.html](https://aiperceivable.github.io/apcore/getting-started.html)
- **Specification:** [https://github.com/aiperceivable/apcore](https://github.com/aiperceivable/apcore)
- **GitHub:** [https://github.com/aiperceivable/apcore-typescript](https://github.com/aiperceivable/apcore-typescript)
- **npm:** [https://www.npmjs.com/package/apcore-js](https://www.npmjs.com/package/apcore-js)
- **Issues:** [https://github.com/aiperceivable/apcore-typescript/issues](https://github.com/aiperceivable/apcore-typescript/issues)

## License

Apache-2.0
