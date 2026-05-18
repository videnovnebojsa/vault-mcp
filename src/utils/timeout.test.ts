import { describe, expect, it, jest } from "bun:test";
import { TimeoutError, withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves with the fn value when fn completes within the timeout", async () => {
    const result = await withTimeout(() => Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when fn exceeds the timeout", async () => {
    jest.useFakeTimers();
    const slow = new Promise<never>(() => {});
    const promise = withTimeout(() => slow, 500);
    jest.advanceTimersByTime(500);
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    jest.useRealTimers();
  });

  it("TimeoutError message includes the timeout value", async () => {
    jest.useFakeTimers();
    const slow = new Promise<never>(() => {});
    const promise = withTimeout(() => slow, 300);
    jest.advanceTimersByTime(300);
    await expect(promise).rejects.toThrow("300ms");
    jest.useRealTimers();
  });

  it("propagates fn rejection without timeout interference", async () => {
    const err = new Error("oops");
    await expect(withTimeout(() => Promise.reject(err), 1000)).rejects.toBe(err);
  });

  it("bypasses timeout when ms is 0", async () => {
    const result = await withTimeout(() => Promise.resolve("ok"), 0);
    expect(result).toBe("ok");
  });

  it("clears the timer on successful resolution (no pending callbacks)", async () => {
    jest.useFakeTimers();
    const result = await withTimeout(() => Promise.resolve("done"), 5000);
    expect(result).toBe("done");
    // Advance past the timeout — no rejection should occur
    jest.advanceTimersByTime(5000);
    jest.useRealTimers();
  });

  it("clears the timer and rejects when fn throws synchronously", async () => {
    jest.useFakeTimers();
    const boom = new Error("sync throw");
    const p = withTimeout(() => {
      throw boom;
    }, 500);
    // Advance past the timeout — must NOT produce a second unhandled rejection
    jest.advanceTimersByTime(500);
    await expect(p).rejects.toBe(boom);
    jest.useRealTimers();
  });

  it("rejects with RangeError for negative ms", async () => {
    await expect(withTimeout(() => Promise.resolve(), -1)).rejects.toThrow(RangeError);
  });

  it("RangeError message includes the negative value", async () => {
    await expect(withTimeout(() => Promise.resolve(), -100)).rejects.toThrow("-100");
  });
});
