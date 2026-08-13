/**
 * Cross-language conformance driver for event_delivery_semantics.json (Issue #61).
 *
 * Fixture source: apcore/conformance/fixtures/event_delivery_semantics.json
 * (single source of truth). apcore-python drives it from
 * tests/conformance/test_event_delivery_semantics.py and apcore-rust from
 * tests/test_event_delivery_conformance.rs; TypeScript had no driver.
 *
 * Contract: every subscriber type honours the unified retry config, permanent
 * failure emits `apcore.event.delivery_failed` with the normative payload, and
 * the DLQ event itself is never retried.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter, createEvent } from '../src/events/emitter.js';
import type { ApCoreEvent, EventSubscriber } from '../src/events/emitter.js';
import type { RetryConfig } from '../src/events/retry.js';
import { StdoutSubscriber } from '../src/events/subscribers.js';
import { findFixturesRoot } from './spec-repo.js';

const DLQ_EVENT_TYPE = 'apcore.event.delivery_failed';

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(findFixturesRoot(), 'event_delivery_semantics.json'), 'utf-8'),
) as { test_cases: Array<Record<string, any>> };

function caseById(id: string): Record<string, any> {
  const found = FIXTURE.test_cases.find((c) => c['id'] === id);
  if (!found) throw new Error(`Fixture case '${id}' not found`);
  return found;
}

function buildRetry(cfg: Record<string, any> | undefined): RetryConfig {
  return {
    maxAttempts: cfg?.['max_attempts'] ?? 3,
    initialBackoffMs: cfg?.['initial_backoff_ms'] ?? 100,
    maxBackoffMs: cfg?.['max_backoff_ms'] ?? 30_000,
    backoffMultiplier: cfg?.['backoff_multiplier'] ?? 2.0,
  };
}

/** Subscriber that fails on the configured attempts and counts every delivery. */
class CountingSubscriber implements EventSubscriber {
  readonly subscriberId: string;
  readonly subscriberType: string;
  readonly retry: RetryConfig;
  readonly eventPattern = '*';
  /** Monotonic-clock timestamp of every delivery attempt, for backoff checks. */
  readonly attemptTimes: number[] = [];
  private readonly _failAttempts: 'all' | number[];
  private _calls = 0;

  constructor(
    subscriberId: string,
    failAttempts: 'all' | number[],
    retry: RetryConfig,
    subscriberType = 'counting',
  ) {
    this.subscriberId = subscriberId;
    this.subscriberType = subscriberType;
    this.retry = retry;
    this._failAttempts = failAttempts;
  }

  get callCount(): number {
    return this._calls;
  }

  async onEvent(_event: ApCoreEvent): Promise<void> {
    this._calls += 1;
    this.attemptTimes.push(performance.now());
    if (this._failAttempts === 'all') {
      throw new Error(`Simulated permanent failure (attempt ${this._calls})`);
    }
    if (this._failAttempts.includes(this._calls)) {
      throw new Error(`Simulated transient failure (attempt ${this._calls})`);
    }
  }
}

/** DLQ recorder — must declare the DLQ pattern; catch-alls are excluded. */
class DlqRecorder implements EventSubscriber {
  readonly subscriberId = 'dlq-conformance-recorder';
  readonly eventPattern = DLQ_EVENT_TYPE;
  readonly received: ApCoreEvent[] = [];

  onEvent(event: ApCoreEvent): void {
    this.received.push(event);
  }
}

describe('Conformance: event_delivery_semantics.json', () => {
  it('retry_succeeds_before_exhaustion', async () => {
    const tc = caseById('retry_succeeds_before_exhaustion');
    const setup = tc['setup']['subscriber'];
    const expected = tc['expected'];

    const emitter = new EventEmitter();
    const dlq = new DlqRecorder();
    emitter.subscribe(dlq);

    const sub = new CountingSubscriber(
      setup['id'],
      setup['fail_attempts'],
      buildRetry(setup['retry']),
      setup['type'],
    );
    emitter.subscribe(sub);

    const trigger = tc['trigger']['event'];
    emitter.emit(createEvent(trigger['name'], null, 'info', trigger['payload'] ?? {}));
    await emitter.flush();

    expect(sub.callCount).toBe(expected['attempt_count']);
    expect(dlq.received.length > 0).toBe(expected['dlq_event_emitted']);

    // Exponential backoff between attempts. Wall clock is the only place the
    // delay is observable, so the bounds are one-sided-tight: a timer never
    // fires early, so `>= declared` is exact, while the upper bound is loose
    // enough to survive a busy CI box. Dropping the backoff entirely collapses
    // both gaps to ~0; making it constant collapses the ratio.
    const declaredDelays = expected['backoff_delays_ms'] as number[];
    const gaps = sub.attemptTimes
      .slice(1)
      .map((t, i) => t - sub.attemptTimes[i]);
    expect(gaps).toHaveLength(declaredDelays.length);
    declaredDelays.forEach((declared, i) => {
      // 1ms of slack: setTimeout resolution is coarser than performance.now().
      expect(gaps[i]).toBeGreaterThanOrEqual(declared - 1);
      expect(gaps[i]).toBeLessThan(declared + 500);
    });
    if (declaredDelays.length > 1) {
      const multiplier = setup['retry']['backoff_multiplier'] as number;
      expect(gaps[1] / gaps[0]).toBeGreaterThan(multiplier * 0.6);
    }
  });

  it('permanent_failure_emits_dlq_event', async () => {
    const tc = caseById('permanent_failure_emits_dlq_event');
    const setup = tc['setup']['subscriber'];
    const expected = tc['expected'];

    const emitter = new EventEmitter();
    const dlq = new DlqRecorder();
    emitter.subscribe(dlq);

    const sub = new CountingSubscriber(
      setup['id'],
      setup['fail_attempts'],
      buildRetry(setup['retry']),
      setup['type'],
    );
    emitter.subscribe(sub);

    const trigger = tc['trigger']['event'];
    emitter.emit(createEvent(trigger['name'], null, 'info', trigger['payload'] ?? {}));
    await emitter.flush();

    expect(sub.callCount).toBe(expected['attempt_count']);
    expect(dlq.received.length > 0).toBe(expected['dlq_event_emitted']);

    const expectedDlq = expected['dlq_event'];
    const evt = dlq.received[0];
    expect(evt.eventType).toBe(expectedDlq['event_type']);
    const dataContains = expectedDlq['data_contains'];
    expect(evt.data['subscriber_type']).toBe(dataContains['subscriber_type']);
    expect(evt.data['subscriber_id']).toBe(dataContains['subscriber_id']);
    expect(evt.data['attempt_count']).toBe(dataContains['attempt_count']);
    expect((evt.data['original_event'] as Record<string, unknown>)['name']).toBe(
      dataContains['original_event']['name'],
    );
    for (const key of expectedDlq['data_required_keys'] as string[]) {
      expect(evt.data).toHaveProperty(key);
    }
  });

  it('dlq_event_subscriber_failure_is_not_retried', async () => {
    const tc = caseById('dlq_event_subscriber_failure_is_not_retried');
    const setup = tc['setup'];
    const expected = tc['expected'];
    const primaryCfg = setup['primary_subscriber'];
    const dlqCfg = setup['dlq_subscriber'];

    const emitter = new EventEmitter();
    const recorder = new DlqRecorder();
    emitter.subscribe(recorder);

    const primary = new CountingSubscriber(
      primaryCfg['id'],
      primaryCfg['fail_attempts'],
      buildRetry(primaryCfg['retry']),
      primaryCfg['type'],
    );
    emitter.subscribe(primary);

    let brokenDlqCalls = 0;
    emitter.subscribe({
      subscriberId: dlqCfg['id'],
      subscriberType: dlqCfg['type'],
      eventPattern: dlqCfg['event_pattern'],
      retry: buildRetry(dlqCfg['retry']),
      onEvent: () => {
        brokenDlqCalls += 1;
        throw new Error('dlq subscriber also broken');
      },
    });

    // "MUST log at ERROR and discard" — the log is the only trace a discarded
    // DLQ delivery leaves, so it is part of the contract, not decoration.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let errorLines: string[] = [];
    try {
      const trigger = tc['trigger']['event'];
      emitter.emit(createEvent(trigger['name'], null, 'info', trigger['payload'] ?? {}));
      await emitter.flush();
      // Snapshot before restoring: mockRestore() also clears the recorded calls.
      errorLines = errorLog.mock.calls.map((c) => c.map((a) => String(a)).join(' '));
    } finally {
      errorLog.mockRestore();
    }

    expect(primary.callCount).toBe(expected['primary_attempt_count']);
    expect(recorder.received.length > 0).toBe(expected['dlq_event_emitted']);
    // The DLQ event is delivered ONCE regardless of the DLQ subscriber's own
    // retry config — otherwise a broken DLQ sink becomes an infinite loop.
    expect(brokenDlqCalls).toBe(expected['dlq_subscriber_attempt_count']);

    const dlqFailureLogs = errorLines.filter((m) => m.includes('DLQ subscriber'));
    expect(dlqFailureLogs).toHaveLength(expected['error_log_count']);

    // …and the failure must not produce a second-order DLQ event.
    const secondOrder = recorder.received.filter(
      (e) => String(e.data['subscriber_id'] ?? '') === dlqCfg['id'],
    );
    expect(secondOrder.length > 0).toBe(expected['second_order_dlq_event_emitted']);
  });

  it('subscriber_id_sdk_generated_when_omitted', async () => {
    const tc = caseById('subscriber_id_sdk_generated_when_omitted');
    const setup = tc['setup'];
    const expected = tc['expected'];
    const trigger = tc['trigger']['event'];

    // The contract is that the generated id is used "consistently across all
    // DLQ events emitted by that subscriber", so the ids have to be read off
    // the DLQ events — reading them off the constructors asserts the id
    // generator and nothing about delivery.
    const emitter = new EventEmitter();
    const recorder = new DlqRecorder();
    emitter.subscribe(recorder);

    const subs = (setup['subscribers'] as Array<Record<string, any>>).map((cfg) => {
      const sub = new StdoutSubscriber();
      // The built-in `stdout` factory drops the config's `retry` block (see the
      // report), so the fixture's policy is attached directly to the instance —
      // which is where EventEmitter reads it from.
      Object.assign(sub, { retry: buildRetry(cfg['retry']) });
      return sub;
    });
    for (const sub of subs) emitter.subscribe(sub);

    // Make the real sink fail, and only for this event: StdoutSubscriber
    // writes through process.stdout, so that write is the failure point.
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any, ...rest: any[]): boolean => {
        if (typeof chunk === 'string' && chunk.includes(trigger['name'])) {
          throw new Error('stdout sink unavailable');
        }
        return (originalWrite as any)(chunk, ...rest);
      });
    try {
      emitter.emit(createEvent(trigger['name'], null, 'info', trigger['payload'] ?? {}));
      await emitter.flush();
    } finally {
      writeSpy.mockRestore();
    }

    expect(recorder.received).toHaveLength(expected['dlq_events_emitted']);
    const reportedIds = recorder.received.map((e) => String(e.data['subscriber_id']));
    if (expected['subscriber_ids_distinct']) {
      expect(new Set(reportedIds).size).toBe(reportedIds.length);
    }
    const pattern = new RegExp(expected['subscriber_ids_pattern']);
    for (const id of reportedIds) expect(id).toMatch(pattern);
    // Same id the subscriber carries — the DLQ event does not mint a new one.
    expect(reportedIds.sort()).toEqual(subs.map((s) => s.subscriberId).sort());
  });
});
