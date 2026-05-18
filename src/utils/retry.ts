import { logger } from "./logger.js";

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
}

const NETWORK_ERROR_PATTERNS = ["econnrefused", "etimedout", "enotfound", "econnreset", "fetch failed", "network"];

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) {
    if (err.status === 429) return true;
    if (err.status && err.status >= 500 && err.status < 600) return true;
    return false;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const msg = err.message.toLowerCase();
    return NETWORK_ERROR_PATTERNS.some((p) => msg.includes(p));
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const maxDelayMs = opts?.maxDelayMs ?? 30_000;
  const isRetryable = opts?.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts - 1) break;
      if (!isRetryable(err)) break;

      let delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      // Respect Retry-After from server — but cap to maxDelayMs
      if (err instanceof RetryableError && err.retryAfterMs) {
        const serverDelay = err.retryAfterMs;
        if (serverDelay > maxDelayMs) {
          logger.warn("retry", "server Retry-After exceeds maxDelayMs — capping", {
            serverDelayMs: serverDelay,
            cappedMs: maxDelayMs,
          });
        }
        delay = Math.max(delay, Math.min(serverDelay, maxDelayMs));
      }
      // Add jitter (0–25%)
      delay += Math.random() * delay * 0.25;

      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
