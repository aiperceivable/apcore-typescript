/**
 * Event subscribers for webhook and A2A protocol delivery.
 */

import type { ApCoreEvent, EventSubscriber } from './emitter.js';

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
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);

        const response = await fetch(this._url, {
          method: 'POST',
          headers: mergedHeaders,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timer);

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
  private readonly _auth: Record<string, unknown> | undefined;
  private readonly _timeoutMs: number;

  constructor(
    platformUrl: string,
    auth?: Record<string, unknown>,
    timeoutMs: number = 5000,
  ) {
    this._platformUrl = platformUrl;
    this._auth = auth;
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
      const token = this._auth['token'];
      if (typeof token === 'string') {
        headers['Authorization'] = `Bearer ${token}`;
      } else {
        // Treat auth as header overrides
        for (const [key, value] of Object.entries(this._auth)) {
          if (typeof value === 'string') {
            headers[key] = value;
          }
        }
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);

      const response = await fetch(this._platformUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

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
    }
  }
}
