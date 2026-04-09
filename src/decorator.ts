/**
 * Module factory, FunctionModule wrapper.
 *
 * TypeScript version uses explicit TypeBox schemas instead of runtime type inference.
 */

import type { TSchema } from '@sinclair/typebox';
import type { Context } from './context.js';
import { InvalidInputError } from './errors.js';
import type { ModuleAnnotations, ModuleExample } from './module.js';

export function normalizeResult(result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) return {};
  if (typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  return { result };
}

export class FunctionModule {
  readonly moduleId: string;
  readonly inputSchema: TSchema;
  readonly outputSchema: TSchema;
  readonly description: string;
  readonly documentation: string | null;
  readonly tags: string[] | null;
  readonly version: string;
  readonly annotations: ModuleAnnotations | null;
  readonly metadata: Record<string, unknown> | null;
  readonly examples: ModuleExample[] | null;

  private _executeFn: (inputs: Record<string, unknown>, context: Context) => Promise<Record<string, unknown>> | Record<string, unknown>;

  constructor(options: {
    execute: (inputs: Record<string, unknown>, context: Context) => Promise<Record<string, unknown>> | Record<string, unknown>;
    moduleId: string;
    inputSchema: TSchema;
    outputSchema: TSchema;
    description?: string;
    documentation?: string | null;
    tags?: string[] | null;
    version?: string;
    annotations?: ModuleAnnotations | null;
    metadata?: Record<string, unknown> | null;
    examples?: ModuleExample[] | null;
  }) {
    this.moduleId = options.moduleId;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
    this.description = options.description ?? `Module ${options.moduleId}`;
    this.documentation = options.documentation ?? null;
    this.tags = options.tags ?? null;
    this.version = options.version ?? '1.0.0';
    this.annotations = options.annotations ?? null;
    this.metadata = options.metadata ?? null;
    this.examples = options.examples ?? null;
    this._executeFn = options.execute;
  }

  async execute(inputs: Record<string, unknown>, context: Context): Promise<Record<string, unknown>> {
    const result = await this._executeFn(inputs, context);
    return normalizeResult(result);
  }
}

export function makeAutoId(name: string): string {
  let raw = name.toLowerCase();
  raw = raw.replace(/[^a-z0-9_.]/g, '_');
  const segments = raw.split('.');
  return segments
    .map((s) => (s && s[0] >= '0' && s[0] <= '9' ? '_' + s : s))
    .join('.');
}

/**
 * Create a FunctionModule from options. TypeScript version requires explicit schemas.
 */
export function module(options: {
  id?: string;
  inputSchema: TSchema;
  outputSchema: TSchema;
  description?: string;
  documentation?: string | null;
  annotations?: ModuleAnnotations | null;
  tags?: string[] | null;
  version?: string;
  metadata?: Record<string, unknown> | null;
  examples?: ModuleExample[] | null;
  execute: (inputs: Record<string, unknown>, context: Context) => Promise<Record<string, unknown>> | Record<string, unknown>;
  registry?: { register(moduleId: string, module: unknown): void } | null;
}): FunctionModule {
  // Spec PROTOCOL_SPEC.md §5.11.6 mandates auto-generated module IDs follow
  // the `{module_path}.{name}` form. JavaScript lacks runtime equivalents of
  // Python's `__module__` / `__qualname__`, so the only spec-aligned options
  // are: (a) require an explicit `id`, or (b) accept a hack like Error-stack
  // parsing that would silently break under bundlers/minifiers. We choose (a)
  // — matching apcore-rust which has never had auto-ID generation either.
  // Previously this defaulted to the literal string 'anonymous', causing
  // every id-less call to silently collide on the same module ID.
  if (!options.id) {
    throw new InvalidInputError(
      "module() requires an explicit 'id' option per PROTOCOL_SPEC §5.11.6 — " +
        'JavaScript cannot derive a canonical {module_path}.{name} at runtime',
    );
  }
  const moduleId = options.id;

  const fm = new FunctionModule({
    execute: options.execute,
    moduleId,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    description: options.description,
    documentation: options.documentation,
    tags: options.tags,
    version: options.version,
    annotations: options.annotations,
    metadata: options.metadata,
    examples: options.examples,
  });

  if (options.registry) {
    options.registry.register(fm.moduleId, fm);
  }

  return fm;
}
