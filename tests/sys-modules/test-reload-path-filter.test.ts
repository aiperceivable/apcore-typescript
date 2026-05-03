/**
 * Issue #45.4 — Granular reload via path_filter.
 *
 * ReloadModule MUST support a `path_filter` glob input that scopes the
 * re-discovery to matching module IDs. Unaffected modules stay loaded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError, ModuleReloadConflictError } from '../../src/errors.js';
import { EventEmitter } from '../../src/events/emitter.js';
import { Registry } from '../../src/registry/registry.js';
import { ReloadModule } from '../../src/sys-modules/control.js';

describe('ReloadModule path_filter (Issue #45.4)', () => {
  let registry: Registry;
  let emitter: EventEmitter;
  let mod: ReloadModule;

  function createDummyModule(version: string = '1.0.0'): Record<string, unknown> {
    return {
      description: 'A dummy module',
      version,
      execute: () => ({ result: 'ok' }),
    };
  }

  beforeEach(() => {
    registry = new Registry();
    emitter = new EventEmitter();
    mod = new ReloadModule(registry, emitter);
  });

  it('returns reloaded_modules array for path_filter mode', async () => {
    registry.registerInternal('app.email.send', createDummyModule());
    registry.registerInternal('app.email.fetch', createDummyModule());
    registry.registerInternal('app.calendar.list', createDummyModule());

    // Stub re-discovery so the modules remain registered after re-discover.
    vi.spyOn(registry, 'discover').mockResolvedValue(0);

    const result = await mod.execute({ path_filter: 'app.email.*', reason: 'rotate' }, null);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.reloaded_modules)).toBe(true);
    // The matching modules are unregistered then expected to be re-loaded by
    // the discoverer. With our mock discover() that does nothing, only
    // modules restored by registerInternal fallback would appear; verify
    // mode does not crash and returns an array.
  });

  it('rejects when both module_id and path_filter are supplied', async () => {
    await expect(
      mod.execute({ module_id: 'm.x', path_filter: 'app.*', reason: 'r' }, null),
    ).rejects.toThrow(ModuleReloadConflictError);
  });

  it('rejects when neither module_id nor path_filter is supplied', async () => {
    await expect(mod.execute({ reason: 'r' }, null)).rejects.toThrow(InvalidInputError);
  });

  it('does not unregister modules outside the path_filter glob', async () => {
    registry.registerInternal('app.email.send', createDummyModule());
    registry.registerInternal('app.calendar.list', createDummyModule());

    // discover() is a no-op for the test — but we want to ensure
    // app.calendar.list is left untouched throughout the call.
    const safeUnregisterSpy = vi.spyOn(registry, 'safeUnregister');
    vi.spyOn(registry, 'discover').mockResolvedValue(0);

    await mod.execute({ path_filter: 'app.email.*', reason: 'rotate' }, null);

    const unregisteredIds = safeUnregisterSpy.mock.calls.map((c) => c[0]);
    expect(unregisteredIds).toContain('app.email.send');
    expect(unregisteredIds).not.toContain('app.calendar.list');
  });

  it('rejects empty-string path_filter as invalid', async () => {
    await expect(mod.execute({ path_filter: '', reason: 'r' }, null)).rejects.toThrow(
      InvalidInputError,
    );
  });
});
