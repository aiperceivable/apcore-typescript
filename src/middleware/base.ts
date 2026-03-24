/**
 * Middleware base class for apcore.
 */

import type { Context } from '../context.js';

export class Middleware {
  /**
   * Execution priority (0-1000). Higher priority executes first.
   * When priorities are equal, registration order is used as tiebreaker.
   */
  readonly priority: number;

  constructor(priority: number = 0) {
    this.priority = priority;
  }

  before(
    _moduleId: string,
    _inputs: Record<string, unknown>,
    _context: Context,
  ): Record<string, unknown> | null {
    return null;
  }

  after(
    _moduleId: string,
    _inputs: Record<string, unknown>,
    _output: Record<string, unknown>,
    _context: Context,
  ): Record<string, unknown> | null {
    return null;
  }

  onError(
    _moduleId: string,
    _inputs: Record<string, unknown>,
    _error: Error,
    _context: Context,
  ): Record<string, unknown> | null {
    return null;
  }
}
