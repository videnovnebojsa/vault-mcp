import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through calls in closed state", async () => {
    const cb = new CircuitBreaker("test");
    const result = await cb.execute(async () => "ok");
    expect(result).toBe("ok");
    expect(cb.state).toBe("closed");
  });

  it("tracks failures without tripping below threshold", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });

    for (let i = 0; i < 2; i++) {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    }

    expect(cb.failureCount).toBe(2);
    expect(cb.state).toBe("closed");
  });

  it("transitions to open after failureThreshold failures", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    }

    expect(cb.state).toBe("open");
    expect(cb.failureCount).toBe(3);
  });

  it("throws CircuitOpenError when open", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(cb.state).toBe("open");
    await expect(cb.execute(async () => "ok")).rejects.toThrow(CircuitOpenError);
    await expect(cb.execute(async () => "ok")).rejects.toThrow('Circuit "test" is open');
  });

  it("transitions to half-open after resetTimeoutMs", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 5000 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();

    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.state).toBe("half-open");
  });

  it("transitions from half-open to closed on success", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();

    vi.advanceTimersByTime(1000);
    expect(cb.state).toBe("half-open");

    const result = await cb.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("transitions from half-open to open on failure", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();

    vi.advanceTimersByTime(1000);
    expect(cb.state).toBe("half-open");

    await expect(
      cb.execute(async () => {
        throw new Error("still broken");
      }),
    ).rejects.toThrow();
    expect(cb.state).toBe("open");
  });

  it("snapshot returns correct state", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 2 });

    let snap = cb.snapshot();
    expect(snap.state).toBe("closed");
    expect(snap.failureCount).toBe(0);
    expect(snap.lastFailureAt).toBeNull();
    expect(snap.lastSuccessAt).toBeNull();

    await cb.execute(async () => "ok");
    snap = cb.snapshot();
    expect(snap.lastSuccessAt).not.toBeNull();

    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();
    snap = cb.snapshot();
    expect(snap.failureCount).toBe(1);
    expect(snap.lastFailureAt).not.toBeNull();
  });

  it("reset returns to closed with zero failures", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("successful calls reset failure count in closed state", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });

    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();
    expect(cb.failureCount).toBe(1);

    await cb.execute(async () => "ok");

    // Success resets failure count — prevents scattered transient errors from accumulating
    expect(cb.failureCount).toBe(0);
  });
});
