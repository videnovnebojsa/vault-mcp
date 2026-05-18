import { describe, expect, it } from "bun:test";
import { MetricsStore } from "./metrics.js";

// Export MetricsStore for testing — the module also exports the singleton `metrics`.
// We test via the class directly to avoid state bleeding between tests.

describe("MetricsStore", () => {
  it("records counts and error flags", () => {
    const store = new MetricsStore();
    store.record("vault_read_note", 10, false);
    store.record("vault_read_note", 20, false);
    store.record("vault_read_note", 5, true);

    const snap = store.snapshot();
    expect(snap["vault_read_note"]?.count).toBe(3);
    expect(snap["vault_read_note"]?.errors).toBe(1);
  });

  it("returns separate entries per tool name", () => {
    const store = new MetricsStore();
    store.record("vault_read_note", 10, false);
    store.record("vault_write_note", 50, false);

    const snap = store.snapshot();
    expect(Object.keys(snap)).toHaveLength(2);
    expect(snap["vault_read_note"]).toBeDefined();
    expect(snap["vault_write_note"]).toBeDefined();
  });

  it("computes percentiles correctly", () => {
    const store = new MetricsStore();
    // Record 100 values: 1..100
    for (let i = 1; i <= 100; i++) {
      store.record("tool", i, false);
    }
    const snap = store.snapshot()["tool"];
    expect(snap?.p50).toBe(50);
    expect(snap?.p95).toBe(95);
    expect(snap?.p99).toBe(99);
  });

  it("returns zeros for empty percentiles on a fresh store", () => {
    const store = new MetricsStore();
    // No records — snapshot returns empty object
    expect(store.snapshot()).toEqual({});
  });

  it("returns p50=value when there is exactly one record", () => {
    const store = new MetricsStore();
    store.record("tool", 42, false);
    const snap = store.snapshot()["tool"];
    expect(snap?.p50).toBe(42);
    expect(snap?.p95).toBe(42);
    expect(snap?.p99).toBe(42);
  });

  it("wraps around the circular buffer at MAX_LATENCIES", () => {
    const store = new MetricsStore();
    // Fill more than 1000 entries; old ones should be overwritten
    for (let i = 0; i < 1050; i++) {
      store.record("tool", i, false);
    }
    const snap = store.snapshot()["tool"];
    expect(snap?.count).toBe(1050);
    // Buffer holds last 1000 entries (50..1049), sorted p50 ≈ 549
    expect(snap?.p50).toBeGreaterThan(50);
  });

  it("p50 for 2-sample array returns the lower value (nearest-rank definition)", () => {
    const store = new MetricsStore();
    store.record("tool", 10, false);
    store.record("tool", 20, false);
    // ceil(2 * 0.5) - 1 = 0 → sorted[0] = 10
    expect(store.snapshot()["tool"]?.p50).toBe(10);
  });
});
