/**
 * Structured logging: ContextLogger, RedactionConfig, and ObsLoggingMiddleware.
 */

import type { Config } from '../config.js';
import type { Context } from '../context.js';
import { Middleware } from '../middleware/base.js';
// matchPattern intentionally not imported — sensitive_keys uses
// fnmatch-style globs against lowercased keys, not apcore's segment-aware
// pattern matcher (which is case-sensitive and segment-anchored).

/**
 * Default sensitive field patterns (Issue #45 §3 — canonical superset
 * promoted from #43 §5). Used when no `redaction.sensitive_keys`
 * (canonical) / `redaction.field_patterns` (legacy) is configured.
 * Wildcards follow apcore's `matchPattern` semantics (segment-aware globs).
 *
 * Aligned with apcore-python's authoritative list (Python is the canonical
 * superset because broader default redaction is safer than narrower).
 * `apiKey` is kept alongside `api_key` / `apikey` for camelCase parity
 * because TypeScript's `matchPattern` is case-sensitive.
 */
export const DEFAULT_REDACTION_FIELD_PATTERNS: readonly string[] = [
  '_secret_*',
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'apiKey',
  'access_key',
  'private_key',
  'authorization',
  'auth',
  'credential',
  'cookie',
  'session',
  'bearer',
];

/**
 * One-shot deprecation warning bookkeeping for legacy
 * `observability.redaction.*` keys (sync finding CRITICAL #4). Mirrors the
 * cross-language pattern — warn once per process when legacy keys are read,
 * pointing migrators at the canonical `obs.redaction.*` namespace.
 */
const _REDACTION_LEGACY_DEPRECATION_EMITTED: { value: boolean } = { value: false };

function _emitRedactionLegacyDeprecation(legacyKeys: string[]): void {
  if (_REDACTION_LEGACY_DEPRECATION_EMITTED.value) return;
  _REDACTION_LEGACY_DEPRECATION_EMITTED.value = true;
  console.warn(
    `[apcore] Config keys ${legacyKeys.join(', ')} are deprecated; ` +
      'use obs.redaction.sensitive_keys / obs.redaction.regex_patterns / obs.redaction.replacement instead. ' +
      'Legacy keys will be removed in a future release.',
  );
}

// ---------------------------------------------------------------------------
// RedactionConfig
// ---------------------------------------------------------------------------

const PROTECTED_LOG_FIELDS = new Set([
  'trace_id',
  'caller_id',
  'target_id',
  'module_id',
  'span_id',
]);

/**
 * Normalize a field name for substring matching: lowercase + collapse
 * hyphens / spaces to underscores. Mirrors apcore-python's
 * `_normalize_key_for_match` so `X-API-Key` matches `api_key`.
 */
function _normalizeKeyForMatch(s: string): string {
  return s.toLowerCase().replace(/[- ]/g, '_');
}

/**
 * Compact normalization: lowercase with hyphen / underscore / space
 * stripped entirely. Mirrors apcore-python's `_compact_for_match` so
 * camelCase keys like `AccessKey` substring-match the `access_key` pattern
 * (D-54 canonical default expectation).
 */
function _compactKeyForMatch(s: string): string {
  return s.toLowerCase().replace(/[-_ ]/g, '');
}

/**
 * Compile a sensitive_keys glob into a case-insensitive RegExp matching the
 * full lowercase key. Mirrors fnmatch semantics: `*` -> `.*`, `?` -> `.`,
 * `[abc]` is treated as a character class as-is.
 */
function _globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        out += pattern.slice(i, close + 1);
        i = close;
      }
    } else if ('\\^$.|+(){}'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * Runtime-configurable redaction rules for ObsLoggingMiddleware.
 * Applied in addition to schema-level x-sensitive annotations.
 */
export class RedactionConfig {
  readonly fieldPatterns: readonly string[];
  readonly valuePatterns: readonly (RegExp | string)[];
  readonly replacement: string;

  constructor(
    options: {
      fieldPatterns?: string[];
      valuePatterns?: (RegExp | string)[];
      replacement?: string;
    } = {},
  ) {
    this.fieldPatterns = options.fieldPatterns ?? [];
    this.valuePatterns = options.valuePatterns ?? [];
    this.replacement = options.replacement ?? '***REDACTED***';
  }

  /**
   * Build a RedactionConfig from an apcore {@link Config}.
   *
   * Reads canonical keys first (sync finding CRITICAL #4 — aligns with
   * apcore-python / apcore-rust):
   *   - `obs.redaction.sensitive_keys` (string[])
   *   - `obs.redaction.regex_patterns` (string[]; compiled case-insensitively)
   *   - `obs.redaction.replacement`    (string)
   *
   * For backwards compatibility, falls back to legacy keys (Issue #43 §5)
   * when the canonical key is unset, and emits a one-shot deprecation
   * warning the first time a legacy key is read:
   *   - `observability.redaction.field_patterns`   (legacy of sensitive_keys)
   *   - `observability.redaction.value_patterns`   (legacy of regex_patterns)
   *   - `observability.redaction.replacement`      (legacy of replacement)
   *
   * Falls back to {@link DEFAULT_REDACTION_FIELD_PATTERNS} when no sensitive
   * keys are configured so `_secret_*` and standard sensitive keys (apiKey,
   * api_key, token, authorization, password) remain redacted out of the box.
   */
  static fromConfig(config: Config): RedactionConfig {
    const legacyKeysUsed: string[] = [];

    // --- sensitive_keys (formerly field_patterns) ---
    let rawFields = config.get('obs.redaction.sensitive_keys');
    if (rawFields === undefined || rawFields === null) {
      const legacyFields = config.get('observability.redaction.field_patterns');
      if (legacyFields !== undefined && legacyFields !== null) {
        rawFields = legacyFields;
        legacyKeysUsed.push('observability.redaction.field_patterns');
      }
    }

    // --- regex_patterns (formerly value_patterns) ---
    let rawValues = config.get('obs.redaction.regex_patterns');
    if (rawValues === undefined || rawValues === null) {
      const legacyValues = config.get('observability.redaction.value_patterns');
      if (legacyValues !== undefined && legacyValues !== null) {
        rawValues = legacyValues;
        legacyKeysUsed.push('observability.redaction.value_patterns');
      }
    }

    // --- replacement ---
    let replacement = config.get('obs.redaction.replacement');
    if (replacement === undefined || replacement === null) {
      const legacyReplacement = config.get('observability.redaction.replacement');
      if (legacyReplacement !== undefined && legacyReplacement !== null) {
        replacement = legacyReplacement;
        legacyKeysUsed.push('observability.redaction.replacement');
      }
    }

    if (legacyKeysUsed.length > 0) {
      _emitRedactionLegacyDeprecation(legacyKeysUsed);
    }

    const fieldPatterns =
      Array.isArray(rawFields) && rawFields.length > 0
        ? (rawFields as unknown[]).filter((p): p is string => typeof p === 'string')
        : [...DEFAULT_REDACTION_FIELD_PATTERNS];

    const valueStrings = Array.isArray(rawValues)
      ? (rawValues as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    const valuePatterns: (RegExp | string)[] = valueStrings.map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        // Drop invalid patterns rather than throwing at logger init.
        return /(?!)/; // never matches
      }
    });

    return new RedactionConfig({
      fieldPatterns,
      valuePatterns,
      replacement: typeof replacement === 'string' ? replacement : undefined,
    });
  }

  /** Apply redaction rules to a flat object of field name → value. */
  apply(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (this._shouldRedact(k, v)) {
        result[k] = this.replacement;
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  private _shouldRedact(fieldName: string, value: unknown): boolean {
    if (PROTECTED_LOG_FIELDS.has(fieldName)) return false;

    const lowerKey = fieldName.toLowerCase();
    const normKey = _normalizeKeyForMatch(fieldName);
    const compactKey = _compactKeyForMatch(fieldName);
    for (const pattern of this.fieldPatterns) {
      if (!pattern) continue;
      const lowerPat = pattern.toLowerCase();
      const isGlob = /[*?[]/.test(lowerPat);
      if (isGlob) {
        if (_globToRegExp(lowerPat).test(lowerKey)) return true;
      } else {
        // Plain case-insensitive substring match with hyphen/space ↔ underscore
        // equivalence (apcore-python behavioral parity).
        const normPat = _normalizeKeyForMatch(pattern);
        if (normKey.includes(normPat)) return true;
        // Also try the compact (separator-stripped) form so that camelCase
        // keys like "AccessKey" match the "access_key" canonical pattern.
        const compactPat = _compactKeyForMatch(pattern);
        if (compactKey.includes(compactPat)) return true;
      }
    }

    if (typeof value === 'string') {
      for (const pattern of this.valuePatterns) {
        const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
        if (re.test(value)) return true;
      }
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// ContextLogger
// ---------------------------------------------------------------------------

const LEVELS: Record<string, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const REDACTED = '***REDACTED***';

function deepRedact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = k.startsWith('_secret_') ? REDACTED : deepRedact(v);
    }
    return result;
  }
  return value;
}

interface WritableOutput {
  write(s: string): void;
}

export class ContextLogger {
  private _name: string;
  private _format: string;
  private _level: string;
  private _levelValue: number;
  private _redactSensitive: boolean;
  private _output: WritableOutput;
  private _traceId: string | null = null;
  private _moduleId: string | null = null;
  private _callerId: string | null = null;

  constructor(options?: {
    name?: string;
    format?: string;
    level?: string;
    redactSensitive?: boolean;
    output?: WritableOutput;
  }) {
    this._name = options?.name ?? 'apcore';
    this._format = options?.format ?? 'json';
    this._level = options?.level ?? 'info';
    this._levelValue = LEVELS[this._level] ?? 20;
    this._redactSensitive = options?.redactSensitive ?? true;
    // Default output uses console.error for universal compatibility (Node.js + browser)
    this._output = options?.output ?? { write: (s: string) => console.error(s) };
  }

  static fromContext(
    context: Context<unknown>,
    name: string,
    options?: {
      format?: string;
      level?: string;
      redactSensitive?: boolean;
      output?: WritableOutput;
    },
  ): ContextLogger {
    const logger = new ContextLogger({ name, ...options });
    logger._traceId = context.traceId;
    logger._moduleId =
      context.callChain.length > 0 ? context.callChain[context.callChain.length - 1] : null;
    logger._callerId = context.callerId;
    return logger;
  }

  private _emit(levelName: string, message: string, extra?: Record<string, unknown> | null): void {
    const levelValue = LEVELS[levelName] ?? 20;
    if (levelValue < this._levelValue) return;

    let redactedExtra = extra ?? null;
    if (extra != null && this._redactSensitive) {
      redactedExtra = deepRedact(extra) as Record<string, unknown>;
    }

    const now = new Date();
    const entry: Record<string, unknown> = {
      timestamp: now.toISOString(),
      level: levelName,
      message,
      trace_id: this._traceId,
      module_id: this._moduleId,
      caller_id: this._callerId,
      logger: this._name,
      extra: redactedExtra,
    };

    if (this._format === 'json') {
      this._output.write(JSON.stringify(entry) + '\n');
    } else {
      const ts = now
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '');
      const lvl = levelName.toUpperCase();
      const trace = this._traceId ?? 'none';
      const mod = this._moduleId ?? 'none';
      let extrasStr = '';
      if (redactedExtra) {
        extrasStr =
          ' ' +
          Object.entries(redactedExtra)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
      }
      this._output.write(
        `${ts} [${lvl}] [trace=${trace}] [module=${mod}] ${message}${extrasStr}\n`,
      );
    }
  }

  trace(message: string, extra?: Record<string, unknown>): void {
    this._emit('trace', message, extra);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this._emit('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this._emit('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this._emit('warn', message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this._emit('error', message, extra);
  }

  fatal(message: string, extra?: Record<string, unknown>): void {
    this._emit('fatal', message, extra);
  }
}

export class ObsLoggingMiddleware extends Middleware {
  private _logger: ContextLogger;
  private _logInputs: boolean;
  private _logOutputs: boolean;
  private _redactionConfig: RedactionConfig | null;

  constructor(options?: {
    logger?: ContextLogger;
    logInputs?: boolean;
    logOutputs?: boolean;
    redactionConfig?: RedactionConfig | null;
  }) {
    super();
    this._logger = options?.logger ?? new ContextLogger({ name: 'apcore.obs_logging' });
    this._logInputs = options?.logInputs ?? true;
    this._logOutputs = options?.logOutputs ?? true;
    this._redactionConfig = options?.redactionConfig ?? null;
  }

  override before(moduleId: string, inputs: Record<string, unknown>, context: Context): null {
    const starts = (context.data['_apcore.mw.logging.obs_starts'] as number[]) ?? [];
    starts.push(performance.now());
    context.data['_apcore.mw.logging.obs_starts'] = starts;

    const extra: Record<string, unknown> = {
      module_id: moduleId,
      caller_id: context.callerId,
    };
    if (this._logInputs) {
      let loggableInputs = (context.redactedInputs ?? inputs) as Record<string, unknown>;
      if (this._redactionConfig !== null) {
        loggableInputs = this._redactionConfig.apply(loggableInputs);
      }
      extra['inputs'] = loggableInputs;
    }
    this._logger.info('Module call started', extra);
    return null;
  }

  override after(
    moduleId: string,
    _inputs: Record<string, unknown>,
    output: Record<string, unknown>,
    context: Context,
  ): null {
    const starts = context.data['_apcore.mw.logging.obs_starts'] as number[] | undefined;
    if (!starts || starts.length === 0) return null;
    const startTime = starts.pop()!;
    const durationMs = performance.now() - startTime;

    const extra: Record<string, unknown> = {
      module_id: moduleId,
      duration_ms: durationMs,
    };
    if (this._logOutputs) {
      // Prefer the executor's schema-aware redacted output so x-sensitive
      // fields (API keys, tokens) do not leak into logs. The executor has
      // already applied the schema; falling back to `output` preserves
      // behavior for callers invoking the middleware outside the pipeline.
      let loggableOutput = (context.redactedOutput ?? output) as Record<string, unknown>;
      if (this._redactionConfig !== null) {
        loggableOutput = this._redactionConfig.apply(loggableOutput);
      }
      extra['output'] = loggableOutput;
    }
    this._logger.info('Module call completed', extra);
    return null;
  }

  override onError(
    moduleId: string,
    _inputs: Record<string, unknown>,
    error: Error,
    context: Context,
  ): null {
    const starts = context.data['_apcore.mw.logging.obs_starts'] as number[] | undefined;
    if (!starts || starts.length === 0) return null;
    const startTime = starts.pop()!;
    const durationMs = performance.now() - startTime;

    this._logger.error('Module call failed', {
      module_id: moduleId,
      duration_ms: durationMs,
      error_type: error.constructor.name,
      error_message: String(error),
    });
    return null;
  }
}
