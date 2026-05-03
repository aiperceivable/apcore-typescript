/**
 * Issue #45 §3 — UsageExporter push interface.
 *
 * - `UsageExporter` is the contract: `export(summary)` + `shutdown()`.
 * - `NoopUsageExporter` is the safe default (no-op).
 * - `PeriodicUsageExporter` pumps `collector.getSummary()` into an exporter
 *   on a fixed interval; `start()` schedules, `stop()` clears the interval
 *   and awaits `exporter.shutdown()`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UsageCollector,
  NoopUsageExporter,
  PeriodicUsageExporter,
  type UsageExporter,
} from '../../src/observability/index.js';

describe('UsageExporter (#45 §3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('NoopUsageExporter satisfies the UsageExporter interface', () => {
    const exp: UsageExporter = new NoopUsageExporter();
    expect(typeof exp.export).toBe('function');
    expect(typeof exp.shutdown).toBe('function');
    // Calling them must not throw.
    expect(() => exp.export({})).not.toThrow();
    expect(() => exp.shutdown()).not.toThrow();
  });

  it('PeriodicUsageExporter pushes the collector summary at each interval', () => {
    const collector = new UsageCollector();
    collector.record('email.send', 'caller.a', 12, true);

    const exported: Record<string, unknown>[] = [];
    const exporter: UsageExporter = {
      export(summary) {
        exported.push(summary);
      },
      shutdown() {},
    };

    const periodic = new PeriodicUsageExporter(collector, exporter, 1000);
    periodic.start();
    expect(exported.length).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(exported.length).toBe(1);
    expect(Array.isArray((exported[0] as { modules: unknown }).modules)).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(exported.length).toBe(3);
  });

  it('stop() clears the interval and awaits exporter.shutdown()', async () => {
    const collector = new UsageCollector();
    const shutdownSpy = vi.fn().mockResolvedValue(undefined);
    const exportSpy = vi.fn();
    const exporter: UsageExporter = {
      export: exportSpy,
      shutdown: shutdownSpy,
    };

    const periodic = new PeriodicUsageExporter(collector, exporter, 500);
    periodic.start();

    vi.advanceTimersByTime(500);
    expect(exportSpy).toHaveBeenCalledTimes(1);

    await periodic.stop();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);

    // After stop, no further exports are triggered.
    vi.advanceTimersByTime(5000);
    expect(exportSpy).toHaveBeenCalledTimes(1);
  });

  it('PeriodicUsageExporter defaults to a 1-hour interval when not specified', () => {
    const collector = new UsageCollector();
    const exportSpy = vi.fn();
    const exporter: UsageExporter = { export: exportSpy, shutdown() {} };

    const periodic = new PeriodicUsageExporter(collector, exporter);
    periodic.start();

    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(exportSpy).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(exportSpy).toHaveBeenCalledTimes(1);
  });
});
