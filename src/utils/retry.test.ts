import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableError, withRetry } from "./retry.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // eliminate jitter for deterministic tests
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("succeeds on first attempt without retry", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("server error", 500))
      .mockResolvedValueOnce("recovered");

    const promise = withRetry(fn, { baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("down", 503));

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    // Attach rejection handler immediately to prevent unhandled rejection
    const caught = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    const err = await caught;
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).message).toBe("down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("bad request", 400));

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry AbortError (timeout)", async () => {
    const err = new Error("timeout");
    err.name = "AbortError";
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow("timeout");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 status", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new RetryableError("rate limited", 429)).mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects retryAfterMs from RetryableError", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("rate limited", 429, 5000))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 100 });

    // At 100ms (normal delay), should not have retried yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // After 5000ms+ (retryAfter), should retry
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries network errors", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses custom isRetryable predicate", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("custom-retry")).mockResolvedValueOnce("ok");

    const promise = withRetry(fn, {
      baseDelayMs: 100,
      isRetryable: (err) => err instanceof Error && err.message === "custom-retry",
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects maxDelayMs cap", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("error", 500))
      .mockRejectedValueOnce(new RetryableError("error", 500))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { baseDelayMs: 10_000, maxDelayMs: 500, maxAttempts: 3 });
    // With maxDelayMs=500, delay should be capped (plus up to 25% jitter = 625ms max)
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
