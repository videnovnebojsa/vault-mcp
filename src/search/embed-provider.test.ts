import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCircuits } from "../utils/circuits.js";
import { DeepSeekEmbedProvider, MockEmbedProvider } from "./embed-provider.js";

describe("MockEmbedProvider", () => {
  it("returns vectors of correct dimensions", async () => {
    const provider = new MockEmbedProvider(128);
    const results = await provider.embed(["hello", "world"]);

    expect(results.length).toBe(2);
    expect(results[0].length).toBe(128);
    expect(results[1].length).toBe(128);
  });

  it("returns unit vectors (norm ≈ 1)", async () => {
    const provider = new MockEmbedProvider(64);
    const [vec] = await provider.embed(["test"]);

    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it("returns empty array for empty input", async () => {
    const provider = new MockEmbedProvider();
    const results = await provider.embed([]);
    expect(results.length).toBe(0);
  });

  it("has correct model name and dimensions", () => {
    const provider = new MockEmbedProvider(256);
    expect(provider.modelName).toBe("mock");
    expect(provider.dimensions).toBe(256);
  });
});

describe("DeepSeekEmbedProvider", () => {
  const makeProvider = () =>
    new DeepSeekEmbedProvider("sk-test", "https://api.example.com/v1", "text-embedding-3-small");

  beforeEach(() => {
    resetAllCircuits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAllCircuits();
  });

  it("returns empty array for empty input without calling fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await makeProvider().embed([]);
    expect(result).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when EMBEDDING_ENDPOINT is empty", async () => {
    const provider = new DeepSeekEmbedProvider("sk-test", "", "model");
    await expect(provider.embed(["hello"])).rejects.toThrow("EMBEDDING_ENDPOINT");
  });

  it("returns Float32Array vectors on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          model: "text-embedding-3-small",
        }),
        { status: 200 },
      ),
    );
    const result = await makeProvider().embed(["hello"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0]?.[0]).toBeCloseTo(0.1);
  });

  it("sets dimensions from first response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          model: "text-embedding-3-small",
        }),
        { status: 200 },
      ),
    );
    const provider = makeProvider();
    expect(provider.dimensions).toBe(0);
    await provider.embed(["hello"]);
    expect(provider.dimensions).toBe(3);
  });

  it("throws a RetryableError on non-ok HTTP response", async () => {
    // Use a network-level error (non-retryable) so withRetry exits immediately.
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), { name: "TypeError" }),
    );
    await expect(makeProvider().embed(["test"])).rejects.toThrow(/fetch failed/i);
  });

  it("propagates 400 client errors immediately (non-retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(makeProvider().embed(["test"])).rejects.toThrow(/400/);
  });

  it("rejects immediately when circuit is open (no fetch called)", async () => {
    const { getCircuit } = await import("../utils/circuits.js");
    const circuit = getCircuit("deepseek-embed");

    // Open the circuit by manually recording failures
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: internal test access
      (circuit as any)._failureCount = 5;
      // biome-ignore lint/suspicious/noExplicitAny: internal test access
      (circuit as any)._state = "open";
      // biome-ignore lint/suspicious/noExplicitAny: internal test access
      (circuit as any)._openedAt = Date.now();
    }

    const spy = vi.spyOn(globalThis, "fetch");
    await expect(makeProvider().embed(["hello"])).rejects.toThrow(/Circuit/i);
    expect(spy).not.toHaveBeenCalled();
  });
});
