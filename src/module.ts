/**
 * Module interface and related data types.
 */

import { Kind, type TSchema, Type, TypeRegistry } from '@sinclair/typebox';
import type { Context } from './context.js';

export interface ModuleAnnotations {
  readonly readonly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly requiresApproval: boolean;
  readonly openWorld: boolean;
  readonly streaming: boolean;
  /** Whether the module's results can be cached. */
  readonly cacheable: boolean;
  /** Cache time-to-live in seconds (0 means no expiry). */
  readonly cacheTtl: number;
  /** Input fields used to compute the cache key (null = all fields). */
  readonly cacheKeyFields: readonly string[] | null;
  /** Whether the module supports paginated results. */
  readonly paginated: boolean;
  /** Pagination strategy. Accepts any string. */
  readonly paginationStyle: string;
  /**
   * Whether the module appears in enumeration surfaces (`Registry.list()`,
   * `Registry.find()`, manifest export, MCP `tools/list`). Defaults to `true`
   * so existing modules remain visible. Setting `false` keeps the module
   * callable by exact ID but hides it from discovery — `ephemeral.*` modules
   * SHOULD set this to `false` per PROTOCOL_SPEC §4.4 / RFC
   * `apcore/docs/spec/rfc-ephemeral-modules.md`.
   *
   * Optional on the interface so v0.20.x callers building `ModuleAnnotations`
   * literals keep compiling; absent values default to `true` per spec when
   * `Registry._isDiscoverable` interprets them.
   */
  readonly discoverable?: boolean;
  /** Extension dictionary for ecosystem package metadata. */
  readonly extra: Readonly<Record<string, unknown>>;
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
  paginationStyle: 'cursor',
  discoverable: true,
  extra: Object.freeze({}),
});

/**
 * Factory to create a frozen ModuleAnnotations with defaults for unspecified fields.
 * Negative cacheTtl is clamped to 0 with a console warning.
 */
export function createAnnotations(
  overrides?: Partial<ModuleAnnotations>,
): ModuleAnnotations {
  let cacheTtl = overrides?.cacheTtl ?? DEFAULT_ANNOTATIONS.cacheTtl;
  if (cacheTtl < 0) {
    console.warn(`[apcore:annotations] cacheTtl ${cacheTtl} is negative, clamping to 0`);
    cacheTtl = 0;
  }
  return Object.freeze({
    ...DEFAULT_ANNOTATIONS,
    ...overrides,
    cacheTtl,
    extra: Object.freeze({ ...(overrides?.extra ?? {}) }),
  });
}

const KNOWN_WIRE_KEYS = new Set([
  'readonly', 'destructive', 'idempotent', 'requires_approval',
  'open_world', 'streaming', 'cacheable', 'cache_ttl',
  'cache_key_fields', 'paginated', 'pagination_style', 'discoverable', 'extra',
]);

/**
 * Serialize ModuleAnnotations to a snake_case JSON-compatible record.
 */
export function annotationsToJSON(a: ModuleAnnotations): Record<string, unknown> {
  return {
    readonly: a.readonly,
    destructive: a.destructive,
    idempotent: a.idempotent,
    requires_approval: a.requiresApproval,
    open_world: a.openWorld,
    streaming: a.streaming,
    cacheable: a.cacheable,
    cache_ttl: a.cacheTtl,
    cache_key_fields: a.cacheKeyFields,
    paginated: a.paginated,
    pagination_style: a.paginationStyle,
    discoverable: a.discoverable,
    extra: a.extra,
  };
}

/**
 * Deserialize ModuleAnnotations from a snake_case JSON record per
 * PROTOCOL_SPEC §4.4.1 wire format.
 *
 * - Canonical extension data lives under a nested `extra` object.
 * - Legacy top-level overflow keys (unknown keys at the annotations root) are
 *   tolerated for backward compatibility and merged into `extra`.
 * - When the same key appears in BOTH the nested `extra` AND as a top-level
 *   overflow key, the nested value wins (§4.4.1 rule 7).
 */
export function annotationsFromJSON(data: Record<string, unknown>): ModuleAnnotations {
  const explicitExtra = (data['extra'] as Record<string, unknown>) ?? {};
  const overflow: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN_WIRE_KEYS.has(k)) overflow[k] = v;
  }

  let cacheTtl = (data['cache_ttl'] as number) ?? 0;
  if (cacheTtl < 0) {
    console.warn(`[apcore:annotations] cache_ttl ${cacheTtl} is negative, clamping to 0`);
    cacheTtl = 0;
  }

  return Object.freeze({
    readonly: (data['readonly'] as boolean) ?? false,
    destructive: (data['destructive'] as boolean) ?? false,
    idempotent: (data['idempotent'] as boolean) ?? false,
    requiresApproval: (data['requires_approval'] as boolean) ?? false,
    openWorld: (data['open_world'] as boolean) ?? true,
    streaming: (data['streaming'] as boolean) ?? false,
    cacheable: (data['cacheable'] as boolean) ?? false,
    cacheTtl,
    cacheKeyFields: (data['cache_key_fields'] as string[] | null) ?? null,
    paginated: (data['paginated'] as boolean) ?? false,
    paginationStyle: (data['pagination_style'] as string) ?? 'cursor',
    // PROTOCOL_SPEC §4.4 — defaults to true so wires from older SDKs that
    // don't yet emit the field stay backward-compatible.
    discoverable: (data['discoverable'] as boolean | undefined) ?? true,
    // §4.4.1 rule 7: nested explicit `extra` wins over legacy top-level overflow.
    extra: Object.freeze({ ...overflow, ...explicitExtra }),
  });
}

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
  /**
   * Optional. Module-self-reported structured prediction of the changes that
   * executing the call would produce, populated by `Executor.validate()` when
   * the target module implements `preview()` (see RFC
   * `apcore/docs/spec/rfc-preview-method.md`, currently Draft / RFC).
   *
   * - Absent (or empty) when the module does not implement `preview()` or
   *   when `preview()` returned `null`.
   * - When `preview()` throws, `predictedChanges` is left unset and a
   *   `module_preview` advisory check carries the warning, mirroring
   *   `preflight()` semantics (warnings do not fail validation).
   */
  readonly predictedChanges?: Change[];
}

export function createPreflightResult(
  checks: PreflightCheckResult[],
  requiresApproval: boolean = false,
  predictedChanges?: Change[],
): PreflightResult {
  const valid = checks.every(c => c.passed);
  const errors = checks
    .filter(c => !c.passed && c.error != null)
    .map(c => c.error!);
  if (predictedChanges !== undefined) {
    return { valid, checks, requiresApproval, errors, predictedChanges };
  }
  return { valid, checks, requiresApproval, errors };
}

/**
 * Structured prediction of a single side-effect that executing a module call
 * would produce. Per RFC `apcore/docs/spec/rfc-preview-method.md`
 * (Draft / RFC, target acceptance v0.21.0).
 *
 * `action`, `target`, and `summary` are required; module authors define their
 * own free-form taxonomy for `action` (e.g. "write", "delete", "send",
 * "charge", "publish") and `target` (e.g. "users.42", "smtp:user@example.com").
 *
 * `before` / `after` are optional snapshots of prior / predicted state. Both
 * are typed `unknown` to keep the schema heterogeneous across module classes
 * (DB writes, network calls, file I/O, email sends).
 *
 * Extension fields with the `x-` prefix are permitted (consistent with
 * PROTOCOL_SPEC §4.4 extras).
 */
export interface Change {
  /** Free-form verb describing the kind of change (e.g. "write", "delete", "send"). */
  action: string;
  /** Free-form identifier of what is changed (e.g. "users.42", "stripe:charge:ch_abc"). */
  target: string;
  /** Required, human-readable single-line summary of the change. */
  summary: string;
  /** Optional. Snapshot of the prior state, when observable. */
  before?: unknown;
  /** Optional. Predicted new state. */
  after?: unknown;
  /** Extension fields. Keys MUST start with the `x-` prefix. */
  [key: `x-${string}`]: unknown;
}

/**
 * Module's structured prediction of the changes that calling `execute()` with
 * the given inputs would produce. Returned by the optional `Module.preview()`
 * method; folded into `PreflightResult.predictedChanges` by
 * `Executor.validate()`.
 */
export interface PreviewResult {
  /** Ordered list of predicted side-effects. */
  changes: Change[];
}

/**
 * Custom TypeBox kind for `Change`.
 *
 * Encoded via `Type.Unsafe<Change>(...)` so the underlying JSON Schema can
 * carry both `patternProperties: { "^x-": {} }` (admitting arbitrary `x-*`
 * extension keys per PROTOCOL_SPEC §4.4 / §4.6 conventions) and
 * `additionalProperties: false` (rejecting unknown non-`x-` keys). TypeBox
 * 0.34's `Type.Object` schema-checker does not consult `patternProperties`,
 * so a `Type.Object({...}, { additionalProperties: false })` form would
 * incorrectly reject `x-*` keys; and `Type.Intersect([Object, Record])`
 * loses `additionalProperties: false` precision. The cross-SDK
 * schema-encoding table in `apcore/docs/spec/rfc-preview-method.md`
 * ("Change.x-* extension fields") prescribes the `Type.Unsafe` escape hatch.
 *
 * To make the schema usable with `Value.Check` (which routes by `[Kind]`), we
 * register a custom `'apcore:Change'` kind whose checker enforces the same
 * shape the JSON Schema describes. The JSON Schema body remains the canonical
 * cross-SDK wire form.
 */
const CHANGE_KIND = 'apcore:Change';

if (!TypeRegistry.Has(CHANGE_KIND)) {
  TypeRegistry.Set(CHANGE_KIND, (_schema, value): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.action !== 'string') return false;
    if (typeof v.target !== 'string') return false;
    if (typeof v.summary !== 'string') return false;
    const known = new Set(['action', 'target', 'summary', 'before', 'after']);
    for (const key of Object.keys(v)) {
      if (known.has(key)) continue;
      // Anything else MUST start with `x-` (any value).
      if (!key.startsWith('x-')) return false;
    }
    return true;
  });
}

/**
 * TypeBox schema mirroring `Change`. Exported alongside the TypeScript type
 * for runtime validation / wire-format use. Mirrors the JSON Schema sketch in
 * `apcore/docs/spec/rfc-preview-method.md`. The raw JSON Schema body
 * (`type`, `required`, `properties`, `patternProperties`,
 * `additionalProperties: false`) is the canonical cross-SDK wire format; the
 * `[Kind]` field routes `Value.Check` to the registered checker above.
 */
export const TChange = Type.Unsafe<Change>({
  [Kind]: CHANGE_KIND,
  type: 'object',
  required: ['action', 'target', 'summary'],
  properties: {
    action: {
      type: 'string',
      description: 'Free-form verb describing the kind of change.',
    },
    target: {
      type: 'string',
      description: 'Free-form identifier of what is changed.',
    },
    summary: {
      type: 'string',
      description: 'Required, human-readable single-line summary of the change.',
    },
    before: {
      // unknown — module-class specific. JSON Schema `{}` accepts any value.
      description: 'Optional. Snapshot of the prior state, when observable.',
    },
    after: {
      description: 'Optional. Predicted new state.',
    },
  },
  patternProperties: {
    // Arbitrary x-* extension keys with arbitrary values (PROTOCOL_SPEC §4.4).
    '^x-': {},
  },
  additionalProperties: false,
});

/** TypeBox schema mirroring `PreviewResult`. */
export const TPreviewResult = Type.Object({
  changes: Type.Array(TChange, {
    description:
      "Module's prediction of what would change if the call were executed.",
  }),
});

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
  /**
   * Optional: Return a structured prediction of the changes this call would
   * produce. Invoked by `Executor.validate()` after the standard validation
   * pipeline succeeds, only on modules that implement it.
   *
   * Per RFC `apcore/docs/spec/rfc-preview-method.md` (currently Draft / RFC):
   * - MUST NOT have side effects.
   * - Returning `null` (or omitting the method) means "no predicted changes".
   * - Throwing / rejecting is treated as advisory and does NOT fail validation.
   *   The error is surfaced as a warning via the `module_preview` check,
   *   matching `preflight()` semantics.
   */
  preview?(
    inputs: Record<string, unknown>,
    context: Context,
  ): PreviewResult | null | Promise<PreviewResult | null>;
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
