/**
 * Error history with ring-buffer eviction and deduplication.
 */

import { ModuleError } from '../errors.js';

export interface ErrorEntry {
  readonly moduleId: string;
  readonly code: string;
  readonly message: string;
  readonly aiGuidance: string | null;
  readonly timestamp: string;
  count: number;
  firstOccurred: string;
  lastOccurred: string;
}

/**
 * Ring buffer storing recent error details per module.
 * Supports deduplication by (code, message) within each module,
 * per-module eviction, and global total eviction.
 */
export class ErrorHistory {
  private readonly _maxEntriesPerModule: number;
  private readonly _maxTotalEntries: number;
  private readonly _entries: Map<string, ErrorEntry[]> = new Map();

  constructor(maxEntriesPerModule: number = 50, maxTotalEntries: number = 1000) {
    this._maxEntriesPerModule = maxEntriesPerModule;
    this._maxTotalEntries = maxTotalEntries;
  }

  record(moduleId: string, error: ModuleError): void {
    const now = new Date().toISOString();
    let moduleEntries = this._entries.get(moduleId);
    if (!moduleEntries) {
      moduleEntries = [];
      this._entries.set(moduleId, moduleEntries);
    }

    const existing = moduleEntries.find(
      (e) => e.code === error.code && e.message === error.message,
    );
    if (existing) {
      existing.count++;
      existing.lastOccurred = now;
      return;
    }

    const entry: ErrorEntry = {
      moduleId,
      code: error.code,
      message: error.message,
      aiGuidance: error.aiGuidance,
      timestamp: now,
      count: 1,
      firstOccurred: now,
      lastOccurred: now,
    };
    moduleEntries.push(entry);
    this._evictModule(moduleEntries);
    this._evictTotal();
  }

  get(moduleId: string, limit?: number): ErrorEntry[] {
    const moduleEntries = this._entries.get(moduleId) ?? [];
    const result = [...moduleEntries].reverse();
    return limit !== undefined ? result.slice(0, limit) : result;
  }

  clear(): void {
    this._entries.clear();
  }

  clearModule(moduleId: string): void {
    this._entries.delete(moduleId);
  }

  getAll(limit?: number): ErrorEntry[] {
    const all: ErrorEntry[] = [];
    for (const entries of this._entries.values()) {
      all.push(...entries);
    }
    all.sort((a, b) => (a.lastOccurred > b.lastOccurred ? -1 : 1));
    return limit !== undefined ? all.slice(0, limit) : all;
  }

  private _evictModule(moduleEntries: ErrorEntry[]): void {
    while (moduleEntries.length > this._maxEntriesPerModule) {
      moduleEntries.shift();
    }
  }

  private _evictTotal(): void {
    let total = 0;
    for (const entries of this._entries.values()) {
      total += entries.length;
    }
    while (total > this._maxTotalEntries) {
      let oldestEntry: ErrorEntry | null = null;
      let oldestModuleId: string | null = null;
      for (const [mid, entries] of this._entries) {
        if (entries.length > 0) {
          const candidate = entries[0];
          if (oldestEntry === null || candidate.lastOccurred < oldestEntry.lastOccurred) {
            oldestEntry = candidate;
            oldestModuleId = mid;
          }
        }
      }
      if (oldestModuleId === null) break;
      const entries = this._entries.get(oldestModuleId)!;
      entries.shift();
      if (entries.length === 0) {
        this._entries.delete(oldestModuleId);
      }
      total--;
    }
  }
}
