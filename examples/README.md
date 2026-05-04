# apcore-typescript — Examples

Runnable demos for the TypeScript SDK. Each top-level file is standalone — no setup beyond `pnpm install` (or `npm install`) at the repo root.

## Quick start

```bash
# From the apcore-typescript repo root
node examples/simple-client.ts
```

> **Node version:** these examples use top-level `await` and import a `.ts` file directly via Node's native TypeScript support (Node 22.6+ with `--experimental-strip-types`, or Node 23+ where it's the default). On older Node, use `npx tsx examples/<file>.ts`.

## All examples

| File | What it demonstrates | Run |
|---|---|---|
| [`simple-client.ts`](simple-client.ts) | Minimal `new APCore()` client with `client.module(...)` and `await client.call(...)`. | `node examples/simple-client.ts` |
| [`global-client.ts`](global-client.ts) | Module-level client pattern — minimal boilerplate. | `node examples/global-client.ts` |
| [`cancel-token.ts`](cancel-token.ts) | Cooperative cancellation: cancel a long-running module via `CancelToken`. | `node examples/cancel-token.ts` |
| [`pipeline-demo.ts`](pipeline-demo.ts) | The 11-step `ExecutionStrategy` pipeline — introspection, step-middleware tracing, and orchestration via `insertAfter` / `replace`. See note below. | `node examples/pipeline-demo.ts` |

### Module reference files

The files under [`modules/`](modules/) are reusable module definitions, not standalone scripts.

| File | Pattern shown |
|---|---|
| [`modules/greet.ts`](modules/greet.ts) | Minimal module with TypeBox schemas. |
| [`modules/decorated-add.ts`](modules/decorated-add.ts) | The `@module` decorator. |
| [`modules/get-user.ts`](modules/get-user.ts) | Read-only module annotation. |
| [`modules/send-email.ts`](modules/send-email.ts) | Full-featured module: `ModuleAnnotations`, `ModuleExample`, sensitive-field redaction, `ContextLogger`. |

### Bindings

The [`bindings/format-date/`](bindings/format-date/) directory shows the YAML-binding pattern:

| File | Role |
|---|---|
| [`bindings/format-date/binding.yaml`](bindings/format-date/binding.yaml) | Canonical binding definition. |
| [`bindings/format-date/format-date.ts`](bindings/format-date/format-date.ts) | Target function loaded by the binding. |

Loading and invoking a binding from your own script: see `BindingLoader` usage in the SDK README's "Bindings" section.

## Pipeline demo — what to look for

`pipeline-demo.ts` is the deep-dive into the engine. One run prints three sections:

1. **Introspection** — the canonical 11 step names from `strategy.stepNames()` / `strategy.info()`.
2. **Middleware tracing** — a `StepMiddleware` that narrates every step of one call:
   ```
   [ 1/11] context_creation    — create execution context, set global deadline
           ✓   0.15 ms · caller=anonymous trace_id=…
   ...
   [11/11] return_result       — finalize and return output
           ✓   0.03 ms · returning {…}
   ```
3. **Orchestration** — `strategy.insertAfter("output_validation", auditLogStep)` adds a 12th step (rendered as `[  +  ]` to mark it as user-inserted), then `strategy.replace("audit_log", quietAuditLogStep)` swaps the implementation while keeping the position.

The `[N/11]` numbering stays pinned to the protocol's 11 standard steps; custom steps appear as `[  +  ]`. This makes the "11 standard + N custom" composition unmistakable in the trace output.
