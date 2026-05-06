/**
 * Tests for the optional `Module.preview()` method and
 * `PreflightResult.predictedChanges` field.
 *
 * Speculative implementation tracking the upstream apcore RFC at
 * `apcore/docs/spec/rfc-preview-method.md` (currently `Draft / RFC`).
 *
 * Cross-references issue aiperceivable/apcore-typescript#27.
 */

import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Executor } from '../src/executor.js';
import { FunctionModule } from '../src/decorator.js';
import { Registry } from '../src/registry/registry.js';
import { TChange } from '../src/module.js';
import type {
  Change,
  Module,
  PreflightCheckResult,
  PreviewResult,
} from '../src/module.js';

const inputSchema = Type.Object({ id: Type.String() });
const outputSchema = Type.Object({ ok: Type.Boolean() });

function buildExecutor(moduleId: string, mod: Module): Executor {
  const registry = new Registry();
  registry.register(moduleId, mod);
  return new Executor({ registry });
}

describe('Module.preview() / PreflightResult.predictedChanges', () => {
  it('module without preview() leaves predictedChanges absent', async () => {
    const mod = new FunctionModule({
      execute: () => ({ ok: true }),
      moduleId: 'no.preview',
      inputSchema,
      outputSchema,
      description: 'No preview method',
    });
    const executor = buildExecutor('no.preview', mod);
    const result = await executor.validate('no.preview', { id: 'x' });

    expect(result.valid).toBe(true);
    expect(result.predictedChanges).toBeUndefined();
    expect(
      result.checks.some((c: PreflightCheckResult) => c.check === 'module_preview'),
    ).toBe(false);
  });

  it('preview() returning null leaves predictedChanges absent', async () => {
    const mod: Module = {
      inputSchema,
      outputSchema,
      description: 'Preview returns null',
      execute: () => ({ ok: true }),
      preview: (): PreviewResult | null => null,
    };
    const executor = buildExecutor('preview.null', mod);
    const result = await executor.validate('preview.null', { id: 'x' });

    expect(result.valid).toBe(true);
    expect(result.predictedChanges).toBeUndefined();
    // The check is recorded (method was present and returned cleanly), even
    // though no changes were produced.
    expect(
      result.checks.some(
        (c: PreflightCheckResult) => c.check === 'module_preview' && c.passed,
      ),
    ).toBe(true);
  });

  it('preview() returning a single Change with required fields populates predictedChanges', async () => {
    const mod: Module = {
      inputSchema,
      outputSchema,
      description: 'Preview single change',
      execute: () => ({ ok: true }),
      preview: (inputs): PreviewResult => ({
        changes: [
          {
            action: 'send',
            target: `smtp:user-${inputs['id'] as string}`,
            summary: 'Send confirmation email',
          },
        ],
      }),
    };
    const executor = buildExecutor('preview.one', mod);
    const result = await executor.validate('preview.one', { id: '42' });

    expect(result.valid).toBe(true);
    expect(result.predictedChanges).toBeDefined();
    expect(result.predictedChanges).toHaveLength(1);
    const change = (result.predictedChanges as Change[])[0]!;
    expect(change.action).toBe('send');
    expect(change.target).toBe('smtp:user-42');
    expect(change.summary).toBe('Send confirmation email');
    expect(change.before).toBeUndefined();
    expect(change.after).toBeUndefined();
  });

  it('preview() returning multiple Changes preserves order and before/after', async () => {
    const mod: Module = {
      inputSchema,
      outputSchema,
      description: 'Preview multiple changes',
      execute: () => ({ ok: true }),
      preview: async (): Promise<PreviewResult> => ({
        changes: [
          {
            action: 'delete',
            target: 'users.42',
            summary: 'Permanently delete user 42',
            before: { id: 42, email: 'a@example.com', tier: 'gold' },
          },
          {
            action: 'write',
            target: 'audit_log',
            summary: 'Append audit row for user deletion',
            after: { event: 'user.deleted', user_id: 42 },
          },
          {
            action: 'send',
            target: 'smtp:a@example.com',
            summary: 'Send goodbye email',
          },
        ],
      }),
    };
    const executor = buildExecutor('preview.many', mod);
    const result = await executor.validate('preview.many', { id: '42' });

    expect(result.valid).toBe(true);
    expect(result.predictedChanges).toBeDefined();
    const changes = result.predictedChanges as Change[];
    expect(changes).toHaveLength(3);

    expect(changes[0]!.action).toBe('delete');
    expect(changes[0]!.before).toEqual({
      id: 42,
      email: 'a@example.com',
      tier: 'gold',
    });
    expect(changes[0]!.after).toBeUndefined();

    expect(changes[1]!.action).toBe('write');
    expect(changes[1]!.after).toEqual({ event: 'user.deleted', user_id: 42 });
    expect(changes[1]!.before).toBeUndefined();

    expect(changes[2]!.action).toBe('send');
    expect(changes[2]!.summary).toBe('Send goodbye email');
  });

  it('preview() throwing synchronously surfaces a warning but does not fail validation', async () => {
    const mod: Module = {
      inputSchema,
      outputSchema,
      description: 'Preview that throws sync',
      execute: () => ({ ok: true }),
      preview: (): PreviewResult => {
        throw new Error('preview-sync-boom');
      },
    };
    const executor = buildExecutor('preview.sync.throw', mod);
    const result = await executor.validate('preview.sync.throw', { id: 'x' });

    // Validation must NOT fail.
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // No changes recorded.
    expect(result.predictedChanges).toBeUndefined();
    // Warning surfaces via the dedicated check.
    const previewCheck = result.checks.find(
      (c: PreflightCheckResult) => c.check === 'module_preview',
    );
    expect(previewCheck).toBeDefined();
    expect(previewCheck!.passed).toBe(true);
    expect(previewCheck!.warnings).toBeDefined();
    expect(previewCheck!.warnings!.some((w) => w.includes('preview-sync-boom'))).toBe(true);
  });

  it('preview() rejecting asynchronously surfaces a warning but does not fail validation', async () => {
    const mod: Module = {
      inputSchema,
      outputSchema,
      description: 'Preview that rejects async',
      execute: () => ({ ok: true }),
      preview: async (): Promise<PreviewResult | null> => {
        throw new Error('preview-async-boom');
      },
    };
    const executor = buildExecutor('preview.async.throw', mod);
    const result = await executor.validate('preview.async.throw', { id: 'x' });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.predictedChanges).toBeUndefined();
    const previewCheck = result.checks.find(
      (c: PreflightCheckResult) => c.check === 'module_preview',
    );
    expect(previewCheck).toBeDefined();
    expect(previewCheck!.passed).toBe(true);
    expect(previewCheck!.warnings!.some((w) => w.includes('preview-async-boom'))).toBe(true);
  });

  it('preview() supports `x-*` extension fields on Change records', async () => {
    const mod: Module = {
      inputSchema,
      outputSchema,
      description: 'Preview with x-* extension',
      execute: () => ({ ok: true }),
      preview: (): PreviewResult => ({
        changes: [
          {
            action: 'charge',
            target: 'stripe:charge:ch_abc',
            summary: 'Charge $9.99',
            'x-confidence': 0.95,
          },
        ],
      }),
    };
    const executor = buildExecutor('preview.ext', mod);
    const result = await executor.validate('preview.ext', { id: 'x' });

    expect(result.valid).toBe(true);
    const changes = result.predictedChanges as Change[];
    expect(changes).toHaveLength(1);
    expect(changes[0]!['x-confidence']).toBe(0.95);
  });

  it('preserves Change.x-* extension fields end-to-end and validates against TChange', async () => {
    // Per upstream RFC `apcore/docs/spec/rfc-preview-method.md` ("Change.x-*
    // extension fields — cross-SDK schema-encoding note"), TChange uses
    // `patternProperties: { "^x-": {} }` + `additionalProperties: false`.
    // This test is the litmus check: x-* keys round-trip through
    // Executor.validate(), Value.Check(TChange, ...) accepts them, and
    // unknown non-x- keys are rejected.
    const mod: Module = {
      inputSchema,
      outputSchema,
      description: 'Preview with x-* extension round-trip',
      execute: () => ({ ok: true }),
      preview: (): PreviewResult => ({
        changes: [
          {
            action: 'write',
            target: 'x',
            summary: 's',
            'x-foo': 'bar',
            'x-count': 42,
          },
        ],
      }),
    };
    const executor = buildExecutor('preview.xroundtrip', mod);
    const result = await executor.validate('preview.xroundtrip', { id: 'x' });

    // 1. End-to-end: x-* keys survive through Executor.validate().
    expect(result.valid).toBe(true);
    const changes = result.predictedChanges as Change[];
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change['x-foo']).toBe('bar');
    expect(change['x-count']).toBe(42);

    // 2. Schema validation: TChange admits arbitrary x-* keys.
    expect(Value.Check(TChange, change)).toBe(true);

    // 3. Schema validation: a Change with only required fields still passes.
    expect(
      Value.Check(TChange, { action: 'a', target: 't', summary: 's' }),
    ).toBe(true);

    // 4. Regression for additionalProperties: false — unknown non-x- keys
    //    must be rejected by TChange.
    const bogus = {
      action: 'a',
      target: 't',
      summary: 's',
      random_key: 'no',
    };
    expect(Value.Check(TChange, bogus)).toBe(false);
  });
});
