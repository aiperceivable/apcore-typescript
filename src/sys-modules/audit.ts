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
