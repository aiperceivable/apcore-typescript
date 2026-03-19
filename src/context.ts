/**
 * Execution context, identity, and context creation.
 */

import { v4 as uuidv4 } from 'uuid';
import type { CancelToken } from './cancel.js';
import type { TraceParent } from './trace-context.js';
import { ContextLogger } from './observability/context-logger.js';

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
  return Object.freeze({ id, type, roles: Object.freeze([...roles]), attrs: Object.freeze({ ...attrs }) });
}

export class Context<T = null> {
  readonly traceId: string;
  readonly callerId: string | null;
  readonly callChain: readonly string[];
  readonly executor: unknown;
  readonly identity: Identity | null;
  redactedInputs: Record<string, unknown> | null;
  readonly data: Record<string, unknown>;
  readonly services: T;
  readonly cancelToken: CancelToken | null;

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
  ) {
    this.traceId = traceId;
    this.callerId = callerId;
    this.callChain = Object.freeze([...callChain]);
    this.executor = executor;
    this.identity = identity;
    this.redactedInputs = redactedInputs;
    this.data = data;
    this.services = services;
    this.cancelToken = cancelToken;
  }

  /**
   * Create a new top-level Context with a generated UUID v4 traceId.
   *
   * When `traceParent` is provided, its `traceId` (32 hex chars) is
   * converted to UUID format (8-4-4-4-12) and used instead of generating
   * a new one.
   */
  static create<S = null>(
    executor: unknown = null,
    identity: Identity | null = null,
    data?: Record<string, unknown>,
    traceParent?: TraceParent | null,
    services?: S,
  ): Context<S> {
    let traceId: string;
    if (traceParent) {
      const h = traceParent.traceId;
      traceId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    } else {
      traceId = uuidv4();
    }
    return new Context<S>(
      traceId,
      null,
      [],
      executor,
      identity,
      null,
      data ?? {},
      null,
      services ?? (null as S),
    );
  }

  toJSON(): Record<string, unknown> {
    const publicData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (!key.startsWith('_')) {
        publicData[key] = value;
      }
    }
    return {
      traceId: this.traceId,
      callerId: this.callerId,
      callChain: [...this.callChain],
      identity: this.identity ? {
        id: this.identity.id,
        type: this.identity.type,
        roles: [...this.identity.roles],
        attrs: { ...this.identity.attrs },
      } : null,
      redactedInputs: this.redactedInputs ? { ...this.redactedInputs } : null,
      data: publicData,
    };
  }

  static fromJSON(data: Record<string, unknown>, executor?: unknown): Context {
    const identityData = data.identity as Record<string, unknown> | null;
    const identity = identityData ? {
      id: identityData.id as string,
      type: (identityData.type as string) ?? 'user',
      roles: Object.freeze([...(Array.isArray(identityData.roles) ? identityData.roles : [])]),
      attrs: Object.freeze((identityData.attrs && typeof identityData.attrs === 'object' ? identityData.attrs : {}) as Record<string, unknown>),
    } : null;
    return new Context(
      data.traceId as string,
      (data.callerId as string) ?? null,
      (data.callChain as string[]) ?? [],
      executor ?? null,
      identity,
      (data.redactedInputs as Record<string, unknown>) ?? null,
      data.data ? { ...(data.data as Record<string, unknown>) } : {},
    );
  }

  get logger(): ContextLogger {
    return ContextLogger.fromContext(this, this.callerId ?? 'unknown');
  }

  child(targetModuleId: string): Context<T> {
    return new Context<T>(
      this.traceId,
      this.callChain.length > 0 ? this.callChain[this.callChain.length - 1] : null,
      [...this.callChain, targetModuleId],
      this.executor,
      this.identity,
      null,
      this.data, // shared reference
      this.cancelToken,
      this.services,
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
