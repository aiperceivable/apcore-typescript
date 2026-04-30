/**
 * Event subscribers for webhook, A2A, file, stdout, and filter delivery.
 */

import * as fs from 'node:fs';
import type { ApCoreEvent, EventSubscriber } from './emitter.js';

const SEVERITY_ORDER: Record<string, number> = { info: 0, warn: 1, error: 2, fatal: 3 };

const _patternCache = new Map<string, RegExp>();

function fnmatch(text: string, pattern: string): boolean {
  let regex = _patternCache.get(pattern);
  if (regex === undefined) {
    const regexStr = Array.from(pattern)
      .map((c) => {
        if (c === '*') return '.*';
        if (c === '?') return '.';
        return c.replace(/[$()*+.?[\]^{|}-]/g, '\\$&');
      })
      .join('');
    regex = new RegExp(`^${regexStr}$`);
    _patternCache.set(pattern, regex);
  }
  return regex.test(text);
}

/**
 * Delivers events via HTTP POST to a webhook URL.
 *
 * Retries on 5xx and connection errors up to `retryCount` times.
 * Does not retry on 4xx responses. Enforces `timeoutMs`.
 */
export class WebhookSubscriber implements EventSubscriber {
  private readonly _url: string;
  private readonly _headers: Record<string, string>;
  private readonly _retryCount: number;
  private readonly _timeoutMs: number;

  constructor(
    url: string,
    headers?: Record<string, string>,
    retryCount: number = 3,
    timeoutMs: number = 5000,
  ) {
    this._url = url;
    this._headers = headers ?? {};
    this._retryCount = retryCount;
    this._timeoutMs = timeoutMs;
  }

  async onEvent(event: ApCoreEvent): Promise<void> {
    const payload: Record<string, unknown> = {
      eventType: event.eventType,
      moduleId: event.moduleId,
      timestamp: event.timestamp,
      severity: event.severity,
      data: event.data,
    };
    const mergedHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._headers,
    };

    const attempts = 1 + this._retryCount;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);
      try {
        const response = await fetch(this._url, {
          method: 'POST',
          headers: mergedHeaders,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.status < 500) {
          if (response.status >= 400) {
            console.warn(
              '[apcore:events]',
              `Webhook ${this._url} returned ${response.status} for event ${event.eventType}`,
            );
          }
          return;
        }

        // 5xx -- retry
        lastError = new Error(`Webhook returned ${response.status}`);
        console.warn(
          '[apcore:events]',
          `Webhook ${this._url} returned ${response.status} (attempt ${attempt + 1}/${attempts})`,
        );
      } catch (err: unknown) {
        lastError = err;
        console.warn(
          '[apcore:events]',
          `Webhook ${this._url} failed (attempt ${attempt + 1}/${attempts}):`,
          err,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastError !== null) {
      console.warn(
        '[apcore:events]',
        `Webhook ${this._url} delivery failed after ${attempts} attempts:`,
        lastError,
      );
    }
  }
}

/**
 * Delivers events via the A2A protocol to the platform.
 *
 * Sends a POST with `skillId="apevo.event_receiver"` and the
 * serialized event in the payload. Failures are logged, not raised.
 */
export class A2ASubscriber implements EventSubscriber {
  private readonly _platformUrl: string;
  private readonly _auth: string | Record<string, string> | undefined;
  private readonly _timeoutMs: number;

  constructor(
    platformUrl: string,
    auth?: string | Record<string, string | unknown>,
    timeoutMs: number = 5000,
  ) {
    this._platformUrl = platformUrl;
    this._auth = auth as string | Record<string, string> | undefined;
    this._timeoutMs = timeoutMs;
  }

  async onEvent(event: ApCoreEvent): Promise<void> {
    const payload: Record<string, unknown> = {
      skillId: 'apevo.event_receiver',
      event: {
        eventType: event.eventType,
        moduleId: event.moduleId,
        timestamp: event.timestamp,
        severity: event.severity,
        data: event.data,
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this._auth !== undefined) {
      if (typeof this._auth === 'string') {
        // String auth → Bearer token (per spec)
        headers['Authorization'] = `Bearer ${this._auth}`;
      } else {
        // Dict auth → merge as header overrides
        for (const [key, value] of Object.entries(this._auth)) {
          if (typeof value === 'string') {
            headers[key] = value;
          }
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await fetch(this._platformUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status >= 400) {
        console.warn(
          '[apcore:events]',
          `A2A delivery to ${this._platformUrl} failed with status ${response.status}`,
        );
      }
    } catch (err: unknown) {
      console.warn(
        '[apcore:events]',
        `A2A delivery to ${this._platformUrl} failed for event ${event.eventType}:`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Writes events to a local file (built-in type: 'file'). */
export class FileSubscriber implements EventSubscriber {
  private readonly _path: string;
  private readonly _append: boolean;
  private readonly _format: string;
  private readonly _rotateBytes: number | null;

  constructor(path: string, append: boolean = true, format: string = 'json', rotateBytes?: number) {
    this._path = path;
    this._append = append;
    this._format = format;
    this._rotateBytes = rotateBytes ?? null;
  }

  async onEvent(event: ApCoreEvent): Promise<void> {
    try {
      if (this._rotateBytes !== null) {
        try {
          const stat = fs.statSync(this._path);
          if (stat.size >= this._rotateBytes) {
            fs.renameSync(this._path, `${this._path}.1`);
          }
        } catch {
          // file doesn't exist yet — no rotation needed
        }
      }

      const line =
        this._format === 'json'
          ? JSON.stringify({
              event_type: event.eventType,
              module_id: event.moduleId,
              timestamp: event.timestamp,
              severity: event.severity,
              data: event.data,
            }) + '\n'
          : `[${event.timestamp}] [${event.severity.toUpperCase()}] ${event.eventType} module=${event.moduleId} data=${JSON.stringify(event.data)}\n`;

      fs.writeFileSync(this._path, line, { flag: this._append ? 'a' : 'w', encoding: 'utf-8' });
    } catch (err: unknown) {
      console.warn(
        '[apcore:events]',
        `FileSubscriber failed to write event ${event.eventType} to ${this._path}:`,
        err,
      );
    }
  }
}

/** Writes events to stdout (built-in type: 'stdout'). */
export class StdoutSubscriber implements EventSubscriber {
  private readonly _format: string;
  private readonly _levelFilter: string | null;

  constructor(format: string = 'text', levelFilter?: string) {
    this._format = format;
    if (levelFilter !== undefined && !(levelFilter in SEVERITY_ORDER)) {
      console.warn(
        `[apcore:events] StdoutSubscriber: unknown level_filter '${levelFilter}' — valid values: info, warn, error, fatal. All events will pass.`,
      );
    }
    this._levelFilter = levelFilter ?? null;
  }

  async onEvent(event: ApCoreEvent): Promise<void> {
    if (this._levelFilter !== null) {
      const minLevel = SEVERITY_ORDER[this._levelFilter] ?? 0;
      const eventLevel = SEVERITY_ORDER[event.severity] ?? 0;
      if (eventLevel < minLevel) return;
    }

    const line =
      this._format === 'json'
        ? JSON.stringify({
            event_type: event.eventType,
            module_id: event.moduleId,
            timestamp: event.timestamp,
            severity: event.severity,
            data: event.data,
          })
        : `[${event.timestamp}] [${event.severity.toUpperCase()}] ${event.eventType} module=${event.moduleId} data=${JSON.stringify(event.data)}`;

    process.stdout.write(line + '\n');
  }
}

/**
 * Wraps a delegate subscriber with event-name filtering (built-in type: 'filter').
 *
 * Matching rules (evaluated in order):
 *   1. If include_events is set, forward only events matching any pattern.
 *   2. Otherwise if exclude_events is set, discard events matching any pattern.
 *   3. If neither is set, forward all events.
 */
export class FilterSubscriber implements EventSubscriber {
  private readonly _delegate: EventSubscriber;
  private readonly _includeEvents: string[] | null;
  private readonly _excludeEvents: string[] | null;

  constructor(delegate: EventSubscriber, includeEvents?: string[], excludeEvents?: string[]) {
    this._delegate = delegate;
    this._includeEvents = includeEvents ?? null;
    this._excludeEvents = excludeEvents ?? null;
  }

  async onEvent(event: ApCoreEvent): Promise<void> {
    if (this._matches(event.eventType)) {
      await this._delegate.onEvent(event);
    }
  }

  private _matches(eventType: string): boolean {
    if (this._includeEvents !== null) {
      return this._includeEvents.some((pattern) => fnmatch(eventType, pattern));
    }
    if (this._excludeEvents !== null) {
      return !this._excludeEvents.some((pattern) => fnmatch(eventType, pattern));
    }
    return true;
  }
}
