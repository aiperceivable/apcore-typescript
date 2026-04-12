/**
 * W3C Trace Context support: TraceParent parsing and TraceContext injection/extraction.
 */

import type { Context } from './context.js';
import type { Span } from './observability/tracing.js';
import { randomHex } from './utils/index.js';

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface TraceParent {
  readonly version: string;   // "00"
  readonly traceId: string;   // 32 lowercase hex chars
  readonly parentId: string;  // 16 lowercase hex chars
  readonly traceFlags: string; // "01" (sampled) or "00"
}

export class TraceContext {
  /**
   * Build a traceparent header dict from an apcore Context.
   *
   * Uses `context.traceId` (already 32-hex format) directly in the
   * W3C traceparent header. Uses the last span's `spanId` from the
   * tracing stack if available, otherwise generates a random 16-hex parent id.
   */
  static inject(context: Context): Record<string, string> {
    const traceIdHex = context.traceId; // already 32-hex format

    const spansStack = context.data['_apcore.mw.tracing.spans'] as Span[] | undefined;
    let parentId: string;
    if (spansStack && spansStack.length > 0) {
      parentId = spansStack[spansStack.length - 1].spanId;
    } else {
      parentId = randomHex(8);
    }

    const traceparent = `00-${traceIdHex}-${parentId}-01`;
    return { traceparent };
  }

  /**
   * Parse the `traceparent` header from the given headers object.
   *
   * Returns `null` if the header is missing or malformed.
   */
  static extract(headers: Record<string, string>): TraceParent | null {
    const raw = headers['traceparent'];
    if (raw === undefined) {
      return null;
    }
    const match = TRACEPARENT_RE.exec(raw.trim().toLowerCase());
    if (match === null) {
      return null;
    }
    const version = match[1];
    const traceId = match[2];
    const parentId = match[3];
    if (version === 'ff') {
      return null;
    }
    if (traceId === '0'.repeat(32) || parentId === '0'.repeat(16)) {
      return null;
    }
    return Object.freeze({
      version,
      traceId,
      parentId,
      traceFlags: match[4],
    });
  }

  /**
   * Strictly parse a traceparent string, throwing on invalid format.
   *
   * @throws {Error} If the traceparent does not match the expected
   *   `00-<32 hex>-<16 hex>-<2 hex>` format.
   */
  static fromTraceparent(traceparent: string): TraceParent {
    const match = TRACEPARENT_RE.exec(traceparent.trim().toLowerCase());
    if (match === null) {
      throw new Error(
        `Malformed traceparent: ${JSON.stringify(traceparent.slice(0, 100))}. Expected format: 00-<32 hex>-<16 hex>-<2 hex>`,
      );
    }
    const version = match[1];
    const traceId = match[2];
    const parentId = match[3];
    if (version === 'ff') {
      throw new Error('Invalid traceparent: version ff is not allowed');
    }
    if (traceId === '0'.repeat(32) || parentId === '0'.repeat(16)) {
      throw new Error('Invalid traceparent: all-zero trace_id or parent_id');
    }
    return Object.freeze({
      version,
      traceId,
      parentId,
      traceFlags: match[4],
    });
  }
}
