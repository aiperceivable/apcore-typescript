<div align="center">
  <img src="https://raw.githubusercontent.com/aipartnerup/apcore/main/apcore-logo.svg" alt="apcore logo" width="200"/>
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

## API Overview

| Class | Description |
|-------|-------------|
| `APCore` | High-level client — register modules, call, stream, validate |
| `Registry` | Module storage — discover, register, get, list, watch |
| `Executor` | Execution engine — call with middleware pipeline, ACL, approval |
| `Context` | Request context — trace ID, identity, call chain, cancel token |
| `Config` | Configuration — load from YAML, get/set values |
| `ACL` | Access control — rule-based caller/target authorization |
| `Middleware` | Pipeline hooks — before/after/onError interception |
| `EventEmitter` | Event system — subscribe, emit, flush |

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

- **Documentation:** [https://aipartnerup.github.io/apcore/getting-started.html](https://aipartnerup.github.io/apcore/getting-started.html)
- **Specification:** [https://github.com/aipartnerup/apcore](https://github.com/aipartnerup/apcore)
- **GitHub:** [https://github.com/aipartnerup/apcore-typescript](https://github.com/aipartnerup/apcore-typescript)
- **npm:** [https://www.npmjs.com/package/apcore-js](https://www.npmjs.com/package/apcore-js)
- **Issues:** [https://github.com/aipartnerup/apcore-typescript/issues](https://github.com/aipartnerup/apcore-typescript/issues)

## License

Apache-2.0
