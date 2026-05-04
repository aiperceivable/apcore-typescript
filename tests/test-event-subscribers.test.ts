/**
 * EventSubscriber implementations — Webhook, A2A, File, Stdout, Filter.
 *
 * Exercises happy paths plus error/retry/timeout/filter branches that the
 * config-driven factory tests don't cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WebhookSubscriber,
  A2ASubscriber,
  FileSubscriber,
  StdoutSubscriber,
  FilterSubscriber,
} from '../src/events/subscribers.js';
import type { ApCoreEvent, EventSubscriber } from '../src/events/emitter.js';

function makeEvent(overrides: Partial<ApCoreEvent> = {}): ApCoreEvent {
  return {
    eventType: 'apcore.test',
    moduleId: 'mod.a',
    timestamp: '2026-01-01T00:00:00Z',
    severity: 'info',
    data: { x: 1 },
    ...overrides,
  };
}

describe('WebhookSubscriber', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the event payload with default and custom headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new WebhookSubscriber('https://example.test/hook', { 'X-Token': 'abc' }, 0, 5000);
    await sub.onEvent(makeEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/hook');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Token']).toBe('abc');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.eventType).toBe('apcore.test');
  });

  it('warns but does not retry on 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new WebhookSubscriber('https://x/y', undefined, 3, 5000);
    await sub.onEvent(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx up to retryCount + 1 attempts then logs failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new WebhookSubscriber('https://x/y', undefined, 2, 5000);
    await sub.onEvent(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries on fetch rejection (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const sub = new WebhookSubscriber('https://x/y', undefined, 1, 5000);
    await sub.onEvent(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses an empty headers map when none are provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new WebhookSubscriber('https://x/y');
    await sub.onEvent(makeEvent());
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('A2ASubscriber', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs with skillId and Bearer auth when auth is a string', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new A2ASubscriber('https://platform/x', 'tok-1', 5000);
    await sub.onEvent(makeEvent());
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['Authorization']).toBe('Bearer tok-1');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.skillId).toBe('apevo.event_receiver');
  });

  it('merges dict auth as header overrides and skips non-string values', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new A2ASubscriber('https://platform/x', { 'X-API-Key': 'k', 'X-Skip': 42 as unknown as string }, 5000);
    await sub.onEvent(makeEvent());
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['X-API-Key']).toBe('k');
    expect(headers['X-Skip']).toBeUndefined();
  });

  it('omits Authorization when no auth is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new A2ASubscriber('https://platform/x');
    await sub.onEvent(makeEvent());
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('warns on >=400 responses without throwing', async () => {
    const warn = vi.spyOn(console, 'warn');
    const fetchMock = vi.fn().mockResolvedValue({ status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    const sub = new A2ASubscriber('https://platform/x');
    await expect(sub.onEvent(makeEvent())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('logs and swallows fetch rejections', async () => {
    const warn = vi.spyOn(console, 'warn');
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);

    const sub = new A2ASubscriber('https://platform/x');
    await expect(sub.onEvent(makeEvent())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('FileSubscriber', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apcore-events-'));
    filePath = path.join(tmpDir, 'events.log');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('appends a JSON line per event by default', async () => {
    const sub = new FileSubscriber(filePath);
    await sub.onEvent(makeEvent({ eventType: 'a' }));
    await sub.onEvent(makeEvent({ eventType: 'b' }));

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.event_type).toBe('a');
  });

  it('writes plain-text format when format=text', async () => {
    const sub = new FileSubscriber(filePath, true, 'text');
    await sub.onEvent(makeEvent({ severity: 'warn' }));
    const contents = fs.readFileSync(filePath, 'utf-8');
    expect(contents).toContain('[WARN]');
    expect(contents).toContain('apcore.test');
  });

  it('overwrites the file when append=false', async () => {
    fs.writeFileSync(filePath, 'preexisting\n', 'utf-8');
    const sub = new FileSubscriber(filePath, false, 'json');
    await sub.onEvent(makeEvent({ eventType: 'fresh' }));
    const contents = fs.readFileSync(filePath, 'utf-8');
    expect(contents).not.toContain('preexisting');
    expect(contents).toContain('fresh');
  });

  it('rotates the file when rotate_bytes threshold is exceeded', async () => {
    fs.writeFileSync(filePath, 'x'.repeat(2000), 'utf-8');
    const sub = new FileSubscriber(filePath, true, 'json', 1000);
    await sub.onEvent(makeEvent());
    expect(fs.existsSync(`${filePath}.1`)).toBe(true);
    // After rotation, the new file holds only the freshly written event.
    const contents = fs.readFileSync(filePath, 'utf-8');
    expect(contents).not.toContain('x'.repeat(20));
  });

  it('does not rotate when the file is below the threshold', async () => {
    const sub = new FileSubscriber(filePath, true, 'json', 1_000_000);
    await sub.onEvent(makeEvent());
    expect(fs.existsSync(`${filePath}.1`)).toBe(false);
  });

  it('skips rotation silently when the file does not yet exist', async () => {
    const sub = new FileSubscriber(filePath, true, 'json', 100);
    await sub.onEvent(makeEvent());
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.1`)).toBe(false);
  });

  it('logs and swallows write errors instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn');
    // Plant a directory at the target path so writeFileSync fails with EISDIR.
    fs.mkdirSync(filePath, { recursive: true });
    const sub = new FileSubscriber(filePath, true, 'json');
    await expect(sub.onEvent(makeEvent())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('StdoutSubscriber', () => {
  // Vitest's narrow MockInstance generic for overloaded fns is unhelpful here;
  // capture writes ourselves and stub stdout.write with a plain function.
  let writes: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    writes = [];
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = originalWrite;
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a text line for each event by default', async () => {
    const sub = new StdoutSubscriber();
    await sub.onEvent(makeEvent({ severity: 'error' }));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[ERROR]');
  });

  it('writes JSON when format=json', async () => {
    const sub = new StdoutSubscriber('json');
    await sub.onEvent(makeEvent());
    const parsed = JSON.parse(writes[0].trim());
    expect(parsed.event_type).toBe('apcore.test');
  });

  it('respects the levelFilter — drops events below the threshold', async () => {
    const sub = new StdoutSubscriber('text', 'warn');
    await sub.onEvent(makeEvent({ severity: 'info' }));
    expect(writes).toHaveLength(0);

    await sub.onEvent(makeEvent({ severity: 'error' }));
    expect(writes).toHaveLength(1);
  });

  it('warns about unknown levelFilter values but still passes events through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sub = new StdoutSubscriber('text', 'bogus');
    await sub.onEvent(makeEvent());
    expect(warn).toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it('treats unknown event severity as level 0', async () => {
    const sub = new StdoutSubscriber('text', 'warn');
    await sub.onEvent(makeEvent({ severity: 'mystery' }));
    expect(writes).toHaveLength(0);
  });
});

describe('FilterSubscriber', () => {
  function recordingDelegate(): { delegate: EventSubscriber; received: ApCoreEvent[] } {
    const received: ApCoreEvent[] = [];
    return {
      received,
      delegate: { onEvent(e) { received.push(e); } },
    };
  }

  it('forwards all events when no include/exclude is set', async () => {
    const { delegate, received } = recordingDelegate();
    const sub = new FilterSubscriber(delegate);
    await sub.onEvent(makeEvent({ eventType: 'a' }));
    await sub.onEvent(makeEvent({ eventType: 'b' }));
    expect(received).toHaveLength(2);
  });

  it('forwards only events matching include patterns (with glob)', async () => {
    const { delegate, received } = recordingDelegate();
    const sub = new FilterSubscriber(delegate, ['apcore.module.*']);
    await sub.onEvent(makeEvent({ eventType: 'apcore.module.registered' }));
    await sub.onEvent(makeEvent({ eventType: 'apcore.config.changed' }));
    expect(received.map(e => e.eventType)).toEqual(['apcore.module.registered']);
  });

  it('drops events matching exclude patterns when no include is set', async () => {
    const { delegate, received } = recordingDelegate();
    const sub = new FilterSubscriber(delegate, undefined, ['debug.*']);
    await sub.onEvent(makeEvent({ eventType: 'debug.x' }));
    await sub.onEvent(makeEvent({ eventType: 'apcore.x' }));
    expect(received.map(e => e.eventType)).toEqual(['apcore.x']);
  });

  it('include takes precedence over exclude when both are provided', async () => {
    const { delegate, received } = recordingDelegate();
    const sub = new FilterSubscriber(delegate, ['apcore.*'], ['apcore.*']);
    await sub.onEvent(makeEvent({ eventType: 'apcore.x' }));
    expect(received.map(e => e.eventType)).toEqual(['apcore.x']);
  });

  it('? glob matches a single character', async () => {
    const { delegate, received } = recordingDelegate();
    const sub = new FilterSubscriber(delegate, ['x?z']);
    await sub.onEvent(makeEvent({ eventType: 'xaz' }));
    await sub.onEvent(makeEvent({ eventType: 'xabz' }));
    expect(received.map(e => e.eventType)).toEqual(['xaz']);
  });
});
