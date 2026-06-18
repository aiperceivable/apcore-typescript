/**
 * Execution context, identity, and context creation.
 */

import { v4 as uuidv4 } from 'uuid';
import type { CancelToken } from './cancel.js';
import { ContextBindingError } from './errors.js';
import { ContextLogger } from './observability/context-logger.js';
import type { TraceParent } from './trace-context.js';

export class Identity {
  readonly id: string;
  readonly type: string;
  readonly roles: readonly string[];
  readonly attrs: Readonly<Record<string, unknown>>;

  constructor(
    id: string,
    type: string = 'user',
    roles: string[] = [],
    attrs: Record<string, unknown> = {},
  ) {
    this.id = id;
    this.type = type;
    this.roles = Object.freeze([...roles]);
    this.attrs = Object.freeze({ ...attrs });
    Object.freeze(this);
  }

  /**
   * Get an attribute value by key.
   *
   * Aligned with apcore D-03. May trigger a fetch if the identity
   * is lazy-loaded (future extension).
   */
  getAttr<T = unknown>(key: string, defaultValue?: T): T | undefined {
    // Presence check so a stored `null` is returned as null rather than
    // coalesced to the default (Python/Rust parity: `attrs.get(key, default)`).
    return key in this.attrs ? (this.attrs[key] as T) : defaultValue;
  }
}

export function createIdentity(
  id: string,
  type: string = 'user',
  roles: string[] = [],
  attrs: Record<string, unknown> = {},
): Identity {
  return new Identity(id, type, roles, attrs);
}

export class Context<T = null> {
  readonly traceId: string;
  readonly callerId: string | null;
  readonly callChain: readonly string[];
  readonly executor: unknown;
  readonly identity: Identity | null;
  redactedInputs: Record<string, unknown> | null;
  redactedOutput: Record<string, unknown> | null;
  readonly data: Record<string, unknown>;
  readonly services: T;
  readonly cancelToken: CancelToken | null;
  readonly globalDeadline: number | null;
  private _logger: ContextLogger | null = null;

  /**
   * Never-aborted fallback signal returned when no `cancelToken` is bound.
   * Modules can safely attach this signal to Web APIs (`fetch`, etc.) and
   * rely on it never firing in the no-cancel case. Lazy-created on first
   * read so contexts without cancel support pay no AbortController cost.
   * (D-18, apcore v0.22.0)
   */
  private static _NEVER_SIGNAL: AbortSignal | null = null;

  constructor(
    traceId: string,
    callerId: string | null = null,
    callChain: string[] = [],
    executor: unknown = null,
    identity: Identity | null = null,
    redactedInputs: Record<string, unknown> | null = null,
    data: Record<string, unknown> = {},
    cancelToken: CancelToken | null = null,
    services: T = null as T,
    globalDeadline: number | null = null,
    redactedOutput: Record<string, unknown> | null = null,
  ) {
    this.traceId = traceId;
    this.callerId = callerId;
    this.callChain = Object.freeze([...callChain]);
    this.executor = executor;
    this.identity = identity;
    this.redactedInputs = redactedInputs;
    this.redactedOutput = redactedOutput;
    this.data = data;
    this.services = services;
    this.cancelToken = cancelToken;
    this.globalDeadline = globalDeadline;
  }

  /**
   * Create a new top-level Context with a generated 32-char hex traceId.
   *
   * Per apcore Issue #66 / v0.22.0, the public input list is unified across
   * SDKs to: `identity`, `traceParent`, `cancelToken`, `data`, `services`,
   * `globalDeadline`. `executor` and `callerId` are NOT accepted as inputs:
   *   - `executor` is bound to the Context by the Executor on first call()
   *     (see {@link withExecutor}); top-level Contexts created locally
   *     therefore have `executor === null` until the Executor binds itself.
   *   - `callerId` is managed exclusively by {@link child}; top-level
   *     Contexts always have `callerId === null`.
   *
   * When `traceParent` is provided, its `traceId` is accepted only if it is
   * exactly 32 lowercase hex characters and not the W3C-reserved all-zero
   * or all-f value. Otherwise a fresh traceId is generated and a warning
   * is logged. No normalization (dashed UUID stripping, case folding) is
   * performed here; such normalization is the responsibility of the
   * TraceParent header parser or the caller's ContextFactory.
   */
  static create<S = null>(
    identity: Identity | null = null,
    traceParent: TraceParent | null = null,
    cancelToken: CancelToken | null = null,
    data?: Record<string, unknown>,
    services?: S,
    globalDeadline?: number | null,
  ): Context<S> {
    let traceId: string;
    if (traceParent) {
      const h = traceParent.traceId;
      const isValidHex = /^[0-9a-f]{32}$/.test(h);
      const isW3cValid = h !== '0'.repeat(32) && h !== 'f'.repeat(32);
      if (isValidHex && isW3cValid) {
        traceId = h;
      } else {
        console.warn(
          `[apcore] Invalid trace_id format in trace_parent: ${JSON.stringify(h)}. Restarting trace.`,
        );
        traceId = uuidv4().replace(/-/g, '');
      }
    } else {
      traceId = uuidv4().replace(/-/g, '');
    }
    // D11-002a: Carry the inbound W3C trace_flags and tracestate through the
    // request lifecycle so downstream TraceContext.inject() can propagate the
    // inbound sampling decision and vendor state instead of defaulting to "01"
    // and dropping tracestate. Mirrors apcore-python context.py: the parsed
    // flags+tracestate are stored under two scalar keys so the in-memory shape
    // matches across languages.
    const ctxData: Record<string, unknown> = data ?? {};
    if (traceParent != null) {
      const flags = traceParent.traceFlags;
      if (typeof flags === 'string' && flags.length === 2 && !('_apcore.trace.flags' in ctxData)) {
        ctxData['_apcore.trace.flags'] = flags;
      }
      const tracestate = traceParent.tracestate;
      if (Array.isArray(tracestate) && tracestate.length > 0 && !('_apcore.trace.state' in ctxData)) {
        ctxData['_apcore.trace.state'] = tracestate;
      }
    }
    return new Context<S>(
      traceId,
      null,
      [],
      null,
      identity,
      null,
      ctxData,
      cancelToken,
      services ?? (null as S),
      globalDeadline ?? null,
    );
  }

  /**
   * Contract member. Bind the Executor to this Context (copy-on-write). Not for
   * application code. Implements apcore spec §"Contract: Executor binding to
   * Context".
   *
   * Idempotent for the same Executor instance — returns `this` unchanged.
   * Throws {@link ContextBindingError} if the Context is already bound to a
   * different Executor (cross-executor rebind is a programming error).
   */
  withExecutor(executor: unknown): Context<T> {
    if (this.executor === executor) return this;
    if (this.executor != null) {
      throw new ContextBindingError(
        'Context already bound to a different Executor instance',
      );
    }
    return new Context<T>(
      this.traceId,
      this.callerId,
      [...this.callChain],
      executor,
      this.identity,
      this.redactedInputs,
      this.data,
      this.cancelToken,
      this.services,
      this.globalDeadline,
      this.redactedOutput,
    );
  }

  /** @deprecated Use {@link withExecutor}. Retained for older callers; will be removed in a future major. */
  _withExecutor(executor: unknown): Context<T> {
    return this.withExecutor(executor);
  }

  /**
   * @internal SDK-only. Returns a new Context with `cancelToken` bound.
   *
   * Idempotent for the same token instance — returns `this` unchanged.
   * Throws {@link ContextBindingError} if the Context is already bound to a
   * different CancelToken.
   */
  // TODO(api-surface): classify vs api-surface-conventions §6.1
  _withCancelToken(cancelToken: CancelToken): Context<T> {
    if (this.cancelToken === cancelToken) return this;
    if (this.cancelToken != null) {
      throw new ContextBindingError(
        'Context already bound to a different CancelToken',
      );
    }
    return new Context<T>(
      this.traceId,
      this.callerId,
      [...this.callChain],
      this.executor,
      this.identity,
      this.redactedInputs,
      this.data,
      cancelToken,
      this.services,
      this.globalDeadline,
      this.redactedOutput,
    );
  }

  /**
   * Serialize Context to a plain object suitable for JSON encoding.
   *
   * Includes `_context_version: 1` at top level.
   * Uses snake_case keys for cross-language consistency.
   * Excludes: executor, services, cancelToken, globalDeadline.
   * Filters `_`-prefixed keys from data.
   *
   * @deprecated Prefer {@link toJSON}. `serialize` will be removed in 1.0.0; use `toJSON` (picked up automatically by
   *   JSON.stringify) or call `toJSON()` directly.
   */
  serialize(): Record<string, unknown> {
    return this.toJSON();
  }

  /**
   * Deserialize a plain object (from JSON) into a Context.
   *
   * Non-serializable fields (executor, services, cancelToken,
   * globalDeadline) are set to null after deserialization.
   * If `_context_version` is greater than 1, a warning is logged
   * but deserialization proceeds (forward compatibility).
   *
   * @deprecated Prefer {@link fromJSON}. `deserialize` will be removed in 1.0.0.
   */
  static deserialize(data: Record<string, unknown>): Context {
    const version = (data._context_version as number) ?? 1;
    if (version > 1) {
      console.warn(
        `[apcore:context] Unknown _context_version ${version} (expected 1). ` +
          'Proceeding with best-effort deserialization.',
      );
    }

    const identityData =
      data.identity != null && typeof data.identity === 'object' && !Array.isArray(data.identity)
        ? (data.identity as Record<string, unknown>)
        : null;
    const identity = identityData
      ? createIdentity(
          typeof identityData.id === 'string' ? identityData.id : String(identityData.id ?? ''),
          typeof identityData.type === 'string' ? identityData.type : 'user',
          Array.isArray(identityData.roles)
            ? identityData.roles.filter((r): r is string => typeof r === 'string')
            : [],
          identityData.attrs != null && typeof identityData.attrs === 'object' && !Array.isArray(identityData.attrs)
            ? (identityData.attrs as Record<string, unknown>)
            : {},
        )
      : null;

    return new Context(
      typeof data.trace_id === 'string' ? data.trace_id : '',
      typeof data.caller_id === 'string' ? data.caller_id : null,
      Array.isArray(data.call_chain) ? data.call_chain.filter((s): s is string => typeof s === 'string') : [],
      null, // executor
      identity,
      (data.redacted_inputs as Record<string, unknown>) ?? null,
      data.data ? { ...(data.data as Record<string, unknown>) } : {},
      null, // cancelToken
      null as never, // services
      null, // globalDeadline
      (data.redacted_output as Record<string, unknown>) ?? null,
    );
  }

  /**
   * Canonical JSON encoding used by JSON.stringify(context). Produces the
   * snake_case wire format documented on {@link serialize}.
   */
  toJSON(): Record<string, unknown> {
    // Inline the serialization so `serialize()` becomes the deprecated alias,
    // not the canonical implementation.
    const filteredData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (!key.startsWith('_')) {
        filteredData[key] = value;
      }
    }
    const result: Record<string, unknown> = {
      _context_version: 1,
      trace_id: this.traceId,
      caller_id: this.callerId,
      call_chain: [...this.callChain],
      identity: this.identity
        ? {
            id: this.identity.id,
            type: this.identity.type,
            roles: [...this.identity.roles],
            attrs: { ...this.identity.attrs },
          }
        : null,
      data: filteredData,
    };
    if (this.redactedInputs !== undefined && this.redactedInputs !== null) {
      result.redacted_inputs = { ...this.redactedInputs };
    }
    if (this.redactedOutput !== undefined && this.redactedOutput !== null) {
      result.redacted_output = { ...this.redactedOutput };
    }
    return result;
  }

  /**
   * Canonical construction from the JSON-decoded wire format.
   */
  static fromJSON(data: Record<string, unknown>): Context {
    return this.deserialize(data);
  }

  /**
   * The cancel token's `AbortSignal` if a token is bound, else a never-aborted
   * fallback. Modules using standard Web-API I/O (`fetch`, `setTimeout` via
   * `AbortSignal.timeout`, Web Streams) should attach this signal so they
   * participate in real cancellation when callers invoke `cancelToken.cancel()`
   * or `AsyncTaskManager.cancel()` (D-18, apcore v0.22.0).
   */
  get signal(): AbortSignal {
    if (this.cancelToken !== null) {
      return this.cancelToken.signal;
    }
    if (Context._NEVER_SIGNAL === null) {
      Context._NEVER_SIGNAL = new AbortController().signal;
    }
    return Context._NEVER_SIGNAL;
  }

  /**
   * Lazily-built, cached ContextLogger for this Context. Reuses the same
   * instance on subsequent accesses so middleware that logs repeatedly does
   * not allocate a new logger per call.
   */
  get logger(): ContextLogger {
    if (this._logger === null) {
      this._logger = ContextLogger.fromContext(this, this.callerId ?? 'unknown');
    }
    return this._logger;
  }

  /**
   * Create a child Context for a downstream module call.
   *
   * **Invariant — `data` is shared by reference.** The child inherits the
   * parent's `data` map; writes in the child propagate to the parent and to
   * every sibling child built from the same parent. This is intentional: it
   * lets middleware state (retry counters, tracing spans) flow across the
   * call chain within a single trace. Do NOT rely on sibling isolation.
   *
   * Everything else (`redactedInputs`, etc.) is per-call.
   */
  child(targetModuleId: string): Context<T> {
    return new Context<T>(
      this.traceId,
      this.callChain.length > 0 ? this.callChain[this.callChain.length - 1] : null,
      [...this.callChain, targetModuleId],
      this.executor,
      this.identity,
      null,
      this.data, // shared reference — see JSDoc above
      this.cancelToken,
      this.services,
      this.globalDeadline,
    );
  }
}

/**
 * Interface for creating Context from runtime-specific requests.
 *
 * Web framework integrations should implement this to extract Identity
 * from HTTP requests (e.g., Express request, JWT tokens, API keys).
 */
export interface ContextFactory {
  createContext(request: unknown): Context;
}
