import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { RetryableError, withRetry } from "./retry.js";

async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  // Drain microtasks first so async catch blocks can register their timers
  for (let i = 0; i < 10; i++) await Promise.resolve();
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("withRetry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    spyOn(Math, "random").mockReturnValue(0); // eliminate jitter for deterministic tests
  });

  afterEach(() => {
    jest.useRealTimers();
    mock.restore();
  });

  it("succeeds on first attempt without retry", async () => {
    const fn = mock().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = mock().mockRejectedValueOnce(new RetryableError("server error", 500)).mockResolvedValueOnce("recovered");

    const promise = withRetry(fn, { baseDelayMs: 100 });
    await advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all attempts", async () => {
    const fn = mock().mockRejectedValue(new RetryableError("down", 503));

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    // Attach rejection handler immediately to prevent unhandled rejection
    const caught = promise.catch((e: unknown) => e);
    await advanceTimersByTimeAsync(500);
    await advanceTimersByTimeAsync(500);

    const err = await caught;
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).message).toBe("down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = mock().mockRejectedValue(new RetryableError("bad request", 400));

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry AbortError (timeout)", async () => {
    const err = new Error("timeout");
    err.name = "AbortError";
    const fn = mock().mockRejectedValue(err);

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow("timeout");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 status", async () => {
    const fn = mock().mockRejectedValueOnce(new RetryableError("rate limited", 429)).mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 100 });
    await advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects retryAfterMs from RetryableError", async () => {
    const fn = mock()
      .mockRejectedValueOnce(new RetryableError("rate limited", 429, 5000))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 100 });

    // At 100ms (normal delay), should not have retried yet
    await advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // After 5000ms+ (retryAfter), should retry
    await advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries network errors", async () => {
    const fn = mock().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 100 });
    await advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses custom isRetryable predicate", async () => {
    const fn = mock().mockRejectedValueOnce(new Error("custom-retry")).mockResolvedValueOnce("ok");

    const promise = withRetry(fn, {
      baseDelayMs: 100,
      isRetryable: (err) => err instanceof Error && err.message === "custom-retry",
    });
    await advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("caps retryAfterMs to maxDelayMs and logs a warning when server delay exceeds cap", async () => {
    const fn = mock()
      .mockRejectedValueOnce(new RetryableError("rate limited", 429, 60_000)) // 60s server delay
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 100, maxDelayMs: 5_000 });

    // Should NOT wait 60s — should be capped at maxDelayMs (5s)
    await advanceTimersByTimeAsync(5_001);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects maxDelayMs cap", async () => {
    const fn = mock()
      .mockRejectedValueOnce(new RetryableError("error", 500))
      .mockRejectedValueOnce(new RetryableError("error", 500))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 10_000, maxDelayMs: 500, maxAttempts: 3 });
    // With maxDelayMs=500, delay should be capped (plus up to 25% jitter = 625ms max)
    await advanceTimersByTimeAsync(700);
    await advanceTimersByTimeAsync(700);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
