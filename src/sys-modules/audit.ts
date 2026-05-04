import type { Context } from '../context.js';

export type AuditAction = 'update_config' | 'reload_module' | 'toggle_feature';

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  targetModuleId: string;
  actorId: string;
  actorType: string;
  traceId: string;
  change: { before: unknown; after: unknown };
}

export interface AuditFilter {
  moduleId?: string;
  actorId?: string;
  since?: string;
}

export interface AuditStore {
  append(entry: AuditEntry): void;
  query(filter?: AuditFilter): AuditEntry[];
}

export class InMemoryAuditStore implements AuditStore {
  private readonly _entries: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this._entries.push(entry);
  }

  query(filter?: AuditFilter): AuditEntry[] {
    let results = [...this._entries];
    if (filter?.moduleId !== undefined) {
      results = results.filter((e) => e.targetModuleId === filter.moduleId);
    }
    if (filter?.actorId !== undefined) {
      results = results.filter((e) => e.actorId === filter.actorId);
    }
    if (filter?.since !== undefined) {
      const since = new Date(filter.since);
      results = results.filter((e) => new Date(e.timestamp) >= since);
    }
    return results;
  }
}

export function buildAuditEntry(
  action: AuditAction,
  targetModuleId: string,
  context: Context | null,
  change: { before: unknown; after: unknown },
): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    action,
    targetModuleId,
    actorId: context?.identity?.id ?? 'unknown',
    actorType: context?.identity?.type ?? 'unknown',
    traceId: context?.traceId ?? 'unknown',
    change,
  };
}

/** Identity attribute substrings treated as x-sensitive in audit payloads. */
const SENSITIVE_IDENTITY_ATTR_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'api_key',
  'apikey',
  'access_key',
  'private_key',
  'authorization',
  'cookie',
  'bearer',
];

/**
 * Issue #45.2: Extract requester identity fields for audit event payloads.
 *
 * Returns `caller_id` (defaulting to `"@external"` when absent so that audit
 * events always carry a non-null requester marker) and a redacted-safe
 * `identity` snapshot (or `null` when the context has no identity).
 *
 * Per docs/features/system-modules.md §"Contextual auditing", the snapshot
 * MUST contain `id`, `type`, and (optionally) `display_name`; any attribute
 * whose key looks x-sensitive (bearer_token, api_key, etc.) is replaced with
 * the literal string `"<redacted>"` rather than dropped, so subscribers can
 * see that a sensitive credential was involved without leaking its value.
 */
export function extractAuditIdentity(
  context: Context | null,
): { caller_id: string; identity: Record<string, unknown> | null } {
  const callerIdRaw = context?.callerId;
  const callerId = callerIdRaw == null || callerIdRaw === '' ? '@external' : callerIdRaw;
  const ident = context?.identity ?? null;
  if (!ident) {
    return { caller_id: callerId, identity: null };
  }
  const snapshot: Record<string, unknown> = {
    id: ident.id,
    type: ident.type,
    roles: [...ident.roles],
  };
  // Surface display_name from attrs if present (spec #45.2 calls it out as
  // an optional first-class field on the audit identity snapshot).
  const displayName = (ident.attrs as Record<string, unknown>)['display_name'];
  if (typeof displayName === 'string' && displayName.length > 0) {
    snapshot['display_name'] = displayName;
  }
  // Pass through any other attrs, redacting those whose key matches a
  // sensitive substring (case-insensitive).
  for (const [k, v] of Object.entries(ident.attrs)) {
    if (k === 'display_name') continue;
    const lk = k.toLowerCase();
    const sensitive = SENSITIVE_IDENTITY_ATTR_SUBSTRINGS.some((s) => lk.includes(s));
    snapshot[k] = sensitive ? '<redacted>' : v;
  }
  return { caller_id: callerId, identity: snapshot };
}
