import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CircuitBreaker, configureCircuitBreakerAlerts } from "./circuit-breaker.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async () => {
    throw new Error("alert failed");
  });
  configureCircuitBreakerAlerts("http://alerts.example.test/hook");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureCircuitBreakerAlerts("");
});

describe("CircuitBreaker alert failures", () => {
  it("does not produce an unhandled rejection when fire-and-forget alerting fails [ERR-05]", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    let unhandledReason: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandledReason = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");

      // Turn the event loop once so any mishandled fire-and-forget alert rejection surfaces.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandledReason).toBeNull();
      expect(globalThis.fetch).toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
