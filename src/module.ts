/**
 * Module interface and related data types.
 */

import type { TSchema } from '@sinclair/typebox';
import type { Context } from './context.js';

export interface ModuleAnnotations {
  readonly readonly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly requiresApproval: boolean;
  readonly openWorld: boolean;
  readonly streaming: boolean;
  readonly cacheable?: boolean;
  readonly cacheTtl?: number;
  readonly cacheKeyFields?: string[] | null;
  readonly paginated?: boolean;
  readonly paginationStyle?: 'cursor' | 'offset' | 'page';
}

export const DEFAULT_ANNOTATIONS: ModuleAnnotations = Object.freeze({
  readonly: false,
  destructive: false,
  idempotent: false,
  requiresApproval: false,
  openWorld: true,
  streaming: false,
  cacheable: false,
  cacheTtl: 0,
  cacheKeyFields: null,
  paginated: false,
  paginationStyle: 'cursor' as const,
});

export interface ModuleExample {
  title: string;
  inputs: Record<string, unknown>;
  output: Record<string, unknown>;
  description?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<Record<string, string>>;
}

export interface PreflightCheckResult {
  readonly check: string;
  readonly passed: boolean;
  readonly error?: Record<string, unknown>;
  readonly warnings?: string[];
}

export interface PreflightResult {
  readonly valid: boolean;
  readonly checks: PreflightCheckResult[];
  readonly requiresApproval: boolean;
  readonly errors: Array<Record<string, unknown>>;
}

export function createPreflightResult(
  checks: PreflightCheckResult[],
  requiresApproval: boolean = false,
): PreflightResult {
  const valid = checks.every(c => c.passed);
  const errors = checks
    .filter(c => !c.passed && c.error != null)
    .map(c => c.error!);
  return { valid, checks, requiresApproval, errors };
}

export interface Module {
  inputSchema: TSchema;
  outputSchema: TSchema;
  description: string;
  execute(inputs: Record<string, unknown>, context: Context): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Optional: Stream module output chunk by chunk. */
  stream?(inputs: Record<string, unknown>, context: Context): AsyncGenerator<Record<string, unknown>>;
  /** Optional: Custom input validation without execution. */
  validate?(inputs: Record<string, unknown>): ValidationResult | Promise<ValidationResult>;
  /** Optional: Domain-specific pre-execution warnings (called by Executor.validate() Check 7). Advisory only — warnings do NOT block execution. */
  preflight?(inputs: Record<string, unknown>, context: Context): string[] | Promise<string[]>;
  /** Optional: Return module description for LLM/AI tool discovery. */
  describe?(): ModuleDescription | Promise<ModuleDescription>;
  /** Optional: Called when module is loaded into the registry. */
  onLoad?(): void | Promise<void>;
  /** Optional: Called when module is unloaded from the registry. */
  onUnload?(): void | Promise<void>;
  /** Optional: Capture module state before hot-reload. Return null to skip state transfer. */
  onSuspend?(): Record<string, unknown> | null;
  /** Optional: Restore module state after hot-reload. */
  onResume?(state: Record<string, unknown>): void;
}

export interface ModuleDescription {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly annotations: ModuleAnnotations;
  readonly examples: ModuleExample[];
}
