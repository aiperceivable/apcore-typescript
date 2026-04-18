/**
 * In-memory metrics collection with Prometheus export.
 */

import type { Context } from '../context.js';
import { ModuleError } from '../errors.js';
import { Middleware } from '../middleware/base.js';

const DESCRIPTIONS: Record<string, string> = {
  apcore_module_calls_total: 'Total module calls',
  apcore_module_errors_total: 'Total module errors',
  apcore_module_duration_seconds: 'Module execution duration',
};

function labelsKey(labels: Record<string, string>): string {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
}

export class MetricsCollector {
  static readonly DEFAULT_BUCKETS: number[] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0,
  ];

  private _buckets: number[];
  private _counters: Map<string, number> = new Map();
  private _histogramSums: Map<string, number> = new Map();
  private _histogramCounts: Map<string, number> = new Map();
  private _histogramBuckets: Map<string, number> = new Map();

  constructor(buckets?: number[]) {
    this._buckets = buckets ? [...buckets].sort((a, b) => a - b) : [...MetricsCollector.DEFAULT_BUCKETS];
  }

  get buckets(): readonly number[] {
    return this._buckets;
  }

  increment(name: string, labels: Record<string, string>, amount: number = 1): void {
    const key = `${name}|${labelsKey(labels)}`;
    this._counters.set(key, (this._counters.get(key) ?? 0) + amount);
  }

  observe(name: string, labels: Record<string, string>, value: number): void {
    const lk = labelsKey(labels);
    const key = `${name}|${lk}`;

    this._histogramSums.set(key, (this._histogramSums.get(key) ?? 0) + value);
    this._histogramCounts.set(key, (this._histogramCounts.get(key) ?? 0) + 1);

    for (const b of this._buckets) {
      if (value <= b) {
        const bkey = `${name}|${lk}|${b}`;
        this._histogramBuckets.set(bkey, (this._histogramBuckets.get(bkey) ?? 0) + 1);
      }
    }
    // +Inf bucket
    const infKey = `${name}|${lk}|Inf`;
    this._histogramBuckets.set(infKey, (this._histogramBuckets.get(infKey) ?? 0) + 1);
  }

  snapshot(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this._counters),
      histograms: {
        sums: Object.fromEntries(this._histogramSums),
        counts: Object.fromEntries(this._histogramCounts),
        buckets: Object.fromEntries(this._histogramBuckets),
      },
    };
  }

  reset(): void {
    this._counters.clear();
    this._histogramSums.clear();
    this._histogramCounts.clear();
    this._histogramBuckets.clear();
  }

  exportPrometheus(): string {
    const lines: string[] = [];
    const counterNames = new Set<string>();
    const histNames = new Set<string>();

    // Counters
    for (const [compositeKey, value] of [...this._counters.entries()].sort()) {
      const [name, lk] = compositeKey.split('|', 2);
      if (!counterNames.has(name)) {
        const desc = DESCRIPTIONS[name] ?? name;
        lines.push(`# HELP ${name} ${desc}`);
        lines.push(`# TYPE ${name} counter`);
        counterNames.add(name);
      }
      const labelsStr = formatLabels(parseLabels(lk));
      lines.push(`${name}${labelsStr} ${value}`);
    }

    // Histograms
    const histKeys = [...this._histogramSums.keys()].sort();
    for (const compositeKey of histKeys) {
      const [name, lk] = compositeKey.split('|', 2);
      if (!histNames.has(name)) {
        const desc = DESCRIPTIONS[name] ?? name;
        lines.push(`# HELP ${name} ${desc}`);
        lines.push(`# TYPE ${name} histogram`);
        histNames.add(name);
      }

      const labelsDict = parseLabels(lk);
      const labelsStr = formatLabels(labelsDict);

      for (const b of this._buckets) {
        const bkey = `${name}|${lk}|${b}`;
        const count = this._histogramBuckets.get(bkey) ?? 0;
        const leStr = String(b);
        const leLabels = { ...labelsDict, le: leStr };
        lines.push(`${name}_bucket${formatLabels(leLabels)} ${count}`);
      }

      const infKey = `${name}|${lk}|Inf`;
      const infCount = this._histogramBuckets.get(infKey) ?? 0;
      const infLabels = { ...labelsDict, le: '+Inf' };
      lines.push(`${name}_bucket${formatLabels(infLabels)} ${infCount}`);

      const sumVal = this._histogramSums.get(compositeKey) ?? 0;
      const countVal = this._histogramCounts.get(compositeKey) ?? 0;
      lines.push(`${name}_sum${labelsStr} ${sumVal}`);
      lines.push(`${name}_count${labelsStr} ${countVal}`);
    }

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  incrementCalls(moduleId: string, status: string): void {
    this.increment('apcore_module_calls_total', { module_id: moduleId, status });
  }

  incrementErrors(moduleId: string, errorCode: string): void {
    this.increment('apcore_module_errors_total', { module_id: moduleId, error_code: errorCode });
  }

  observeDuration(moduleId: string, durationSeconds: number): void {
    this.observe('apcore_module_duration_seconds', { module_id: moduleId }, durationSeconds);
  }
}

function parseLabels(lk: string): Record<string, string> {
  if (!lk) return {};
  const result: Record<string, string> = {};
  for (const pair of lk.split(',')) {
    const [k, v] = pair.split('=', 2);
    if (k) result[k] = v ?? '';
  }
  return result;
}

/**
 * Escape a Prometheus exposition-format label value per
 * https://prometheus.io/docs/instrumenting/exposition_formats/ :
 *   backslash -> \\, double-quote -> \", newline -> \n.
 * Without this, any label value containing `"`, `\` or `\n` silently breaks
 * the exposition format and breaks downstream parsers.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const sorted = entries.sort(([a], [b]) => {
    if (a === 'le') return 1;
    if (b === 'le') return -1;
    return a.localeCompare(b);
  });
  const pairs = sorted.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
  return `{${pairs}}`;
}

export class MetricsMiddleware extends Middleware {
  private _collector: MetricsCollector;

  constructor(collector: MetricsCollector) {
    super();
    this._collector = collector;
  }

  override before(
    _moduleId: string,
    _inputs: Record<string, unknown>,
    context: Context,
  ): null {
    const starts = (context.data['_apcore.mw.metrics.starts'] as number[]) ?? [];
    starts.push(performance.now());
    context.data['_apcore.mw.metrics.starts'] = starts;
    return null;
  }

  override after(
    moduleId: string,
    _inputs: Record<string, unknown>,
    _output: Record<string, unknown>,
    context: Context,
  ): null {
    const starts = context.data['_apcore.mw.metrics.starts'] as number[] | undefined;
    if (!starts || starts.length === 0) return null;
    const startTime = starts.pop()!;
    const durationS = (performance.now() - startTime) / 1000;
    this._collector.incrementCalls(moduleId, 'success');
    this._collector.observeDuration(moduleId, durationS);
    return null;
  }

  override onError(
    moduleId: string,
    _inputs: Record<string, unknown>,
    error: Error,
    context: Context,
  ): null {
    const starts = context.data['_apcore.mw.metrics.starts'] as number[] | undefined;
    if (!starts || starts.length === 0) return null;
    const startTime = starts.pop()!;
    const durationS = (performance.now() - startTime) / 1000;
    const errorCode = error instanceof ModuleError ? error.code : error.constructor.name;
    this._collector.incrementCalls(moduleId, 'error');
    this._collector.incrementErrors(moduleId, errorCode);
    this._collector.observeDuration(moduleId, durationS);
    return null;
  }
}
