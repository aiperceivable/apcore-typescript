/**
 * Execution context, identity, and context creation.
 */

import { v4 as uuidv4 } from 'uuid';
import type { CancelToken } from './cancel.js';
import { ContextLogger } from './observability/context-logger.js';
import type { TraceParent } from './trace-context.js';

export interface Identity {
  readonly id: string;
  readonly type: string;
  readonly roles: readonly string[];
  readonly attrs: Readonly<Record<string, unknown>>;
}

export function createIdentity(
  id: string,
  type: string = 'user',
  roles: string[] = [],
  attrs: Record<string, unknown> = {},
): Identity {
  return Object.freeze({
    id,
    type,
    roles: Object.freeze([...roles]),
    attrs: Object.freeze({ ...attrs }),
  });
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
  ) {
    this.traceId = traceId;
    this.callerId = callerId;
    this.callChain = Object.freeze([...callChain]);
    this.executor = executor;
    this.identity = identity;
    this.redactedInputs = redactedInputs;
    this.redactedOutput = null;
    this.data = data;
    this.services = services;
    this.cancelToken = cancelToken;
    this.globalDeadline = globalDeadline;
  }

  /**
   * Create a new top-level Context with a generated 32-char hex traceId.
   *
   * When `traceParent` is provided, its `traceId` is accepted only if it is
   * exactly 32 lowercase hex characters and not the W3C-reserved all-zero
   * or all-f value. Otherwise a fresh traceId is generated and a warning
   * is logged. No normalization (dashed UUID stripping, case folding) is
   * performed here; such normalization is the responsibility of the
   * TraceParent header parser or the caller's ContextFactory.
   */
  static create<S = null>(
    executor: unknown = null,
    identity: Identity | null = null,
    data?: Record<string, unknown>,
    traceParent?: TraceParent | null,
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
    // D11-002a: Carry the inbound TraceParent through the request lifecycle so
    // downstream TraceContext.inject() can propagate the W3C sampling decision
    // (traceFlags) and vendor state (tracestate) instead of defaulting to "01"
    // and dropping tracestate. Mirrors apcore-python context.py:88-94 (which
    // stores the parsed flags+tracestate under separate keys; the TS inject()
    // path reads the entire TraceParent under one well-known key, so we stash
    // the object verbatim).
    const ctxData: Record<string, unknown> = data ?? {};
    if (traceParent != null && !('_apcore.trace.inbound' in ctxData)) {
      ctxData['_apcore.trace.inbound'] = traceParent;
    }
    return new Context<S>(
      traceId,
      null,
      [],
      executor,
      identity,
      null,
      ctxData,
      null,
      services ?? (null as S),
      globalDeadline ?? null,
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
