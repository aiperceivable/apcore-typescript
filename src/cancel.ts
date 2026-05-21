/**
 * Cancellation support for apcore module execution.
 *
 * Spec D-18 (apcore v0.22.0): `cancel()` MUST be a real interrupt — not
 * merely a cooperative flag. In TypeScript this is realised by backing
 * `CancelToken` with an `AbortController`. The `signal` is exposed so it
 * can be composed (`AbortSignal.any([...])`) with timeout signals inside
 * `BuiltinExecute`, and so user modules performing standard Web-API I/O
 * (`fetch`, `setTimeout`, Web Streams) participate in real abort. The
 * cooperative `check()` and `isCancelled` accessors remain for modules
 * whose pause points are not Web APIs.
 */

import { ModuleError } from './errors.js';

export class ExecutionCancelledError extends ModuleError {
  constructor(message: string = "Execution was cancelled") {
    super("EXECUTION_CANCELLED", message);
    this.name = "ExecutionCancelledError";
  }
}

export class CancelToken {
  private _controller: AbortController = new AbortController();

  /**
   * The underlying `AbortSignal`. Modules using Web APIs (`fetch`,
   * `setTimeout` via `AbortSignal.timeout`, Web Streams) should attach
   * this signal to participate in real abort (D-18).
   */
  get signal(): AbortSignal {
    return this._controller.signal;
  }

  get isCancelled(): boolean {
    return this._controller.signal.aborted;
  }

  cancel(): void {
    if (!this._controller.signal.aborted) {
      this._controller.abort();
    }
  }

  check(): void {
    if (this._controller.signal.aborted) {
      throw new ExecutionCancelledError();
    }
  }

  /**
   * Reset the token by installing a fresh `AbortController`. Listeners
   * attached to the previous `signal` remain bound to the aborted signal
   * — they will not see a fresh non-aborted state. New `signal` reads
   * after `reset()` return the new controller's signal.
   */
  reset(): void {
    this._controller = new AbortController();
  }
}
