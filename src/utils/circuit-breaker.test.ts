import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { CircuitBreaker, CircuitOpenError, configureCircuitBreakerAlerts } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    jest.useFakeTimers();
  });

  afterEach(() => {
    configureCircuitBreakerAlerts("");
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
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

  it("sends an alert when the circuit opens", async () => {
    const fetch = mock().mockResolvedValue({ ok: true });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    configureCircuitBreakerAlerts("http://alerts.example.test/hook");
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });

    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(fetch).toHaveBeenCalledWith(
      "http://alerts.example.test/hook",
      expect.objectContaining({
        method: "POST",
      }),
    );
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

  it("reports half-open after resetTimeoutMs without mutating state", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 5000 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();

    expect(cb.state).toBe("open");

    jest.advanceTimersByTime(5000);
    expect(cb.snapshot().state).toBe("half-open");
    expect(cb.state).toBe("open");
  });

  it("transitions from half-open to closed on success", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();

    jest.advanceTimersByTime(1000);
    expect(cb.snapshot().state).toBe("half-open");
    expect(cb.state).toBe("open");

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

    jest.advanceTimersByTime(1000);
    expect(cb.snapshot().state).toBe("half-open");
    expect(cb.state).toBe("open");

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

  it("successful calls do NOT reset failure count in closed state (failures age out naturally)", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3, windowMs: 60_000 });

    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();
    expect(cb.failureCount).toBe(1);

    await cb.execute(async () => "ok");

    // Success in closed state does NOT reset failures — they age out by time window
    expect(cb.failureCount).toBe(1);
  });

  // ── Sliding window tests ───────────────────────────────────────────────────

  it("alternating success/failure trips circuit at failureThreshold (NEW sliding window behavior)", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 5, windowMs: 60_000 });

    // NEW sliding window: successes do NOT reset failure count, so alternating
    // accumulates failures. After 5 failures (at pairs 0-4), circuit opens.
    // Old counter-based behavior would NEVER trip here (success reset count to 0 each time).
    for (let i = 0; i < 10; i++) {
      try {
        await cb.execute(async () => {
          throw new Error("fail");
        });
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          break;
        }
      }
      if (cb.state !== "open") {
        await cb.execute(async () => "ok");
      }
    }

    // With sliding window, circuit DOES trip on 5th failure within window
    expect(cb.state).toBe("open");
  });

  it("5 failures within windowMs trips the circuit", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 5, windowMs: 60_000 });

    for (let i = 0; i < 5; i++) {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    }

    expect(cb.state).toBe("open");
    expect(cb.failureCount).toBe(5);
  });

  it("5 failures spread across > windowMs do NOT trip the circuit", async () => {
    const windowMs = 10_000; // 10s window
    const cb = new CircuitBreaker("test", { failureThreshold: 5, windowMs });

    // Fail 4 times at t=0
    for (let i = 0; i < 4; i++) {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow();
    }
    expect(cb.failureCount).toBe(4);
    expect(cb.state).toBe("closed");

    // Advance past the window — older failures should evict
    jest.advanceTimersByTime(windowMs + 1);

    // 5th failure — but the first 4 are now outside the window
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();

    // Only 1 recent failure remains — circuit should NOT be open
    expect(cb.failureCount).toBe(1);
    expect(cb.state).toBe("closed");
  });

  it("successful probe in half-open closes the circuit", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 1000 });
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();
    expect(cb.state).toBe("open");

    jest.advanceTimersByTime(1000);
    expect(cb.snapshot().state).toBe("half-open");
    expect(cb.state).toBe("open");

    await cb.execute(async () => "ok");
    expect(cb.state).toBe("closed");
  });

  it("recovery from half-open resets the failure window", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3, resetTimeoutMs: 1000, windowMs: 60_000 });

    // Trip the circuit
    for (let i = 0; i < 3; i++) {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow();
    }
    expect(cb.state).toBe("open");

    // Wait for half-open
    jest.advanceTimersByTime(1000);
    expect(cb.snapshot().state).toBe("half-open");
    expect(cb.state).toBe("open");

    // Succeed in half-open — should close and reset failure window
    await cb.execute(async () => "recovered");
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0); // window was reset
  });
});
