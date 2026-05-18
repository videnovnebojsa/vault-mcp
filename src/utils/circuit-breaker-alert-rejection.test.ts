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

function nextTick(): Promise<"handled"> {
  return new Promise((resolve) => setTimeout(() => resolve("handled"), 0));
}

describe("CircuitBreaker alert failures", () => {
  it("does not produce an unhandled rejection when fire-and-forget alerting fails [ERR-05]", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    const unhandled = new Promise<"unhandled">((resolve) => {
      process.once("unhandledRejection", () => resolve("unhandled"));
    });

    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    const outcome = await Promise.race([unhandled, nextTick()]);
    expect(outcome).toBe("handled");
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
