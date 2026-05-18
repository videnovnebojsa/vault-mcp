import { VaultError, VaultErrorCode } from "./errors.js";

/**
 * Runs `fn` and rejects with a descriptive TimeoutError if it does not settle within `ms`.
 * Pass `ms = 0` to disable the timeout entirely.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  if (ms < 0) throw new RangeError(`withTimeout: ms must be >= 0, got ${ms}`);
  if (ms === 0) return fn();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${ms}ms`));
    }, ms);

    let p: Promise<T>;
    try {
      p = fn();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class TimeoutError extends VaultError {
  constructor(message: string) {
    super(message, VaultErrorCode.TIMEOUT);
    this.name = "TimeoutError";
  }
}
